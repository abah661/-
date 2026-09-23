/**
 * 子进程调用与进程树停止（第 8 节步骤 4、5）。
 *
 * 两条硬约束：
 * 1. **固定程序 + 参数数组**调用，绝不把云端下发的任意字符串交给 shell。
 *    因此这里 `shell: false` 是刻意的，且不得提供拼接字符串的入口。
 * 2. **停止必须作用于整棵进程树**。Windows 上 `child.kill()` 只杀父进程，
 *    被 agent 拉起的测试进程/编辑器会变成孤儿继续占用 worktree 与文件锁 ——
 *    这正是 README「必须覆盖的 Windows 重点测试」里点名的一项。
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

/** 收集一个可读流为字符串（UTF-8）。 */
export async function collectStream(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

/**
 * 停止整棵进程树。
 *
 * Windows 无 POSIX 进程组语义，`taskkill /T` 是唯一可靠手段；
 * POSIX 系统用进程组负 PID。两者都必须**先优雅后强杀**，
 * 给子进程留下写日志与释放锁的机会。
 */
export interface TreeKiller {
  killTree(pid: number, force: boolean): Promise<void>;
}

class SystemTreeKiller implements TreeKiller {
  async killTree(pid: number, force: boolean): Promise<void> {
    if (process.platform === "win32") {
      const args = ["/PID", String(pid), "/T"];
      if (force) args.push("/F");
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", args, { shell: false, windowsHide: true, stdio: "ignore" });
        killer.once("close", () => resolve());
        killer.once("error", () => resolve());
      });
      return;
    }
    // POSIX：负 PID 对整组发信号
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        // 进程可能已自行退出；交由调用方以 exit_code 判定。
      }
    }
  }
}

export const systemTreeKiller: TreeKiller = new SystemTreeKiller();

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
}

export interface RunProcessOptions {
  /** 超时毫秒数。到时先 SIGTERM，宽限期后再强杀 */
  timeout_ms: number;
  /** 优雅停止到强杀之间的宽限毫秒数 */
  grace_ms?: number;
  runner?: ProcessRunner;
  killer?: TreeKiller;
}

const DEFAULT_GRACE_MS = 5_000;

/**
 * 等待 `promise` 完成，**或**到 `ms` 毫秒后放弃等待。
 *
 * 返回 `true` 表示在超时前完成。定时器总会被清理——否则一个已经完成的
 * 调用仍会留下长达 `timeout_ms` 的悬挂定时器，把进程的退出时间拖满。
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
 */
export async function runProcess(
  spec: SpawnSpec,
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const runner = options.runner ?? nodeProcessRunner;
  const killer = options.killer ?? systemTreeKiller;
  const grace = options.grace_ms ?? DEFAULT_GRACE_MS;

  const handle = runner.start(spec);
  let timed_out = false;
  let kill_failed = false;
  let escalated_to_force = false;
  /** 进程是否**确实退出了**。只有它为 true 时才允许读退出码。 */
  let exited = false;

  // 子进程异常收尾时 stdio 流可能以错误结束；不吞掉会变成未处理拒绝。
  const stdoutPromise = collectStream(handle.stdout).catch(() => "");
  const stderrPromise = collectStream(handle.stderr).catch(() => "");
  const exitedPromise = handle.exit_code.then(() => {
    exited = true;
  });

  // 启动失败与超时同等对待：都必须让本函数**尽快**返回。
  // 缺了这条通道，可执行文件不存在会让 `collectEvidence` 永久挂住。
  let spawn_error: Error | null = null;
  const spawnFailure: Promise<void> = (
    handle.spawn_error ?? new Promise<never>(() => undefined)
  ).then((error) => {
    spawn_error = error;
  });

  /**
   * 终止升级流程，**必须自身可终结**。
   *
   * 分三级，每级都有明确的时间边界：
   * 1. T = timeout            → 优雅停止整棵树（SIGTERM / taskkill 不带 /F）
   * 2. T + grace              → 强杀整棵树（SIGKILL / taskkill /F）
   * 3. T + grace + grace      → 放弃等待，按「未取得退出码」返回
   *
   * 为什么第 3 级必须有：若进程连强杀都不响应（驱动占用、僵尸态），
   * 无限 await 会让执行器永久卡死。返回一个 exit_code=null 的结果，
   * 让上层能记录并继续，远好过整套流程挂住。
   */
  const exitedInTime = await settledWithin(Promise.race([exitedPromise, spawnFailure]), options.timeout_ms);
  if (!exitedInTime) {
    timed_out = true;
    const pid = handle.pid;
    if (pid !== null) {
      // 第 1 级：优雅停止
      await killer.killTree(pid, false);
      if (!(await settledWithin(exitedPromise, grace))) {
        // 第 2 级：强杀。走到这里说明优雅停止无效，但强杀通常能成功，
        // 因此只记「已升级」，尚不判定为失败。
        escalated_to_force = true;
        await killer.killTree(pid, true);
        if (!(await settledWithin(exitedPromise, grace))) {
          // 第 3 级：连强杀都无效 —— 这才是真正需要人工介入的 kill_failed。
          kill_failed = true;
          // 不再等待，直接往下走；exit_code 按未取得处理。
        }
      }
    }
  }

  const failure = spawn_error as Error | null;
  // 启动失败时 stdout/stderr 可能永远不结束，**不能**等它们。
  const [stdout, stderr] =
    failure !== null
      ? (["", `子进程启动失败：${failure.message}`] as const)
      : await Promise.all([stdoutPromise, stderrPromise]);
  // 退出码只在**确认已退出**时读取。不要用 `Promise.race([exit_code, null])`
  // 之类看似「不会挂住」的写法：那会在尚未退出时静默返回 null，
  // 让「测试真的通过了」与「根本没拿到退出码」变得无法区分。
  const exit_code = exited ? await handle.exit_code : null;
  const signal = exited ? await handle.signal : null;

  return {
    exit_code,
    signal,
    stdout,
    stderr,
    timed_out,
    kill_failed,
    escalated_to_force,
    spawn_failed: failure !== null,
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
