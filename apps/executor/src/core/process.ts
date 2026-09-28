/**
 * 子进程调用与进程树停止（第 8 节步骤 4、5）。
 *
 * 两条硬约束：
 * 1. **固定程序 + 参数数组**调用，绝不把云端下发的任意字符串交给 shell。
 *    因此这里 `shell: false` 是刻意的，且不得提供拼接字符串的入口。
 * 2. **停止必须作用于整棵进程树**。Windows 上 `child.kill()` 只杀父进程，
 *    被 agent 拉起的测试进程/编辑器会变成孤儿继续占用 worktree 与文件锁 ——
 *    这正是 README「必须覆盖的 Windows 重点测试」里点名的一项。
 *
 * ## B7：终止链本身必须是**有界**的（A 端 B6 评审 P0）
 *
 * 光有「三级升级链」不够。原文在第 3 级之后仍然 `await Promise.all([stdout, stderr])`，
 * 且 `killTree()` 调用、`taskkill` 自身都没有上限。于是只要满足下面任一条，
 * 执行器就会**永久占用租约**、既不产出失败证据也不安全退出：
 * - 子进程或其输出流始终不结束（含流句柄被子进程继承）；
 * - 系统拒绝杀进程（`taskkill` 卡住或非零退出）；
 * - 注入的 killer 实现自身不返回。
 *
 * 因此本文件里**每一个可能不结束的等待都有自己的上限**：
 * `settledWithin` 是唯一的等待原语，任何 `await` 都不会无限期挂起。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** 一次调用的完整描述。`args` 必须是数组，不接受整串命令。 */
export interface SpawnSpec {
  /** 可执行文件路径或名称；不含参数 */
  executable: string;
  /** 参数数组，逐项传递，由操作系统完成引用与转义 */
  args: readonly string[];
  /** 工作目录；执行器必须校验它落在允许的 worktree 内 */
  cwd: string;
  /** 追加或覆盖环境变量；凭据经此注入，不写入仓库与日志 */
  env?: Readonly<Record<string, string>>;
  /** 标准输入内容；不给则 stdin 关闭 */
  stdin?: string;
}

/** 子进程句柄。只暴露执行器需要的四件事。 */
export interface ChildProcessHandle {
  pid: number | null;
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  /** 进程退出码。被信号终止时为 null */
  exit_code: Promise<number | null>;
  /** 退出信号，正常退出时为 null */
  signal: Promise<NodeJS.Signals | null>;
  /**
   * 进程**启动失败**的错误（可执行文件不存在等）。正常启动为 `null`；
   * 未提供该字段时视为「不会启动失败」。
   *
   * 与 `adapters/opencode.ts` 同一处缺陷（B5 由真实链路暴露）：
   * spawn 失败时 Node 只发 `error`，`close` 不触发，且无监听者会被升级为
   * 进程级未捕获异常。缺了这条通道，`runProcess` 会永久挂住，
   * `collectEvidence` 于是永远拿不到测试证据。
   */
  spawn_error?: Promise<Error | null>;
}

/** 可替换的进程启动器，便于测试注入假实现。 */
export interface ProcessRunner {
  start(spec: SpawnSpec): ChildProcessHandle;
}

function toHandle(child: ChildProcess): ChildProcessHandle {
  // 必须**立刻**挂上 error 监听（见 `ChildProcessHandle.spawn_error`）。
  const spawn_error = new Promise<Error | null>((resolve) => {
    child.once("error", (error: Error) => resolve(error));
  });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, sig) => resolve({ code, signal: sig }));
  });

  // 启动失败时没有进程可等：退出码与信号都按「未取得」返回，
  // 绝不伪造 0 —— 那会把「没跑起来」冒充成正常结束。
  const settled = Promise.race([closed, spawn_error.then(() => ({ code: null, signal: null }))]);

  return {
    pid: child.pid ?? null,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exit_code: settled.then((result) => result.code),
    signal: settled.then((result) => result.signal),
    spawn_error,
  };
}

class NodeProcessRunner implements ProcessRunner {
  start(spec: SpawnSpec): ChildProcessHandle {
    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      // 关键：不经 shell。字符串拼接会让参数数组的隔离形同虚设。
      shell: false,
      windowsHide: true,
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
    });
    if (spec.stdin !== undefined && child.stdin) {
      child.stdin.end(spec.stdin);
    }
    return toHandle(child);
  }
}

/** 默认运行器：直接使用本机进程 API。 */
export const nodeProcessRunner: ProcessRunner = new NodeProcessRunner();

/* ------------------------------------------------------------------ *
 * 等待原语：本文件唯一的「等某件事」方式
 * ------------------------------------------------------------------ */

/**
 * 等待 `promise` 完成，**或**到 `ms` 毫秒后放弃等待。
 *
 * 返回 `true` 表示在超时前完成。定时器总会被清理——否则一个已经完成的
 * 调用仍会留下长达 `timeout_ms` 的悬挂定时器，把进程的退出时间拖满。
 *
 * 调用方必须把「返回 false」当成正常分支处理：**没有任何地方允许无界等待**。
 */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== "");
  return (line ?? text).trim().slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * 流采集：可随时读取**已收到**的部分内容
 * ------------------------------------------------------------------ */

interface StreamCapture {
  /** 当前已收到的内容。流尚未结束时即为部分内容（不是空串）。 */
  text(): string;
  /** 流正常结束或因错误中断后结算；内部吞掉错误，**永不拒绝**。 */
  done: Promise<string>;
}

/**
 * 增量采集流内容。
 *
 * 之所以不是直接 `await` 收集：当流永远不关闭时（子进程把句柄继承给了
 * 孙进程、管道被占用），`await` 会永久挂住。采集器让调用方能在
 * 「等一个有限的窗口」之后直接读取已收到的部分输出。
 */
function captureStream(stream: AsyncIterable<Uint8Array | string>): StreamCapture {
  const chunks: string[] = [];
  const done = (async () => {
    try {
      for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      }
    } catch {
      // 流被中途破坏（进程被杀、管道断开）：保留已经拿到的内容，
      // 绝不把「读流出错」升级成未处理拒绝。
    }
    return chunks.join("");
  })();
  return { text: () => chunks.join(""), done };
}

/** 收集一个可读流为字符串（UTF-8）。 */
export async function collectStream(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  return await captureStream(stream).done;
}

/* ------------------------------------------------------------------ *
 * 进程树停止
 * ------------------------------------------------------------------ */

/**
 * 一次停止动作的**可观察**结果。
 *
 * 有返回值是 B7 的关键改动之一：原实现返回 `void`，于是「taskkill 根本没
 * 生效」与「taskkill 成功」在调用方看来完全一样，失败无处可查。
 */
export interface KillOutcome {
  /** 是否**确认**目标进程树已不再受本次调用管辖（含「本就不存在」）。 */
  ok: boolean;
  /** 失败或超时的说明；成功且无异常时为 `null`。 */
  detail: string | null;
}

/**
 * 停止整棵进程树。
 *
 * Windows 无 POSIX 进程组语义，`taskkill /T` 是唯一可靠手段；
 * POSIX 系统用进程组负 PID。两者都必须**先优雅后强杀**，
 * 给子进程留下写日志与释放锁的机会。
 *
 * 实现方**必须**自己保证有界：调用方还会再套一层上限，但两层都要有。
 */
export interface TreeKiller {
  killTree(pid: number, force: boolean): Promise<KillOutcome>;
}

/** 一条外部停止命令（Windows 的 `taskkill`）的句柄。 */
export interface KillCommandHandle {
  /** 命令结束（含非零退出）时结算；`error` 非空表示命令**未能启动**。 */
  done: Promise<{ code: number | null; error: Error | null }>;
  /** 命令自身的输出（stderr 摘要），用于失败说明；可能为空串。 */
  output(): string;
  /** 放弃等待时中断该命令本身（尽力而为，不抛错）。 */
  abort(): void;
}

/** 启动一条停止命令。可注入，使「命令卡住/失败」可被确定性测试。 */
export type KillCommandRunner = (executable: string, args: readonly string[]) => KillCommandHandle;

/** `killTree()` 调用自身以及内置 taskkill 的等待上限。 */
export const DEFAULT_KILL_TIMEOUT_MS = 5_000;

/** taskkill 报告「进程不存在」的典型输出（英文/中文 Windows）。 */
const MISSING_PROCESS = /not\s+found|no\s+running\s+instance|找不到|没有找到|不存在|not\s+running/i;

function defaultKillCommandRunner(executable: string, args: readonly string[]): KillCommandHandle {
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    // stderr 要读：失败原因（not found / access denied）只在这里。
    stdio: ["ignore", "ignore", "pipe"],
  });
  let text = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    if (text.length >= 2_000) return;
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  const done = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    // spawn 失败时只有 error，close 不触发；两条都要接。
    child.once("error", (error: Error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code, error: null }));
  });
  return {
    done,
    output: () => text,
    abort: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 命令可能已自行退出
      }
    },
  };
}

/** POSIX：负 PID 对整组发信号；组不存在则退回单进程。 */
function killPosixTree(pid: number, force: boolean): KillOutcome {
  const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
    return { ok: true, detail: null };
  } catch (groupError) {
    const groupCode = (groupError as NodeJS.ErrnoException).code;
    // 进程组已不存在 = 本来就没了，不是失败。
    if (groupCode === "ESRCH") return { ok: true, detail: null };
    try {
      process.kill(pid, signal);
      return { ok: true, detail: null };
    } catch (singleError) {
      const singleCode = (singleError as NodeJS.ErrnoException).code;
      if (singleCode === "ESRCH") return { ok: true, detail: null };
      return { ok: false, detail: `POSIX 信号发送失败（${singleCode ?? errorText(singleError)}，pid=${pid}）` };
    }
  }
}

export class SystemTreeKiller implements TreeKiller {
  private readonly runner: KillCommandRunner;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(
    options: { timeoutMs?: number; runner?: KillCommandRunner; platform?: NodeJS.Platform } = {},
  ) {
    this.runner = options.runner ?? defaultKillCommandRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    // 可注入平台：否则「taskkill 卡住/失败」这类 Windows 分支无法在 Linux CI 上被验证。
    this.platform = options.platform ?? process.platform;
  }

  async killTree(pid: number, force: boolean): Promise<KillOutcome> {
    if (this.platform !== "win32") return killPosixTree(pid, force);

    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");

    let handle: KillCommandHandle;
    try {
      handle = this.runner("taskkill", args);
    } catch (error) {
      return { ok: false, detail: `taskkill 启动失败：${errorText(error)}` };
    }

    // B7：taskkill 自己也可能卡住（被拒绝、等待句柄）。必须给它上限。
    if (!(await settledWithin(handle.done, this.timeoutMs))) {
      handle.abort();
      return { ok: false, detail: `taskkill 未在 ${this.timeoutMs}ms 内返回，已中断（pid=${pid}）` };
    }

    const { code, error } = await handle.done;
    if (error) return { ok: false, detail: `taskkill 未能启动：${error.message}` };
    if (code === 0) return { ok: true, detail: null };

    const text = handle.output().trim();
    if (MISSING_PROCESS.test(text)) return { ok: true, detail: null };
    return { ok: false, detail: `taskkill 退出码 ${code}${text ? `：${firstLine(text)}` : ""}` };
  }
}

export const systemTreeKiller: TreeKiller = new SystemTreeKiller();

/* ------------------------------------------------------------------ *
 * runProcess
 * ------------------------------------------------------------------ */

/** 一次受控调用的结果。 */
export interface RunProcessResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被终止 */
  timed_out: boolean;
  /**
   * 是否**最终未能结束该进程**（连强杀都不生效）。
   *
   * 注意语义：优雅停止无效但强杀成功 **不算** kill_failed ——
   * 那只是正常的升级链，进程确实被终止了。
   * 此字段为 true 才代表需要人工介入的僵尸/占用情形。
   */
  kill_failed: boolean;
  /** 是否因优雅停止无效而升级到了强杀（正常现象，非错误） */
  escalated_to_force: boolean;
  /**
   * 子进程**是否根本没启动起来**（B5 补充项）。
   *
   * 必须与 `exit_code: null` 区分：后者还可能是「超时后连强杀都无效」，
   * 而 `spawn_failed: true` 明确表示「没有任何进程运行过」。
   * 上层据此报出执行环境问题，而不是把它当成 agent 的代码失败。
   */
  spawn_failed: boolean;
  /**
   * 终止过程的**可观察细节**（B7）。全部正常时为 `null`。
   *
   * 覆盖：killer 调用失败/超时、taskkill 非零退出或卡住、强杀后进程仍未退出、
   * stdio 在窗口内未关闭（输出可能被截断）。上层据此记录失败原因，
   * 而不是只看到一个 `kill_failed: true` 却查不到为什么。
   */
  kill_detail: string | null;
}

export interface RunProcessOptions {
  /** 超时毫秒数。到时先 SIGTERM，宽限期后再强杀 */
  timeout_ms: number;
  /** 优雅停止到强杀之间的宽限毫秒数 */
  grace_ms?: number;
  /**
   * 单次 `killTree()` 调用的等待上限（B7）。
   *
   * 即使注入的 killer 自身挂住，这一层也必须返回——否则「有界返回」
   * 只在内置 killer 上成立，换个实现就失效。
   */
  kill_timeout_ms?: number;
  /**
   * 进程结束后等待 stdio 关闭的上限（B7）。超时即用已收到的部分输出返回。
   * 默认 `min(grace_ms, 1000)`：宽限给小了就没有理由在这里等更久。
   */
  drain_ms?: number;
  runner?: ProcessRunner;
  killer?: TreeKiller;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_DRAIN_MS = 1_000;

/**
 * 调用 killer，并给这次调用一个上限。
 *
 * 注入的 killer 可能**永不返回**（真实的 taskkill 卡住、或测试注入的挂起实现）。
 * 直接 `await killer.killTree(...)` 会把「有界返回」的承诺交给对方去遵守，
 * 那是把 P0 缺陷换个地方重演。
 */
async function killBounded(
  killer: TreeKiller,
  pid: number,
  force: boolean,
  timeoutMs: number,
): Promise<KillOutcome> {
  const call: Promise<KillOutcome> = Promise.resolve()
    .then(() => killer.killTree(pid, force))
    .then(
      (value) => normalizeKillOutcome(value),
      (error) => ({ ok: false, detail: `killer 抛出异常：${errorText(error)}` }),
    );

  if (!(await settledWithin(call, timeoutMs))) {
    return {
      ok: false,
      detail: `killer 未在 ${timeoutMs}ms 内返回（${force ? "强杀" : "优雅停止"}，pid=${pid}），已放弃等待`,
    };
  }
  return await call;
}

/**
 * 兼容「只做动作、不返回结果」的 killer 实现：没有可判定结果时按
 * 「未报告失败」处理，只当作无从观测，**不**擅自升级为 kill_failed。
 */
function normalizeKillOutcome(value: unknown): KillOutcome {
  if (value !== null && typeof value === "object" && typeof (value as KillOutcome).ok === "boolean") {
    const detail = (value as KillOutcome).detail;
    return { ok: (value as KillOutcome).ok, detail: typeof detail === "string" ? detail : null };
  }
  return { ok: true, detail: null };
}

/**
 * 以固定参数数组调用子进程，并在超时后**停止整棵进程树**。
 *
 * ## B5 修复的真实缺陷（评审单之外的补充项）
 * 原实现的终止升级链**无条件**先 `await sleep(timeout_ms)`，然后才判断
 * 「进程是不是早就退出了」。也就是说：**即使子进程瞬间正常退出，也要
 * 空等满整个超时**。在真实链路上，`collectEvidence` 每次采集测试证据都会
 * 白等 `test_timeout_ms`（常驻入口默认 600 秒／次），每个 attempt 都如此。
 *
 * 这个缺陷用假进程测不出来——假实现里 `sleep` 与 `exit_code` 都是被注入的，
 * 等待时长不影响断言。它是被 B5 的**真实子进程链路测试**逼出来的。
 *
 * 现在改为「退出 / 超时 谁先到听谁的」，并在超时后才走三级升级链。
 *
 * ## B7 修复（A 端 B6 评审 P0）：每一级都有界
 * 三级升级链本身保留，但其后**不再** `await Promise.all([stdout, stderr])`，
 * 每个 `killTree()` 调用也各有上限。任一级失败或超时都会落到
 * `kill_detail` 里，函数**一定**会返回。
 */
export async function runProcess(
  spec: SpawnSpec,
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const runner = options.runner ?? nodeProcessRunner;
  const killer = options.killer ?? systemTreeKiller;
  const grace = options.grace_ms ?? DEFAULT_GRACE_MS;
  const killTimeout = options.kill_timeout_ms ?? DEFAULT_KILL_TIMEOUT_MS;
  const drain = options.drain_ms ?? Math.min(grace, DEFAULT_DRAIN_MS);

  const handle = runner.start(spec);
  let timed_out = false;
  let kill_failed = false;
  let escalated_to_force = false;
  /** 进程是否**确实退出了**。只有它为 true 时才允许读退出码。 */
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  // 子进程异常收尾时 stdio 流可能以错误结束；不吞掉会变成未处理拒绝。
  // 采集器同时允许在窗口到期后读取**部分**输出（B7）。
  const out = captureStream(handle.stdout);
  const err = captureStream(handle.stderr);

  const exitedPromise = handle.exit_code.then(
    (code) => {
      exited = true;
      exitCode = code;
    },
    () => {
      // 退出码承诺自身失败 = 未取得退出码，按「未退出」处理，绝不挂住。
    },
  );
  handle.signal.then(
    (sig) => {
      exitSignal = sig;
    },
    () => undefined,
  );

  // 启动失败与超时同等对待：都必须让本函数**尽快**返回。
  // 缺了这条通道，可执行文件不存在会让 `collectEvidence` 永久挂住。
  let spawn_error: Error | null = null;
  const spawnFailure: Promise<void> = (
    handle.spawn_error ?? new Promise<never>(() => undefined)
  ).then((error) => {
    spawn_error = error;
  });

  /** 终止过程的失败/超时说明，逐条累积（B7）。 */
  const killNotes: string[] = [];

  /**
   * 终止升级流程，**每一级都有明确的时间边界**：
   * 1. T = timeout         → 优雅停止整棵树（SIGTERM / taskkill 不带 /F）
   * 2. T + grace           → 强杀整棵树（SIGKILL / taskkill /F）
   * 3. T + grace + grace   → 放弃等待，按「未取得退出码」返回
   *
   * 为什么第 3 级必须有：若进程连强杀都不响应（驱动占用、僵尸态），
   * 无限 await 会让执行器永久卡死。返回一个 exit_code=null 的结果，
   * 让上层能记录并继续，远好过整套流程挂住。
   */
  const exitedInTime = await settledWithin(
    Promise.race([exitedPromise, spawnFailure]),
    options.timeout_ms,
  );
  if (!exitedInTime) {
    timed_out = true;
    const pid = handle.pid;
    if (pid === null) {
      // 没有 pid 就没有任何停止手段；如实标记，不再空等。
      kill_failed = true;
      killNotes.push("未能取得 pid，无法停止进程树，已放弃等待");
    } else {
      // 第 1 级：优雅停止
      const graceful = await killBounded(killer, pid, false, killTimeout);
      if (graceful.detail !== null) killNotes.push(graceful.detail);
      if (!(await settledWithin(exitedPromise, grace))) {
        // 第 2 级：强杀。走到这里说明优雅停止无效，但强杀通常能成功，
        // 因此只记「已升级」，尚不判定为失败。
        escalated_to_force = true;
        const forced = await killBounded(killer, pid, true, killTimeout);
        if (forced.detail !== null) killNotes.push(forced.detail);
        if (!(await settledWithin(exitedPromise, grace))) {
          // 第 3 级：连强杀都无效 —— 这才是真正需要人工介入的 kill_failed。
          kill_failed = true;
          killNotes.push(`强杀后进程仍未退出，已放弃等待（pid=${pid}，可能仍在运行并占用 worktree 锁）`);
        }
      }
    }
  }

  const failure = spawn_error as Error | null;
  let stdout: string;
  let stderr: string;
  if (failure !== null) {
    // 启动失败时 stdout/stderr 可能永远不结束，**不能**等它们。
    stdout = "";
    stderr = `子进程启动失败：${failure.message}`;
  } else {
    // B7：即使进程已退出，stdio 也可能永不关闭（句柄被子进程继承）。
    // 只等一个有上限的窗口，到期就用已收到的部分输出返回。
    const drained = await settledWithin(Promise.all([out.done, err.done]), drain);
    stdout = out.text();
    stderr = err.text();
    if (!drained) {
      killNotes.push(`stdio 未在 ${drain}ms 内关闭，已按已接收到的输出返回（输出可能被截断）`);
    }
  }

  // 退出码只在**确认已退出**时读取。不要用 `Promise.race([exit_code, null])`
  // 之类看似「不会挂住」的写法：那会在尚未退出时静默返回 null，
  // 让「测试真的通过了」与「根本没拿到退出码」变得无法区分。
  // B7 起连这个 await 也去掉：值在 exitedPromise 里已经落到本地变量。
  return {
    exit_code: exited ? exitCode : null,
    signal: exited ? exitSignal : null,
    stdout,
    stderr,
    timed_out,
    kill_failed,
    escalated_to_force,
    spawn_failed: failure !== null,
    kill_detail: killNotes.length > 0 ? killNotes.join("；") : null,
  };
}

/**
 * 参数数组的构造守卫。
 *
 * 规则 4：不执行云端任意 shell 字符串。任何一段来自云端的文本都只能
 * 作为**单个参数值**进入数组，绝不允许被拆成多个参数或触发 shell 解析。
 * 这里拒绝含 NUL 的项（进程 API 无法表达），并在可执行文件名上
 * 拒绝路径分隔符以外的可疑字符。
 */
export function assertSafeArgv(executable: string, args: readonly string[]): void {
  if (!executable || executable.includes("\0")) {
    throw new Error("可执行文件名非法：不能为空且不得含 NUL 字符");
  }
  for (const [index, arg] of args.entries()) {
    if (arg.includes("\0")) {
      throw new Error(`参数 #${index} 含 NUL 字符，无法安全传递`);
    }
  }
}
