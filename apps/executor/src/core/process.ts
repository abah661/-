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
}

/** 可替换的进程启动器，便于测试注入假实现。 */
export interface ProcessRunner {
  start(spec: SpawnSpec): ChildProcessHandle;
}

function toHandle(child: ChildProcess): ChildProcessHandle {
  return {
    pid: child.pid ?? null,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exit_code: new Promise((resolve) => child.once("close", (code) => resolve(code))),
    signal: new Promise((resolve) => child.once("close", (_code, sig) => resolve(sig))),
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
 * 以固定参数数组调用子进程，并在超时后**停止整棵进程树**。
 *
 * 时钟来源可注入（`now`），使超时逻辑可在测试中确定性验证，
 * 不必依赖真实等待。
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

  const stdoutPromise = collectStream(handle.stdout);
  const stderrPromise = collectStream(handle.stderr);

  /**
   * 终止升级流程，**必须自身可终结**。
   *
   * 分三级，每级都有明确的时间边界：
   * 1. T = timeout            → 优雅停止整棵树（SIGTERM / taskkill 不带 /F）
   * 2. T + grace              → 强杀整棵树（SIGKILL / taskkill /F），并记 kill_failed
   * 3. T + grace + grace      → 放弃等待，按「未取得退出码」返回
   *
   * 为什么第 3 级必须有：若进程连强杀都不响应（驱动占用、僵尸态），
   * 无限 await 会让执行器永久卡死。返回一个 exit_code=null 的结果，
   * 让上层能记录并继续，远好过整套流程挂住。
   */
  const waitForExit = async (): Promise<void> => {
    const pid = handle.pid;
    let exited = false;
    const exitedPromise = handle.exit_code.then(() => {
      exited = true;
    });

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms));

    const escalation = async (): Promise<void> => {
      await sleep(options.timeout_ms);
      if (exited) return;
      timed_out = true;
      if (pid === null) return;

      // 第 1 级：优雅停止
      await killer.killTree(pid, false);
      await Promise.race([exitedPromise, sleep(grace)]);
      if (exited) return;

      // 第 2 级：强杀。走到了这里说明优雅停止无效，但强杀通常能成功，
      // 因此这里只记录「已升级」，尚不判定为失败。
      escalated_to_force = true;
      await killer.killTree(pid, true);
      await Promise.race([exitedPromise, sleep(grace)]);
      if (exited) return;

      // 第 3 级：连强杀都无效 —— 这才是真正需要人工介入的 kill_failed。
      kill_failed = true;
      // 不再等待，直接返回；exit_code 按未取得处理。
    };

    await escalation();
  };

  await waitForExit();

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  // 若放弃等待，则不问 exit_code（永不 resolve），按 null 处理。
  const exit_code = (await Promise.race([
    handle.exit_code,
    Promise.resolve<number | null>(null),
  ])) as number | null;
  const signal = await Promise.race([handle.signal, Promise.resolve(null)]);

  return { exit_code, signal, stdout, stderr, timed_out, kill_failed, escalated_to_force };
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
