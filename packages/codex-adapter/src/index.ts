import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
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
}

export interface CodexProcess {
  stdout: AsyncIterable<Uint8Array | string>;
  stderr: AsyncIterable<Uint8Array | string>;
  exit_code: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
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
  args.push("--sandbox", sandbox, input.prompt);
  return args;
}

class NodeCodexProcessRunner implements CodexProcessRunner {
  start(executable: string, args: readonly string[], cwd: string): CodexProcess {
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exit_code: new Promise((resolve) => child.once("close", (code) => resolve(code ?? 1))),
      kill: (signal = "SIGTERM") => child.kill(signal),
    };
  }
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  return chunks.join("");
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
  const event_counts: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      invalid_json_lines += 1;
      continue;
    }
    events.push(event);
    const type = typeof event.type === "string" ? event.type : "unknown";
    event_counts[type] = (event_counts[type] ?? 0) + 1;
    if (type === "thread.started" && typeof event.thread_id === "string") thread_id = event.thread_id;
    const item = event.item;
    if (item && typeof item === "object") {
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
      thread_id: null,
      final_message: null,
      event_counts: {},
      stdout_sha256: sha256(""),
      stderr_sha256: sha256(text),
      invalid_json_lines: 0,
    };
  }

  let timed_out = false;
  const timeout = input.timeout_ms ?? config.default_timeout_ms ?? 1_800_000;
  const timeoutHandle = setTimeout(() => {
    timed_out = true;
    processHandle.kill("SIGTERM");
  }, timeout);
  const [stdout, stderr, exit_code] = await Promise.all([
    collect(processHandle.stdout),
    collect(processHandle.stderr),
    processHandle.exit_code,
  ]);
  clearTimeout(timeoutHandle);

  const parsed = parseJsonLines(stdout);
  const classified = classifyText(`${stderr}\n${stdout}`);
  let status: CodexAdapterStatus = "completed";
  let error_code: ErrorCode | null = null;
  if (timed_out) {
    status = "failed";
    error_code = "AGENT_TIMEOUT";
  } else if (classified) {
    status = classified.status;
    error_code = classified.error_code;
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
    thread_id: parsed.thread_id,
    final_message: parsed.final_message,
    event_counts: parsed.event_counts,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    invalid_json_lines: parsed.invalid_json_lines,
  };
}
