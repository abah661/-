/**
 * 受控进程树的观察与判定（B12，A 端 B11 复验 P1）。
 *
 * ## 为什么需要单独一个模块
 * B11 把「关闭事件」与「退出码」分开记账，方向是对的，但**观察对象仍然只是
 * 直接子进程**。A 端用一个真实父子进程复现了这个缺口：
 *
 * > 父进程经 OpenCode 适配器启动一个**分离**（`detached`）、stdio 为 ignore
 * > 的长驻后代；父进程正常关闭后，B11 判定为 `stopped`，而**同一时刻后代仍
 * > 存活**，可以继续写同一个 worktree。
 *
 * 于是「观察到 close」被当成了「整棵受控进程树已停止」。这两件事之间差了
 * 一整层：agent 拉起的工具子进程可以继续写同一个 worktree，而执行器已经
 * 认为现场是干净的。
 *
 * 本模块把「存活」的定义从「一个 pid」提升为「一棵受控树」，并给出
 * 平台各自的可靠手段：
 *
 * | 平台 | 隔离与终止 | 存活观察 |
 * | --- | --- | --- |
 * | POSIX | `spawn(..., { detached: true })` → 独立进程组，`kill(-pgid)` | 组探测 `process.kill(-pgid, 0)` |
 * | Windows | `taskkill /PID <pid> /T [/F]`（树语义） | 按 `ParentProcessId` 递归枚举后代 |
 *
 * ## Windows 后代枚举为什么必须带「创建时间窗口」
 * 「按 `ParentProcessId` 枚举」有一个**与生俱来的不确定性**：Windows 在进程
 * 退出时会把子进程「重新挂靠」，但**原样保留**它记录的创建者 pid，
 * 同时 pid 又会被操作系统**回收复用**。于是「某个进程的 `ParentProcessId`
 * 等于我们的 root pid」并不能证明它就是我们的后代 —— 它也可能是：
 *
 * - 一棵**更早的**树留下的孤儿，其父进程的 pid 后来被回收给了我们
 *   （实测表现：全量并行测试时，无关用例留下的孤儿会让本用例的 root pid
 *   "凭空"多出后代，把一次正常收尾误判成 `residual`）；
 * - 某个进程复用了我们 root 的 pid 之后**新拉起的**子进程。
 *
 * 因此调用方传入一个**创建时间窗口** `[created_after_ms, created_before_ms]`，
 * 只有落在窗口内的进程才可能属于这棵树。两条边界都是**可证明的**：
 *
 * - `created_after_ms` = root 的**创建时刻**。后代不可能早于它的祖先出现，
 *   所以早于该时刻的进程**一定不是**我们的后代 —— 这条边界永不误杀；
 * - `created_before_ms` = root 的**退出观察时刻 + 时钟余量**。后代不可能在
 *   祖先退出之后被创建。两个时间戳取自 Windows 同一套系统时钟、共享同一个
 *   更新粒度（`KUSER_SHARED_DATA.SystemTime`，默认 ~15.6ms 一跳），因此
 *   留 {@link TREE_CLOCK_SLACK_MS} 的余量即可，不会把真实后代挡在窗外。
 *
 * 两条边界都只**删除可证明无关的进程**，不会删除任何真实后代；万一创建时间
 * 拿不到，宁可计入（保守方向是「多停一次」，不是「漏判残留」）。
 *
 * ## 已知边界（如实记录，不假装覆盖）
 * - POSIX：后代若自行 `setsid()` 逃出进程组，组探测看不到它。进程组是
 *   POSIX 能提供的隔离边界，逃逸者需要 Job Object 级别的机制（Linux 上是
 *   cgroup），不在本执行器的可控范围内。进程组也不会像 pid 那样被回收复用，
 *   因此组探测不需要时间窗口。
 * - Windows：枚举依赖 `powershell.exe` 的 CIM 查询且必须**有界**，超时/失败
 *   一律返回 `unknown`（既不冒称存活，也不冒称已停止）。真正彻底的方案是
 *   Windows Job Object（创建进程时即绑定，退出即整树回收），但它需要原生
 *   模块，不进本执行器的依赖表。时间窗口把上面两类**可证明**的误判关掉，
 *   剩下的暴露面是「pid 恰好在探针窗口内被复用、且复用者立刻拉起子进程」,
 *   方向仍然是**偏保守的停机**，绝不会冒称 `stopped`。
 */

import { spawn } from "node:child_process";

/* ------------------------------------------------------------------ *
 * 单体存活探测
 * ------------------------------------------------------------------ */

/**
 * 进程存活性的三态探测结果。
 *
 * 刻意不是布尔：`gone`（确认不存在）与 `unknown`（问不出来）在
 * 「要不要停机」上的答案不同 —— 把两者压成一个 `boolean` 正是要避免的丢信息。
 */
export type ProcessLiveness = "alive" | "gone" | "unknown";

/**
 * 用 pid 主动探测进程是否仍存在。
 *
 * `process.kill(pid, 0)` 只做存在性检查、不发信号：
 *  - 不抛错 → 进程存在（此刻确实能「确认它活着」）；
 *  - `ESRCH` → 进程不存在；
 *  - `EPERM` → 进程存在但拿不到权限（Windows 上常见），仍算活着；
 *  - 其他错误 / 拿不到有效 pid → 无法判断。
 *
 * 返回 `unknown` 时调用方**不得**当作 `gone`。
 */
export function probeProcessAlive(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/* ------------------------------------------------------------------ *
 * 树探测
 * ------------------------------------------------------------------ */

/**
 * Windows 时钟粒度余量（毫秒）。
 *
 * `Date.now()` 与 WMI 的 `CreationDate` 都取自 Windows 的同一套系统时间
 * （`KUSER_SHARED_DATA`），默认更新粒度为 ~15.6ms。留 50ms 足以覆盖这个
 * 粒度，同时又把「pid 被复用后新拉起的子进程」挡在窗外（那需要复用发生后
 * 50ms 内就有新进程诞生，且我们的探针恰好在那一刻跑）。
 */
export const TREE_CLOCK_SLACK_MS = 50;

/** {@link TreeProbe.probeTree} 的调用参数。 */
export interface TreeProbeCallOptions {
  /**
   * 是否把根进程自身计入。
   *
   * 观察到 close 之后应传 `false`：此时 pid 可能已被操作系统复用于无关进程，
   * 再探根会把无关进程算进来。
   */
  include_root?: boolean;
  /**
   * 只统计**创建时刻 ≥ 本值**的后代（root 的创建时刻）。
   * 早于祖先出现的进程不可能是它的后代 —— 这条边界永不误杀真实后代。
   */
  created_after_ms?: number;
  /**
   * 只统计**创建时刻 ≤ 本值**的后代（root 的退出观察时刻 + 时钟余量）。
   * 祖先退出之后不可能再创建后代 —— 这条边界挡掉「pid 被复用后新拉起的子进程」。
   *
   * 未提供表示不设上界（例如始终没观察到关闭，无从知道 root 何时退出）。
   */
  created_before_ms?: number;
}

/** 观察一棵受控进程树是否仍有存活成员。 */
export interface TreeProbe {
  /**
   * @param rootPid 受控树的根 pid（执行器直接 spawn 的那个进程）
   * @param options 见 {@link TreeProbeCallOptions}
   */
  probeTree(rootPid: number, options?: TreeProbeCallOptions): Promise<ProcessLiveness>;
}

/** 一条「枚举后代」外部命令的句柄。 */
export interface DescendantCommandHandle {
  /** 命令结束（含非零退出）时结算；`error` 非空表示命令**未能启动**。 */
  done: Promise<{ code: number | null; error: Error | null; stdout: string }>;
  /** 放弃等待时中断命令本身（尽力而为，不抛错）。 */
  abort(): void;
}

/** 启动一条「枚举后代」命令。可注入，使「命令卡住/失败」可被确定性测试。 */
export type DescendantCommandRunner = (
  executable: string,
  args: readonly string[],
) => DescendantCommandHandle;

export interface TreeProbeOptions {
  /** 可注入平台：否则 Windows 分支无法在 Linux CI 上被验证。 */
  platform?: NodeJS.Platform;
  /** 一次树探测自身的等待上限。超时视为 `unknown`。 */
  timeout_ms?: number;
  /** 可注入的命令运行器（测试用）。 */
  runner?: DescendantCommandRunner;
  /** 可注入的单体探测（测试用）。 */
  single_probe?: (pid: number) => ProcessLiveness;
}

/** 树探测命令自身的等待上限。宁可答 `unknown`，也不允许挂住执行器。 */
export const DEFAULT_TREE_PROBE_TIMEOUT_MS = 5_000;

/**
 * 等待 `promise` 完成，或到 `ms` 毫秒后放弃。返回 `true` 表示按时完成。
 *
 * 与 `core/process.ts` 的同名原语保持同样的语义：**没有任何地方允许无界等待**。
 * 这里单独实现而不跨模块导出，是为了避免 `process.ts` ↔ `proc-tree.ts` 的循环导入。
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

function defaultDescendantRunner(
  executable: string,
  args: readonly string[],
): DescendantCommandHandle {
  const child = spawn(executable, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let text = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (text.length >= 64_000) return;
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  const done = new Promise<{ code: number | null; error: Error | null; stdout: string }>((resolve) => {
    // spawn 失败时只有 error，close 不触发；两条都要接。
    child.once("error", (error: Error) => resolve({ code: null, error, stdout: text }));
    child.once("close", (code) => resolve({ code, error: null, stdout: text }));
  });
  return {
    done,
    abort: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 可能已自行退出
      }
    },
  };
}

/** 后代记录的收尾标记：缺了它说明输出被截断，不能当「没有后代」。 */
const DESCENDANT_TERMINATOR = "END";

/**
 * 递归枚举 `ParentProcessId` 链的 PowerShell 脚本。
 *
 * 用 CIM 而不是 `wmic`：后者已被新版本 Windows 弃用且可能不存在。
 * 每个后代输出一行 `pid|name|创建时刻(epoch ms)`，最后输出一行 `END`；
 * `END` 缺失即视为输出异常（宁可 `unknown`，也不把「没读到」当成「没有后代」）。
 * 创建时刻用于调用方做**时间窗口过滤**（见文件头），因此必须一并带回来。
 */
function descendantListScript(rootPid: number): string {
  // rootPid 已由调用方校验为整数，不可能携带脚本内容。
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = ${rootPid}`,
    "$all = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate",
    "$children = @{}",
    "foreach ($p in $all) {",
    "  $pp = [int]$p.ParentProcessId",
    "  if (-not $children.ContainsKey($pp)) { $children[$pp] = New-Object System.Collections.ArrayList }",
    "  $cd = 0",
    "  if ($p.CreationDate) { $cd = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }",
    "  [void]$children[$pp].Add(($p.ProcessId.ToString() + '|' + $p.Name + '|' + $cd.ToString()))",
    "}",
    "$queue = New-Object System.Collections.Queue",
    "$queue.Enqueue($target)",
    "$seen = @{}",
    "while ($queue.Count -gt 0) {",
    "  $cur = [int]$queue.Dequeue()",
    "  if ($seen.ContainsKey($cur)) { continue }",
    "  $seen[$cur] = $true",
    "  if ($children.ContainsKey($cur)) {",
    "    foreach ($c in $children[$cur]) {",
    "      $cid = [int]($c -split '\\|')[0]",
    "      if (-not $seen.ContainsKey($cid)) { Write-Output $c; $queue.Enqueue($cid) }",
    "    }",
    "  }",
    "}",
    `Write-Output '${DESCENDANT_TERMINATOR}'`,
  ].join("\n");
}

/** 一条后代记录。`created_ms` 为 `null` 表示拿不到创建时间（不得据此排除）。 */
interface DescendantRecord {
  pid: number;
  created_ms: number | null;
}

const DESCENDANT_LINE = /^(\d+)\|([^|]*)\|(\d+)$/;

/**
 * 解析后代枚举命令的输出。
 *
 * 返回 `null` 表示输出**不可信**（空、缺 `END`、行格式不符）——调用方
 * 必须据此答 `unknown`，而不是把「没读懂」当成「没有后代」。
 */
export function parseDescendantList(stdout: string): DescendantRecord[] | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return null;
  if (lines[lines.length - 1] !== DESCENDANT_TERMINATOR) return null;

  const records: DescendantRecord[] = [];
  for (const line of lines.slice(0, -1)) {
    const matched = DESCENDANT_LINE.exec(line);
    if (!matched) return null;
    const pid = Number.parseInt(matched[1]!, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const created = Number.parseInt(matched[3]!, 10);
    records.push({ pid, created_ms: Number.isFinite(created) && created > 0 ? created : null });
  }
  return records;
}

/**
 * 该后代是否落在调用方给的创建时间窗口内。
 *
 * 创建时间拿不到时**计入**：过滤的目的只是删掉**可证明无关**的进程，
 * 拿不到证据就不删 —— 漏判残留的代价远大于多停一次。
 */
function withinCreationWindow(
  record: DescendantRecord,
  createdAfter: number | undefined,
  createdBefore: number | undefined,
): boolean {
  if (record.created_ms === null) return true;
  if (createdAfter !== undefined && record.created_ms < createdAfter) return false;
  if (createdBefore !== undefined && record.created_ms > createdBefore) return false;
  return true;
}

/** POSIX：负 pid 打整个进程组；组不存在时退回单体探测。 */
function probePosixTree(pid: number, single: (pid: number) => ProcessLiveness): ProcessLiveness {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "alive";
    if (code !== "ESRCH") return "unknown";
    // 没有这个进程组：可能是未 detached 启动（没有独立组）。退回单体探测，
    // 至少如实回答根进程的状态，而不是把「没有组」说成「没有进程」。
    return single(pid);
  }
}

/** 系统树探测：POSIX 用进程组，Windows 用后代枚举。 */
export class SystemTreeProbe implements TreeProbe {
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly runner: DescendantCommandRunner;
  private readonly single: (pid: number) => ProcessLiveness;

  constructor(options: TreeProbeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeout_ms ?? DEFAULT_TREE_PROBE_TIMEOUT_MS;
    this.runner = options.runner ?? defaultDescendantRunner;
    this.single = options.single_probe ?? probeProcessAlive;
  }

  async probeTree(
    rootPid: number,
    options: TreeProbeCallOptions = {},
  ): Promise<ProcessLiveness> {
    if (!Number.isInteger(rootPid) || rootPid <= 0) return "unknown";
    if (this.platform !== "win32") {
      // 组探测天然覆盖根与后代，`include_root` / 时间窗口对它没有意义：
      // 进程组 id 不会被像 pid 那样回收复用给无关进程。
      return probePosixTree(rootPid, this.single);
    }
    return await this.probeWindows(rootPid, options);
  }

  private async probeWindows(rootPid: number, options: TreeProbeCallOptions): Promise<ProcessLiveness> {
    // 观察到 close 之后不再探根：pid 可能已被复用给无关进程，
    // 那会把「无关进程还活着」误报成「本次 agent 的后代还活着」。
    if (options.include_root ?? true) {
      const direct = this.single(rootPid);
      if (direct === "alive") return "alive";
      // `unknown` 不作终判：继续枚举后代，拿到任何一条肯定证据都更好。
    }

    let handle: DescendantCommandHandle;
    try {
      handle = this.runner("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        descendantListScript(rootPid),
      ]);
    } catch {
      return "unknown";
    }

    if (!(await settledWithin(handle.done, this.timeoutMs))) {
      handle.abort();
      return "unknown";
    }
    const { code, error, stdout } = await handle.done;
    if (error !== null) return "unknown";
    if (code !== 0) return "unknown";

    const records = parseDescendantList(stdout);
    if (records === null) return "unknown";

    const anyInWindow = records.some((record) =>
      withinCreationWindow(record, options.created_after_ms, options.created_before_ms),
    );
    return anyInWindow ? "alive" : "gone";
  }
}

export const systemTreeProbe: TreeProbe = new SystemTreeProbe();

/**
 * 把一次受控调用的「创建时刻 / 退出观察时刻」换算成树探测的时间窗口。
 *
 * 把换算收在一处，避免两个调用方（agent 进程与测试进程）各写一遍、
 * 慢慢漂移出不同的边界语义。
 */
export interface TreeObservation {
  /** root 进程被创建的时刻（`Date.now()`） */
  spawn_at_ms: number;
  /** 观察到 root 关闭的时刻；始终未观察到则为 `null` */
  closed_at_ms: number | null;
}

export function treeCreationWindow(observation: TreeObservation): {
  created_after_ms: number;
  created_before_ms?: number;
} {
  return {
    created_after_ms: observation.spawn_at_ms,
    ...(observation.closed_at_ms !== null
      ? { created_before_ms: observation.closed_at_ms + TREE_CLOCK_SLACK_MS }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 状态判定
 * ------------------------------------------------------------------ */

/**
 * 受控进程的生命周期状态，由**可观测事实**判定。
 *
 * 刻意不是布尔：`spawn_failed`（连进程都没有）与 `unknown`（有过进程、
 * 去向不明）在「要不要继续开工」上的答案完全不同 —— 前者可以安全继续，
 * 后者必须停机。
 */
export type ControlledProcessState = "spawn_failed" | "stopped" | "unknown" | "residual";

/** 树探测抛异常时的保守归属：既不知道有没有进程，就不能说已停止。 */
async function safeProbeTree(probe: () => Promise<ProcessLiveness>): Promise<ProcessLiveness> {
  try {
    return await probe();
  } catch {
    return "unknown";
  }
}

/**
 * 由**可观测事实**判定进程状态，全程**不读 `exit_code`**。
 *
 * 判定顺序（B12 版，相对 B11 的关键变化在「close 之后还要问树」）：
 *  1. `spawn_failed` —— 连进程都没创建（可证明安全）；
 *  2. `close_observed` —— 观察到**直接子进程**关闭。**这不足以判 `stopped`**：
 *     后代可能在父进程关闭后继续存活并写同一个 worktree（A 端 B11 复验 P1
 *     用真实父子进程复现）。必须再问一次树：
 *     - 树 `gone` → `stopped`（根与后代都不在了，才叫真的停了）；
 *     - 树 `alive` → `residual`（父已关闭、后代仍活着 —— 正是被漏判的那一类）；
 *     - 树 `unknown` → `unknown`（问不出来就不冒称已停止）。
 *  3. 未观察到关闭：只有主动探测答「还活着」才记 `residual`，否则 `unknown`。
 *
 * 与 A 端裁定的映射保持一致：**「未观察到关闭」本身永远不会被判成 `stopped`**，
 * 即使探测显示已不存在 —— 那条路径按 A 的映射归 `unknown`，宁可人工确认一次。
 *
 * `probe_tree` 缺省时的退化：注入式 runner 没有树通道，只能回到「直接子进程」
 * 语义。**出厂 runner（`NodeOpenCodeProcessRunner`）永远提供该通道**，
 * 因此这条退化路径不会出现在真实链路上。
 */
export async function determineProcessState(input: {
  spawn_failed: boolean;
  close_observed: boolean;
  /** 整棵受控树的存活探测（优先于 `probe`） */
  probe_tree?: (() => Promise<ProcessLiveness>) | undefined;
  /** 直接子进程的存活探测（无树通道时的退化依据） */
  probe?: (() => ProcessLiveness) | undefined;
}): Promise<ControlledProcessState> {
  if (input.spawn_failed) return "spawn_failed";

  if (input.probe_tree === undefined) {
    if (input.close_observed) return "stopped";
    const probed = input.probe !== undefined ? input.probe() : "unknown";
    return probed === "alive" ? "residual" : "unknown";
  }

  const tree = await safeProbeTree(input.probe_tree);
  if (input.close_observed) {
    if (tree === "gone") return "stopped";
    if (tree === "alive") return "residual";
    return "unknown";
  }
  return tree === "alive" ? "residual" : "unknown";
}
