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
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ErrorCode } from "@dac/protocol";

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
  /** 附加文件（`--file`），供上下文注入 */
  files?: readonly string[];
  /** 使用的 agent 名称（`--agent`），可选 */
  agent?: string;
}

export interface OpenCodeAdapterConfig {
  /** opencode 可执行文件；默认 `opencode` */
  executable?: string;
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
  kill(signal?: NodeJS.Signals): void;
}

export interface OpenCodeProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): OpenCodeProcess;
}

class NodeOpenCodeProcessRunner implements OpenCodeProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): OpenCodeProcess {
    const child: ChildProcess = spawn(executable, [...args], {
      cwd,
      // 参数数组隔离的前提：不经 shell
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: child.stdout!,
      stderr: child.stderr!,
      exit_code: new Promise((resolve) => child.once("close", (code) => resolve(code))),
      kill: (signal = "SIGTERM") => child.kill(signal),
    };
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
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 超时后再等这么久就放弃等待退出码（避免被不响应的进程永久阻塞）。 */
const KILL_GRACE_MS = 5_000;

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
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
  const args = buildOpenCodeRunArgs(input, config);

  let handle: OpenCodeProcess;
  try {
    handle = runner.start(config.executable ?? "opencode", args, input.cwd);
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
    };
  }

  let timed_out = false;
  const timeout = input.timeout_ms ?? config.default_timeout_ms ?? 1_800_000;

  // 收集输出但不无限等待退出：超时后即使进程不理会终止信号，
  // 也必须让本函数返回，否则整套执行流程会卡死。
  const stdoutPromise = collect(handle.stdout);
  const stderrPromise = collect(handle.stderr);
  const exitPromise = handle.exit_code;

  let exited = false;
  const exitedPromise = exitPromise.then(() => {
    exited = true;
  });

  const killTimer = setTimeout(() => {
    timed_out = true;
    handle.kill("SIGTERM");
  }, timeout);

  await Promise.race([
    exitedPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeout + KILL_GRACE_MS)),
  ]);
  clearTimeout(killTimer);
  if (!exited) {
    // 仍未退出：认定超时，并在放弃前再补一次强杀。
    timed_out = true;
    handle.kill("SIGKILL");
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const exit_code = exited ? await exitPromise : null;

  const parsed = parseOpenCodeEvents(stdout);
  const classified = classifyOpenCodeFailure({
    structured: parsed.error,
    text: `${stderr}\n${stdout}`,
  });

  let status: OpenCodeAdapterStatus = "completed";
  let error_code: ErrorCode | null = null;

  if (timed_out) {
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
  };
}
