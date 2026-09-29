/**
 * OpenCode 适配器：非交互调用与结构化事件（第 8 节，P2 分工表的 B 项）。
 *
 * ## 与 Codex 适配器的接口对齐
 * A 端 `packages/codex-adapter` 定义了同一组概念：进程运行器可注入、
 * 事件流解析、错误分类、SHA-256 指纹、结果结构。本模块刻意保持同形，
 * 以便归一化层用同一套逻辑处理两种 agent。
 *
 * ## 实测得到的两条硬约束（2026-09-21 于本机验证，不是推测）
 *
 * 1. **必须显式传 `-m <provider>/<model>`**。
 *    不带 `-m` 时 OpenCode 会落到环境变量里的 provider（本机实测：
 *    串到 `OPENAI_API_KEY` 指向的端点，返回
 *    `401 APIError "Invalid token"`, `isRetryable:false`）。
 *    带上 `-m myapi/gpt-5.5` 后同一命令正常返回。
 *    因此模型**不做默认推断**，缺省即报错，不留「静默走错 provider」的空间。
 *
 * 2. **`--format json` 输出是 JSON Lines 事件流**，已观测到的事件类型：
 *    - `step_start`：会话开始
 *    - `text`：模型文本输出，正文在 `part.text`
 *    - `step_finish`：正常收尾，`part.reason === "stop"`，
 *      且 `part.tokens` 给出真实计量
 *    解析时**不假设事件种类封闭**——只提取认识的字段，其余按计数记录。
 *
 * ## 错误分类（第 8 节 / §193）
 * 登录过期与配额不足必须分别标记，不得当代码失败反复返修。
 * 这里沿用与 Codex 适配器一致的文本分类，但额外利用 OpenCode
 * 返回的**结构化错误对象**（`{"type":"error","error":{...}}`），
 * 比纯文本匹配可靠得多。
 */

import { createHash } from "node:crypto";
import { setImmediate as drainMicrotasks } from "node:timers/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ErrorCode } from "@dac/protocol";
import { scrubbedChildEnv } from "../core/child-env.js";
import { systemTreeKiller } from "../core/process.js";
import type { TreeKiller } from "../core/process.js";
import {
  determineProcessState,
  probeProcessAlive,
  systemTreeProbe,
  treeCreationWindow,
} from "../core/proc-tree.js";
import type { ControlledProcessState, ProcessLiveness, TreeProbe } from "../core/proc-tree.js";
import { describeLaunchResolution, resolveOpenCodeLaunch } from "./opencode-launcher.js";

// B12：进程存活与状态判定的实现搬到 `core/proc-tree.ts`（测试进程也要用同一套）。
// 这里**原样再导出**，既有调用方与测试的导入路径不变。
export { determineProcessState, probeProcessAlive };
export type { ProcessLiveness };

import type {
  OpenCodeLaunchConfig,
  OpenCodeLaunchResolution,
  OpenCodeLaunchSource,
} from "./opencode-launcher.js";

/* ------------------------------------------------------------------ *
 * 输入与配置
 * ------------------------------------------------------------------ */

export interface OpenCodeTaskInput {
  /** 提示词。作为**单个参数**传递，不会被拆成多项 */
  prompt: string;
  /** 工作目录，须为任务专属 worktree */
  cwd: string;
  /**
   * 模型，形如 `myapi/gpt-5.5`。
   * **必填**——见文件头约束 1，不提供默认值。
   */
  model: string;
  /** 超时毫秒数 */
  timeout_ms?: number;
  /**
   * 外部取消信号（`Ctrl+C` / 关闭常驻进程）。
   *
   * 置位后立即向子进程发终止信号。之所以必须走信号而不是"调用方自己不管了"：
   * 不真正终止子进程就会留下孤儿进程，继续占用 worktree 与模型配额。
   * 取消**不**单独伪造状态码——进程被终止后自然是非零退出，
   * 由既有的退出码路径得出 `AGENT_NONZERO_EXIT`，事实准确。
   */
  signal?: AbortSignal;
  /** 附加文件（`--file`），供上下文注入 */
  files?: readonly string[];
  /** 使用的 agent 名称（`--agent`），可选 */
  agent?: string;
}

export interface OpenCodeAdapterConfig {
  /**
   * 兜底可执行文件名；默认 `opencode`。
   *
   * **注意（B6-2）**：在 Windows 上以裸名 `opencode` 启动**必然 `ENOENT`**，
   * 因为 npm 只提供 `.cmd` / `.ps1` shim，而 Node 在 `shell: false` 下
   * 不解析它们。正常路径是先经 `launcher`（或自动探测）解析出真实目标，
   * 本字段只是「什么都没解析出来」时的最后手段。
   */
  executable?: string;
  /**
   * 显式启动方式（B6-2，A 端裁定）。给出即优先使用，见
   * `adapters/opencode-launcher.ts`：支持原生可执行文件与
   * `node.exe` + JS 入口两种形态，**都不经 shell**。
   */
  launcher?: OpenCodeLaunchConfig;
  /** 兜底模型。**仍建议每次显式传入**，此项仅为兼容调用方便利 */
  default_model?: string;
  default_timeout_ms?: number;
  /**
   * 是否附加 `--auto`（自动批准未显式拒绝的权限）。
   * 默认 **false**：执行器在受控 worktree 内运行，不应默认放开权限。
   */
  auto_approve?: boolean;
}

/* ------------------------------------------------------------------ *
 * 进程抽象（可注入，便于测试）
 * ------------------------------------------------------------------ */

export interface OpenCodeProcess {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  exit_code: Promise<number | null>;
  /**
   * 终止进程。
   *
   * B12：**必须作用于整棵受控进程树**，而不是只向直接子进程发信号。
   * 「父进程关了、它拉起的后代还活着」正是 A 端 B11 复验 P1 点名的缺口，
   * 只杀父进程等于把后代变成孤儿继续写 worktree。
   *
   * 返回 `void | Promise<void>`：POSIX 的组信号是同步的，而 Windows 的
   * 树杀要走 `taskkill`（异步）。调用方一律 `await` 结果，两种实现都接受。
   */
  kill(signal?: NodeJS.Signals): void | Promise<void>;
  /**
   * 进程**启动失败**的错误（例如可执行文件不在 PATH 上的 `ENOENT`）。
   * 正常启动时为 `null`，未提供该字段时视为「不会启动失败」。
   *
   * ## 为什么必须有这个字段（B5 真实链路测试暴露的缺陷）
   * 可执行文件不存在时，Node 只在子进程上发出 `error` 事件：
   * `close` **不会**触发（因此 `exit_code` 永不兑现），`stdout` / `stderr`
   * 也不会正常结束（`for await` 永久挂起），并且没有 `error` 监听者时
   * 该错误会升级为**进程级未捕获异常**。
   *
   * 三者叠加的结果是：`opencode` 未安装时执行器**永久死等**，
   * 既不返回失败也不上报，租约白白耗尽。因此启动失败必须是一条
   * 显式的、可等待的通道，而不是靠「等 close」来碰运气。
   */
  spawn_error?: Promise<Error | null>;
  /**
   * **观察到进程关闭**（`close` / `exit` 事件）——与 `exit_code` 是两个不同事实。
   *
   * 为什么不能只看 `exit_code`（B11，A 端 B10 复验 §a）：
   *  - 进程**被信号终止**时可能永远拿不到数字退出码，但它确实已经退出；
   *  - **启动失败**时 `exit_code` 也会兑现成一个 `null`，而那次进程从未存在。
   * 两种情况在 `exit_code` 上长得一模一样，凭它反推必然出错。
   *
   * 缺省（未提供）时调用方按「`exit_code` 已兑现且无启动失败」近似判断：
   * 兼容既有注入式 runner，同时**不会**把启动失败当成观察到关闭。
   */
  closed?: Promise<void>;
  /**
   * 主动探测进程是否仍存活，返回三态（B11，A 端 B10 复验 §a）。
   *
   * 只在「已启动、已发终止信号、却始终没观察到关闭」时才被调用：
   * 那时只有**问到「还活着」**才敢记 `residual`；问不到一律 `unknown`。
   * 缺省时视为无法探测（等价于 `unknown`）。
   */
  probe_alive?: () => ProcessLiveness;
  /**
   * 主动探测**整棵受控进程树**是否仍有存活成员（B12，A 端 B11 复验 P1）。
   *
   * 为什么单独一条通道：`closed` 只证明**直接子进程**关闭。agent 若拉起了
   * 分离的长驻后代，父进程的 close 与「现场已干净」之间还差一整棵树
   * —— A 端就是用这个场景复现出 B11 的 `stopped` 误判。
   *
   * 判定时优先使用本通道；只有它在场时，「观察到关闭」才可能被判为
   * `stopped`（且还必须树也 `gone`）。缺省时退化为直接子进程语义，
   * 而出厂 runner 永远提供本通道。
   */
  probe_tree_alive?: () => Promise<ProcessLiveness>;
}

export interface OpenCodeProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): OpenCodeProcess;
}

/**
 * 真实进程启动器。
 *
 * 导出是为了让集成测试能构造「可执行文件不存在」这一确定场景
 * （B5 真实链路测试需要真实 spawn 一个不存在的路径，而不是模拟）。
 */
export class NodeOpenCodeProcessRunner implements OpenCodeProcessRunner {
  private readonly killer: TreeKiller;
  private readonly treeProbe: TreeProbe;

  constructor(options: { killer?: TreeKiller; tree_probe?: TreeProbe } = {}) {
    this.killer = options.killer ?? systemTreeKiller;
    this.treeProbe = options.tree_probe ?? systemTreeProbe;
  }

  start(executable: string, args: readonly string[], cwd: string): OpenCodeProcess {
    const child: ChildProcess = spawn(executable, [...args], {
      cwd,
      // 参数数组隔离的前提：不经 shell
      shell: false,
      windowsHide: true,
      // B12（A 端 B11 复验 P1）：POSIX 上让 agent 进入**独立进程组**。
      // 只有这样 `kill(-pgid)` 才覆盖它拉起的后代，存活探测也才能观察到
      // 整棵树；否则「杀父进程」会让后代变成孤儿继续占用 worktree，
      // 而 close 事件还会让执行器以为现场已经干净。
      // Windows 没有进程组语义，改走 taskkill /T + 后代枚举（见 core/proc-tree.ts）。
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      // B8（A 端 B7-3）：agent 进程同样**不得**继承协调器凭据。
      // 原实现不传 env，等于把 COORDINATOR_API_TOKEN 交给 agent 与它
      // 拉起的每一个子进程；agent 的输出又会进 artifact 与上报链路。
      env: scrubbedChildEnv(process.env),
    });

    // 必须**立刻**挂上 error 监听：spawn 失败是异步抛出的，
    // 迟一步就会变成未捕获异常并杀掉整个执行器进程。
    const spawn_error = new Promise<Error | null>((resolve) => {
      child.once("error", (error: Error) => resolve(error));
    });

    // B11（A 端 B10 复验 §a）：**关闭事件**与**退出码**分别记账。
    // 被信号终止的进程没有数字退出码，但关闭事件确实发生过；
    // 启动失败会把 `exit_code` 也兑现成 null，却根本没有进程。
    //
    // B12：这里同时记下**创建时刻**与**退出观察时刻** —— Windows 后代枚举的
    // 时间窗口两端。窗口必须由 `spawn` / `close` 给出，而只有这里同时看得到。
    const spawnAt = Date.now();
    let closedAt: number | null = null;
    let close_observed = false;
    const close_event = new Promise<void>((resolve) => {
      child.once("close", () => {
        close_observed = true;
        closedAt = Date.now();
        resolve();
      });
    });
    const closed = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );

    return {
      stdout: child.stdout!,
      stderr: child.stderr!,
      // 启动失败时没有进程可等，退出码按「未取得」返回 null。
      // 绝不在这里伪造 0 —— 那会让上层把「没跑起来」当成正常结束。
      exit_code: Promise.race([closed, spawn_error.then(() => null)]),
      closed: close_event,
      probe_alive: (): ProcessLiveness => {
        // 已经观察到关闭 → 确定不在运行，不必再问 pid（pid 可能已被复用）。
        if (close_observed) return "gone";
        const pid = child.pid;
        if (pid === undefined) return "gone";
        return probeProcessAlive(pid);
      },
      probe_tree_alive: async (): Promise<ProcessLiveness> => {
        const pid = child.pid;
        if (pid === undefined) return "gone";
        // B12（A 端 B11 复验 P1）：close 之后 pid 可能已被复用给无关进程，
        // 且更早的树可能留下「父 pid 恰好等于本 pid」的孤儿。枚举必须带创建
        // 时间窗口把这两类**可证明无关**的进程剔掉（见 core/proc-tree.ts）。
        return await this.treeProbe.probeTree(pid, {
          include_root: !close_observed,
          ...treeCreationWindow({ spawn_at_ms: spawnAt, closed_at_ms: closedAt }),
        });
      },
      kill: (signal = "SIGTERM"): Promise<void> => {
        const pid = child.pid;
        if (pid === undefined) {
          // 启动失败时没有可终止的进程；终止动作本身不应抛出。
          return Promise.resolve();
        }
        // B12：**树级**终止。只对孩子发信号会留下后代继续写 worktree。
        return this.killer
          .killTree(pid, signal === "SIGKILL")
          .then((outcome) => {
            // 树杀没能报告成功时，退化为直接向子进程发信号：
            // 有界、尽力而为，绝不因为树杀失败就什么都不做。
            if (!outcome.ok) killDirect(child, signal);
          })
          .catch(() => {
            killDirect(child, signal);
          });
      },
      spawn_error,
    };
  }
}

/** 直接向子进程发信号（树杀不可用时的兜底，尽力而为、绝不抛出）。 */
function killDirect(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    child.kill(signal);
  } catch {
    // 启动失败或进程已退出；终止动作本身不应抛出。
  }
}

/* ------------------------------------------------------------------ *
 * 命令构造
 * ------------------------------------------------------------------ */

/**
 * 构造 `opencode run` 的参数数组。
 *
 * 参数顺序与官方 CLI 文档一致：`opencode run [flags] <message>`。
 * 提示词**必须最后**作为单个位置参数，否则会被当作 flag 值吞掉。
 */
export function buildOpenCodeRunArgs(
  input: OpenCodeTaskInput,
  config: OpenCodeAdapterConfig = {},
): string[] {
  const model = input.model || config.default_model;
  if (!model) {
    throw new Error(
      "OpenCode 适配器要求显式指定模型（形如 myapi/gpt-5.5）。" +
        "不传会落到环境变量 provider 并返回 401，故此处硬性拒绝启动。",
    );
  }
  if (model.includes(" ") || model.includes("\0")) {
    throw new Error(`模型标识非法：${model}`);
  }

  const args: string[] = ["run", "--format", "json", "-m", model];
  if (input.agent) args.push("--agent", input.agent);
  if (config.auto_approve) args.push("--auto");
  for (const file of input.files ?? []) args.push("--file", file);
  // 提示词置于末尾，整体作为单个参数
  args.push(input.prompt);
  return args;
}

/* ------------------------------------------------------------------ *
 * 事件流解析
 * ------------------------------------------------------------------ */

export interface OpenCodeEventSummary {
  events: ReadonlyArray<Record<string, unknown>>;
  /** 非法 JSON 行数；>0 视为输出不可信 */
  invalid_json_lines: number;
  /** 会话 ID（`sessionID`），用于回查 */
  session_id: string | null;
  /** 拼接后的模型文本输出 */
  final_message: string | null;
  /** 各类事件出现次数 */
  event_counts: Readonly<Record<string, number>>;
  /** 累计 token 计量，取自最后一个 step_finish */
  tokens: { total: number; input: number; output: number; reasoning: number } | null;
  /** 累计花费（若 provider 上报） */
  cost: number | null;
  /** 结构化错误（若有） */
  error: OpenCodeStructuredError | null;
}

export interface OpenCodeStructuredError {
  name: string;
  message: string;
  status_code: number | null;
  is_retryable: boolean | null;
  /** 出错时请求打向的地址，便于判断是否走错了 provider */
  url: string | null;
}

/** 解析 JSON Lines 事件流。容忍空行与非 JSON 噪音行（计入计数）。 */
export function parseOpenCodeEvents(stdout: string): OpenCodeEventSummary {
  const events: Array<Record<string, unknown>> = [];
  let invalid = 0;
  let sessionId: string | null = null;
  const texts: string[] = [];
  const counts: Record<string, number> = {};
  let tokens: OpenCodeEventSummary["tokens"] = null;
  let cost: number | null = null;
  let error: OpenCodeStructuredError | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") {
        invalid += 1;
        continue;
      }
      event = parsed as Record<string, unknown>;
    } catch {
      invalid += 1;
      continue;
    }
    events.push(event);

    const type = typeof event.type === "string" ? event.type : "unknown";
    counts[type] = (counts[type] ?? 0) + 1;

    if (typeof event.sessionID === "string" && sessionId === null) {
      sessionId = event.sessionID;
    }

    if (type === "error") {
      error = extractError(event);
    }

    const part = event.part;
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        texts.push(record.text);
      }
      if (record.type === "step-finish") {
        const t = record.tokens;
        if (t && typeof t === "object") {
          const tr = t as Record<string, number>;
          tokens = {
            total: Number(tr.total ?? 0),
            input: Number(tr.input ?? 0),
            output: Number(tr.output ?? 0),
            reasoning: Number(tr.reasoning ?? 0),
          };
        }
        if (typeof record.cost === "number") cost = record.cost;
      }
    }
  }

  return {
    events,
    invalid_json_lines: invalid,
    session_id: sessionId,
    final_message: texts.length > 0 ? texts.join("") : null,
    event_counts: counts,
    tokens,
    cost,
    error,
  };
}

function extractError(event: Record<string, unknown>): OpenCodeStructuredError {
  const raw = event.error;
  if (!raw || typeof raw !== "object") {
    return { name: "UnknownError", message: "", status_code: null, is_retryable: null, url: null };
  }
  const e = raw as Record<string, unknown>;
  const data = (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>;
  const metadata = (data.metadata && typeof data.metadata === "object" ? data.metadata : {}) as Record<
    string,
    unknown
  >;
  return {
    name: typeof e.name === "string" ? e.name : "UnknownError",
    message: typeof data.message === "string" ? data.message : "",
    status_code: typeof data.statusCode === "number" ? data.statusCode : null,
    is_retryable: typeof data.isRetryable === "boolean" ? data.isRetryable : null,
    url: typeof metadata.url === "string" ? metadata.url : null,
  };
}

/* ------------------------------------------------------------------ *
 * 错误分类
 * ------------------------------------------------------------------ */

export type OpenCodeAdapterStatus =
  | "completed"
  | "failed"
  | "blocked_auth"
  | "blocked_quota"
  | "retryable";

/**
 * 把错误分类为「凭据阻塞 / 配额阻塞 / 可重试 / 代码失败」。
 *
 * 优先使用**结构化字段**（statusCode / message），退化到文本匹配。
 * 这与 Codex 适配器的分类结果保持同义，使归一化层可共用逻辑。
 */
export function classifyOpenCodeFailure(input: {
  structured: OpenCodeStructuredError | null;
  text: string;
}): { status: OpenCodeAdapterStatus; error_code: ErrorCode } | null {
  const { structured, text } = input;
  const message = `${structured?.message ?? ""}\n${text}`;

  // —— 凭据：401 / 无效 token / 未认证 ——
  if (
    structured?.status_code === 401 ||
    /invalid token|not authenticated|authentication required|unauthorized|token expired|please log ?in|\b401\b/i.test(
      message,
    )
  ) {
    return { status: "blocked_auth", error_code: "AUTH_EXPIRED" };
  }

  // —— 配额：余额/额度不足。403 需结合文案，避免把权限问题误判为配额 ——
  if (
    /insufficient|quota|credit|balance|billing|额度|余额|欠费/i.test(message) ||
    structured?.status_code === 402
  ) {
    return { status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" };
  }

  // —— 限流：可重试 ——
  if (structured?.status_code === 429 || /rate limit|too many requests|\b429\b/i.test(message)) {
    return { status: "retryable", error_code: "RATE_LIMITED" };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

export interface OpenCodeAdapterResult {
  status: OpenCodeAdapterStatus;
  error_code: ErrorCode | null;
  exit_code: number | null;
  timed_out: boolean;
  session_id: string | null;
  final_message: string | null;
  event_counts: Readonly<Record<string, number>>;
  tokens: OpenCodeEventSummary["tokens"];
  cost: number | null;
  stdout_sha256: string;
  stderr_sha256: string;
  invalid_json_lines: number;
  /** 出错时请求打向的 URL；用于诊断「是否走错 provider」 */
  request_url: string | null;
  /**
   * 实际使用的启动方式（B6-2）。
   *
   * `bare_name` 表示**没能解析出真实目标**、退回了裸命令名
   * （Windows 上等于必然 `ENOENT`）。这是一个可观测的降级信号，
   * 不该被埋在日志里。
   */
  launch_source: OpenCodeLaunchSource | "bare_name";
  /** 启动方式的解析依据；解析失败时是搜索过的路径清单 */
  launch_detail: string;
  /**
   * 本次 agent 进程的生命周期状态（B11，A 端 B10 复验 §a）。
   *
   * 调用方**必须**用它判断「能不能安全继续」，不得用 `exit_code` 反推：
   * 被信号终止的进程可能拿不到数字退出码，而启动失败也会把 `exit_code`
   * 兑现成 `null` —— 两者在退出码上无法区分，而它们的处置完全不同。
   */
  process_state: OpenCodeProcessState;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 超时后再等这么久就放弃等待退出码（避免被不响应的进程永久阻塞）。 */
const KILL_GRACE_MS = 5_000;

/**
 * 发出 SIGKILL 后，再给这么久去观察关闭事件（B11，A 端 B10 复验 §a）。
 *
 * 这个窗口必须**存在**：否则一个刚被强杀的进程会被判成「状态未知」，
 * 白白触发人工门禁；也必须**有限**：否则一个不响应的进程会把执行器拖死。
 */
const POST_KILL_GRACE_MS = 2_000;

/**
 * 进程生命周期状态（B11/B12，A 端 B10 复验 §a、B11 复验 P1）。
 *
 * 刻意不是布尔：`spawn_failed`（连进程都没有）与 `unknown`（有过进程、
 * 去向不明）在「要不要继续开工」上的答案完全不同 —— 前者可以安全继续，
 * 后者必须停机。把它们压成一个 `boolean` 正是被点名的那种丢信息。
 *
 * 定义与判定顺序见 `core/proc-tree.ts`：测试进程与 agent 进程共用同一套，
 * 否则两条链会对「什么叫已停止」给出两种解释。
 */
export type OpenCodeProcessState = ControlledProcessState;

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

/**
 * **启动前阶段**的失败（B10，A 端 B9 复验 §4）。
 *
 * 「启动前」在这里有严格含义：`runner.start()` **还没有被调用**，
 * 因此本机上不存在这次 attempt 的 agent 进程 —— 失败是**可证明安全的**。
 *
 * 它和「启动之后抛错」必须分开，否则调用方只能保守地把所有异常都当成
 * 「进程状态未知」并停机，于是一个模型名写错就会让执行器每次启动都被
 * 残留门禁拦住，得人工清一次标记才能起来。
 */
export class OpenCodePreStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodePreStartError";
  }
}

/**
 * 执行「启动前」的一段计算，并把其中任何异常统一转成
 * {@link OpenCodePreStartError}。
 *
 * 只用于 `runner.start()` **之前**的代码。`runner.start()` 自身的失败
 * 走的是**返回值**（见下方 try/catch），不是抛出，所以不在本函数覆盖范围内。
 */
function preStart<T>(compute: () => T): T {
  try {
    return compute();
  } catch (error) {
    throw new OpenCodePreStartError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * 非交互执行一次 OpenCode 任务。
 *
 * 判定顺序（与 Codex 适配器一致，理由见第 8 节步骤 8）：
 * 超时 → 凭据/配额/限流 → 输出不可解析 → 退出码非零 → 完成。
 * **完成不等于成功**：`completed` 仅表示「agent 正常结束」，
 * 是否 `ready_for_integration` 由归一化层结合测试证据判定。
 */
export async function runOpenCodeTask(
  input: OpenCodeTaskInput,
  config: OpenCodeAdapterConfig = {},
  runner: OpenCodeProcessRunner = new NodeOpenCodeProcessRunner(),
): Promise<OpenCodeAdapterResult> {
  // B10：进程尚未创建，这里的失败是「可证明的启动前失败」。
  const cliArgs = preStart(() => buildOpenCodeRunArgs(input, config));

  /*
   * B6-2（A 端裁定）：**先解析出真实启动目标，再以绝对路径 + 参数数组启动**。
   *
   * Windows 上把裸名 `opencode` 交给 `spawn(..., { shell: false })` 是必然
   * `ENOENT`——npm 只装了 `.cmd` / `.ps1` shim。解析结果要么是原生可执行文件
   * （本机的 `opencode.exe`），要么是 `node.exe` + JS 入口；两者都**不经 shell**，
   * 因此 A 端红线（保持 `shell: false`、不拼命令串）原样成立。
   */
  /*
   * 优先级：显式 `launcher` > 显式 `executable` > 本机环境自动解析。
   *
   * `executable` 一旦被显式给出就**不再自动探测**——调用方点名了用哪个文件，
   * 探测不该把它换掉。这条约束是被真实测试逼出来的：`{ executable: <不存在的路径> }`
   * 原先会被自动探测替换成本机真实的 `opencode.exe` 并**真的启动**，
   * 于是「起不来要快速失败」这条路径被悄悄换成了另一件事。
   */
  const launch: OpenCodeLaunchResolution | null = preStart<OpenCodeLaunchResolution | null>(
    () =>
      config.launcher !== undefined
        ? resolveOpenCodeLaunch({ configured: config.launcher })
        : config.executable !== undefined
          ? null
          : resolveOpenCodeLaunch(),
  );

  const resolvedSpec = launch !== null && launch.kind === "resolved" ? launch.spec : null;
  const command = resolvedSpec !== null ? resolvedSpec.command : (config.executable ?? "opencode");
  const prefixArgs: readonly string[] = resolvedSpec?.prefix_args ?? [];
  const args: string[] = [...prefixArgs, ...cliArgs];
  const launch_source: OpenCodeLaunchSource | "bare_name" =
    launch === null ? "explicit_executable" : (resolvedSpec?.source ?? "bare_name");
  const launch_detail =
    launch === null
      ? `调用方显式指定的可执行文件：${config.executable ?? "opencode"}`
      : describeLaunchResolution(launch);

  let handle: OpenCodeProcess;
  try {
    handle = runner.start(command, args, input.cwd);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const classified = classifyOpenCodeFailure({ structured: null, text });
    return {
      status: classified?.status ?? "failed",
      error_code: classified?.error_code ?? "INTERNAL_ERROR",
      exit_code: null,
      timed_out: false,
      session_id: null,
      final_message: null,
      event_counts: {},
      tokens: null,
      cost: null,
      stdout_sha256: sha256(""),
      stderr_sha256: sha256(text),
      invalid_json_lines: 0,
      request_url: null,
      launch_source,
      launch_detail,
      // B11（A 端 B10 复验 §a）：`runner.start()` 同步抛错 = 进程**从未创建**，
      // 这是可证明的安全失败，不能被记成「去向不明」。
      process_state: "spawn_failed",
    };
  }

  let timed_out = false;
  const timeout = input.timeout_ms ?? config.default_timeout_ms ?? 1_800_000;

  // 收集输出但不无限等待退出：超时后即使进程不理会终止信号，
  // 也必须让本函数返回，否则整套执行流程会卡死。
  //
  // `catch` 不是装饰：子进程异常退出时 stdio 流可能以错误收尾，
  // 未捕获的读取错误会变成未处理拒绝。
  const stdoutPromise = collect(handle.stdout).catch(() => "");
  const stderrPromise = collect(handle.stderr).catch(() => "");
  const exitPromise = handle.exit_code;

  // B11（A 端 B10 复验 §a）：**单独**记「是否观察到关闭」。
  // 它不能用 `exit_code` 代替：退出码可能永远不来（被信号终止），
  // 也可能因为启动失败而兑现成 null（进程压根没存在过）。
  let close_observed = false;
  if (handle.closed !== undefined) {
    void handle.closed.then(
      () => {
        close_observed = true;
      },
      () => {
        // 关闭通道不应失败；真失败时保持「未观察到」，按保守方向处理。
      },
    );
  }

  let exited = false;
  const exitedPromise = exitPromise.then(() => {
    exited = true;
  });

  // 启动失败与超时同等对待：都必须让本函数**尽快**返回。
  // 没有这个通道时，`opencode` 不在 PATH 上会让这里永久挂起。
  let spawn_error: Error | null = null;
  const spawnFailure: Promise<void> = (
    handle.spawn_error ?? new Promise<never>(() => undefined)
  ).then((error) => {
    spawn_error = error;
  });

  /**
   * B12：终止现在可能是**异步**的（Windows 的树杀要走 `taskkill`），
   * 因此统一从这里发出并吞掉拒绝 —— 终止失败的真实后果由 `process_state`
   * 的探测结果接住，不该变成一个未处理拒绝把执行器打掉。
   */
  const terminate = (signal: NodeJS.Signals): void => {
    void Promise.resolve()
      .then(() => handle.kill(signal))
      .catch(() => {
        /* 见上：状态探测才是判据 */
      });
  };

  const killTimer = setTimeout(() => {
    timed_out = true;
    terminate("SIGTERM");
  }, timeout);

  // 外部取消（Ctrl+C）：与超时复用同一条终止路径，不做特殊状态码。
  const onAbort = (): void => {
    terminate("SIGTERM");
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  await Promise.race([
    exitedPromise,
    spawnFailure,
    new Promise<void>((resolve) => setTimeout(resolve, timeout + KILL_GRACE_MS)),
  ]);
  clearTimeout(killTimer);
  input.signal?.removeEventListener("abort", onAbort);

  // B11（A 端 B10 复验 §a）：两条通道（`exit_code` 与 `spawn_error`）可能在
  // 同一轮微任务里竞速落定 —— 真实 runner 的启动失败会**先**把 `exit_code`
  // 兑现成 null，再走 `error` 通道。先排空一次微任务队列再判定，读到的才是
  // 稳定值。**不是**无界等待：一个 macrotask 边界即可。
  await drainMicrotasks();

  const failure = spawn_error as Error | null;
  if (failure === null && !exited) {
    // 仍未退出：认定超时，并在放弃前再补一次强杀。
    timed_out = true;
    // B12：先把**树级**强杀命令交出去再等关闭事件 —— 否则等的可能是个空。
    await Promise.resolve()
      .then(() => handle.kill("SIGKILL"))
      .catch(() => undefined);
    // 交出强杀信号后再给一个**有界**窗口观察关闭事件：SIGKILL 之后进程通常
    // 很快被回收，若此刻立刻判定，会把「刚被杀掉的进程」说成「状态未知」，
    // 白白让执行器停在人工门禁上。窗口是有限的，不能为等一个不响应的进程
    // 而无界阻塞。
    if (handle.closed !== undefined) {
      await Promise.race([
        handle.closed,
        new Promise<void>((resolve) => setTimeout(resolve, POST_KILL_GRACE_MS)),
      ]);
    }
  }

  // 启动失败时 stdout / stderr 可能永远不结束，**不能**等它们，
  // 否则上面刚修好的「尽快返回」会在这里重新挂住。
  const [stdout, stderr] =
    failure !== null
      ? (["", `子进程启动失败：${failure.message}`] as const)
      : await Promise.all([stdoutPromise, stderrPromise]);
  const exit_code = exited ? await exitPromise : null;

  /*
   * B11（A 端 B10 复验 §a）：进程状态由**可观测事实**判定，不由退出码反推。
   * B12（A 端 B11 复验 P1）：**观察到关闭不再等于已停止** —— 关闭事件只证明
   * 直接子进程关闭，它拉起的后代可能仍在写同一个 worktree。判定必须再问一次
   * 整棵受控树的存活情况（`probe_tree_alive`），树上有活口一律 `residual`。
   *
   * 走到这里仍「没观察到关闭」只剩一种情形：进程已启动、发过终止信号、
   * 却迟迟不退出（超时/取消路径）。此时只有主动探测明确答「还活着」才记
   * `residual`；问不到、或探到已不存在，一律 `unknown` —— 「探不到」与
   * 「已经退出」刻意分开，不能互相冒充。两种状态在常驻入口都会停机。
   */
  const process_state = await determineProcessState({
    spawn_failed: failure !== null,
    // 缺省 `closed` 通道的注入式 runner：以「退出码已兑现且非启动失败」近似。
    close_observed:
      handle.closed !== undefined ? close_observed : exited && failure === null,
    probe_tree: handle.probe_tree_alive,
    probe: handle.probe_alive,
  });

  const parsed = parseOpenCodeEvents(stdout);
  const classified = classifyOpenCodeFailure({
    structured: parsed.error,
    text: `${stderr}\n${stdout}`,
  });

  let status: OpenCodeAdapterStatus = "completed";
  let error_code: ErrorCode | null = null;

  if (failure !== null) {
    // 进程根本没起来 —— 不是「agent 干得不好」，而是执行环境缺少
    // 可执行文件。语义上与 `runner.start` 同步抛错的分支保持一致。
    status = classified?.status ?? "failed";
    error_code = classified?.error_code ?? "INTERNAL_ERROR";
  } else if (timed_out) {
    status = "failed";
    error_code = "AGENT_TIMEOUT";
  } else if (classified) {
    status = classified.status;
    error_code = classified.error_code;
  } else if (parsed.error) {
    // 有结构化错误但未归类：视为 agent 输出层失败
    status = "failed";
    error_code = "AGENT_INVALID_OUTPUT";
  } else if (parsed.invalid_json_lines > 0) {
    status = "failed";
    error_code = "AGENT_INVALID_OUTPUT";
  } else if (exit_code !== 0) {
    status = "failed";
    error_code = "AGENT_NONZERO_EXIT";
  }

  return {
    status,
    error_code,
    exit_code,
    timed_out,
    session_id: parsed.session_id,
    final_message: parsed.final_message,
    event_counts: parsed.event_counts,
    tokens: parsed.tokens,
    cost: parsed.cost,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    invalid_json_lines: parsed.invalid_json_lines,
    request_url: parsed.error?.url ?? null,
    launch_source,
    launch_detail,
    process_state,
  };
}
