import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import type { ErrorCode } from "@dac/protocol";

export type CodexSandbox = "read-only" | "workspace-write";

export interface CodexTaskInput {
  prompt: string;
  cwd: string;
  sandbox?: CodexSandbox;
  timeout_ms?: number;
}

export interface CodexAdapterConfig {
  executable?: string;
  default_sandbox?: CodexSandbox;
  default_timeout_ms?: number;
  ephemeral?: boolean;
  termination_grace_ms?: number;
}

export interface CodexProcess {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  exit_code: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  dispose?(): void;
}

export interface CodexProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): CodexProcess;
}

export type CodexAdapterStatus = "completed" | "failed" | "blocked_auth" | "blocked_quota" | "retryable";

export interface CodexAdapterResult {
  status: CodexAdapterStatus;
  error_code: ErrorCode | null;
  exit_code: number | null;
  timed_out: boolean;
  kill_failed: boolean;
  thread_id: string | null;
  final_message: string | null;
  event_counts: Readonly<Record<string, number>>;
  stdout_sha256: string;
  stderr_sha256: string;
  invalid_json_lines: number;
}

export function buildCodexExecArgs(input: CodexTaskInput, config: CodexAdapterConfig = {}): string[] {
  const sandbox = input.sandbox ?? config.default_sandbox ?? "read-only";
  const args = ["exec", "--json"];
  if (config.ephemeral ?? true) args.push("--ephemeral");
  args.push("--sandbox", sandbox, "--", input.prompt);
  return args;
}

export function codexChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(COORDINATOR_API_TOKEN|COORDINATOR_EXECUTOR_TOKENS_JSON|GH_TOKEN|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|CLOUDFLARE_.+|CF_API_KEY|CF_API_TOKEN)$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

export function resolveCodexLaunch(executable: string, args: readonly string[],
  platform: NodeJS.Platform = process.platform, pathValue = process.env.PATH ?? "") {
  const file = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
  if (/\.(cmd|bat|ps1)$/i.test(executable)) {
    throw new Error("Codex 必须用原生可执行文件或 codex.js 启动，不能通过 shell 包装器");
  }
  if (/\.m?js$/i.test(executable)) {
    if (!isAbsolute(executable) || !file(executable)) throw new Error("Codex JS 入口必须是存在的绝对路径");
    return { executable: process.execPath, args: [executable, ...args] };
  }
  if (platform === "win32" && executable === "codex") {
    for (const entry of pathValue.split(";").filter(Boolean)) {
      if (!isAbsolute(entry)) continue;
      const native = join(entry, "codex.exe");
      if (file(native)) return { executable: resolve(native), args: [...args] };
      const script = join(entry, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (file(script)) return { executable: process.execPath, args: [resolve(script), ...args] };
    }
    throw new Error("未找到 Codex 原生程序或 npm 的 codex.js，请提供本机绝对入口路径");
  }
  return { executable, args: [...args] };
}

class NodeCodexProcessRunner implements CodexProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): CodexProcess {
    const launch = resolveCodexLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: codexChildEnvironment(process.env),
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exit_code: new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      }),
      kill: (signal = "SIGTERM") => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])],
            { shell: false, windowsHide: true, stdio: "ignore", timeout: 1_000 });
          killer.once("error", () => undefined);
          killer.unref();
        } else {
          try { process.kill(-child.pid, signal); }
          catch { child.kill(signal); }
        }
      },
      dispose: () => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      },
    };
  }
}

function collector(stream: AsyncIterable<Uint8Array | string>) {
  const chunks: Buffer[] = [];
  let size = 0;
  const done = (async () => {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) throw new Error("Codex output limit exceeded");
      chunks.push(bytes);
    }
  })();
  return { done, text: () => Buffer.concat(chunks).toString("utf8") };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function classifyText(value: string): { status: CodexAdapterStatus; error_code: ErrorCode } | null {
  if (/(not authenticated|authentication required|unauthorized|token expired|please log in|\b401\b)/i.test(value)) {
    return { status: "blocked_auth", error_code: "AUTH_EXPIRED" };
  }
  if (/(quota|insufficient credits|billing limit|credit limit)/i.test(value)) {
    return { status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" };
  }
  if (/(rate limit|too many requests|\b429\b)/i.test(value)) {
    return { status: "retryable", error_code: "RATE_LIMITED" };
  }
  return null;
}

function parseJsonLines(stdout: string): {
  events: Array<Record<string, unknown>>;
  invalid_json_lines: number;
  thread_id: string | null;
  final_message: string | null;
  event_counts: Record<string, number>;
} {
  const events: Array<Record<string, unknown>> = [];
  let invalid_json_lines = 0;
  let thread_id: string | null = null;
  let final_message: string | null = null;
  const event_counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
        invalid_json_lines += 1;
        continue;
      }
    } catch {
      invalid_json_lines += 1;
      continue;
    }
    events.push(event);
    const type = typeof event.type === "string" ? event.type : "unknown";
    event_counts[type] = (event_counts[type] ?? 0) + 1;
    if (type === "thread.started" && typeof event.thread_id === "string") thread_id = event.thread_id;
    const item = event.item;
    if (type === "item.completed" && item && typeof item === "object") {
      const itemRecord = item as Record<string, unknown>;
      if (itemRecord.type === "agent_message" && typeof itemRecord.text === "string") final_message = itemRecord.text;
    }
  }
  return { events, invalid_json_lines, thread_id, final_message, event_counts };
}

export async function runCodexTask(
  input: CodexTaskInput,
  config: CodexAdapterConfig = {},
  runner: CodexProcessRunner = new NodeCodexProcessRunner(),
): Promise<CodexAdapterResult> {
  const args = buildCodexExecArgs(input, config);
  const timeout = input.timeout_ms ?? config.default_timeout_ms ?? 1_800_000;
  const grace = config.termination_grace_ms ?? 1_000;
  if (![timeout, grace].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error("timeout_ms 和 termination_grace_ms 必须是正整数且不超过 2147483647");
  }
  let processHandle: CodexProcess;
  try {
    processHandle = runner.start(config.executable ?? "codex", args, input.cwd);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const classified = classifyText(text);
    return {
      status: classified?.status ?? "failed",
      error_code: classified?.error_code ?? "INTERNAL_ERROR",
      exit_code: null,
      timed_out: false,
      kill_failed: false,
      thread_id: null,
      final_message: null,
      event_counts: {},
      stdout_sha256: sha256(""),
      stderr_sha256: sha256(text),
      invalid_json_lines: 0,
    };
  }

  const output = collector(processHandle.stdout);
  const errors = collector(processHandle.stderr);
  let exit_code: number | null = null;
  let exited = false;
  const exit = processHandle.exit_code.then((code) => { exit_code = code; exited = true; });
  const completion = Promise.all([output.done, errors.done, exit]).then(
    () => "done" as const,
    () => "error" as const,
  );
  async function wait(ms: number): Promise<"done" | "error" | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([completion, new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  const outcome = await wait(timeout);
  const timed_out = outcome === "timeout";
  if (outcome !== "done") {
    try { processHandle.kill("SIGTERM"); } catch { /* 强杀和失败分类仍须执行 */ }
    // error 已经 settled；不因流提前失败而认为子进程已结束。
    if (outcome === "error" || await wait(grace) !== "done") {
      try { processHandle.kill("SIGKILL"); } catch { /* 返回失败，不再无界等待 */ }
      if (outcome !== "error") await wait(grace);
    }
  }
  const kill_failed = outcome !== "done" && !exited;
  try { processHandle.dispose?.(); } catch { /* 资源释放失败不能变为成功 */ }
  const stdout = output.text();
  const stderr = errors.text();

  const parsed = parseJsonLines(stdout);
  const failureEvents = parsed.events.filter((event) => event.type === "error" || event.type === "turn.failed");
  const finalTurn = parsed.events.filter((event) => ["turn.started", "turn.completed", "turn.failed"].includes(String(event.type))).at(-1);
  const classified = classifyText(`${stderr}\n${failureEvents.map((event) => JSON.stringify(event)).join("\n")}`);
  let status: CodexAdapterStatus = "completed";
  let error_code: ErrorCode | null = null;
  if (timed_out) {
    status = "failed";
    error_code = "AGENT_TIMEOUT";
  } else if (outcome === "error") {
    status = "failed";
    error_code = "INTERNAL_ERROR";
  } else if (classified && (exit_code !== 0 || failureEvents.length > 0)) {
    status = classified.status;
    error_code = classified.error_code;
  } else if (parsed.invalid_json_lines > 0) {
    status = "failed";
    error_code = "AGENT_INVALID_OUTPUT";
  } else if (exit_code !== 0) {
    status = "failed";
    error_code = "AGENT_NONZERO_EXIT";
  } else if (failureEvents.length > 0 || finalTurn?.type !== "turn.completed") {
    status = "failed";
    error_code = "AGENT_INVALID_OUTPUT";
  }
  return {
    status,
    error_code,
    exit_code,
    timed_out,
    kill_failed,
    thread_id: parsed.thread_id,
    final_message: parsed.final_message,
    event_counts: parsed.event_counts,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    invalid_json_lines: parsed.invalid_json_lines,
  };
}
