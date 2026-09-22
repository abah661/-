/**
 * OpenCode 适配器测试（P2 分工表：B 端「OpenCode 适配器独立模块」）。
 *
 * 关键覆盖点：
 * 1. **模型必填**——不带 -m 会 401，因此必须在构造阶段就拒绝，而不是运行时才发现
 * 2. 参数数组形态与顺序（提示词必须是最后一个位置参数）
 * 3. `--format json` 事件流解析（step_start / text / step_finish）
 * 4. 结构化错误分类：401→blocked_auth、额度→blocked_quota、429→retryable
 *
 * 全部用**假运行器**驱动，不真的调用 opencode，保证测试确定且不烧配额。
 */

import { describe, expect, it } from "vitest";
import {
  buildOpenCodeRunArgs,
  classifyOpenCodeFailure,
  parseOpenCodeEvents,
  runOpenCodeTask,
} from "../../apps/executor/src/adapters/opencode.js";
import type { OpenCodeProcess, OpenCodeProcessRunner } from "../../apps/executor/src/adapters/opencode.js";

/* ------------------------------------------------------------------ *
 * 测试替身
 * ------------------------------------------------------------------ */

class FakeProcess implements OpenCodeProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exit_code: Promise<number | null>;
  killed = false;
  killSignals: NodeJS.Signals[] = [];

  constructor(out: string, err: string, code: number | null, private readonly resolvesOnKill = false) {
    this.stdout = (async function* () {
      yield out;
    })();
    this.stderr = (async function* () {
      yield err;
    })();
    if (resolvesOnKill) {
      // 模拟「收到终止信号后退出」：kill() 决定 exit_code
      this.exit_code = new Promise<number | null>((resolve) => {
        this.resolveExit = resolve;
      });
    } else {
      this.exit_code = Promise.resolve(code);
    }
  }

  private resolveExit: ((code: number | null) => void) | null = null;

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed = true;
    this.killSignals.push(signal);
    // 真实进程收到 SIGTERM 通常会退出；这里如实模拟，
    // 否则被测代码会一直等一个永不 resolve 的 exit_code。
    this.resolveExit?.(null);
  }
}

class FakeRunner implements OpenCodeProcessRunner {
  lastExecutable = "";
  lastArgs: readonly string[] = [];
  lastCwd = "";

  constructor(private readonly process: OpenCodeProcess) {}

  start(executable: string, args: readonly string[], cwd: string): OpenCodeProcess {
    this.lastExecutable = executable;
    this.lastArgs = args;
    this.lastCwd = cwd;
    return this.process;
  }
}

/** 本机实测捕获的真实事件流（2026-09-21，成功用例）。 */
const REAL_SUCCESS_STREAM = [
  '{"type":"step_start","timestamp":1789989620471,"sessionID":"ses_f3c4e03baffem2ZYsEeF8AFLTM","part":{"id":"prt_0c","type":"step-start"}}',
  '{"type":"text","timestamp":1789989627062,"sessionID":"ses_f3c4e03baffem2ZYsEeF8AFLTM","part":{"id":"prt_0c2","type":"text","text":"OK","metadata":{"openai":{"phase":"final_answer"}}}}',
  '{"type":"step_finish","timestamp":1789989627230,"sessionID":"ses_f3c4e03baffem2ZYsEeF8AFLTM","part":{"id":"prt_0c3","reason":"stop","type":"step-finish","tokens":{"total":6403,"input":6300,"output":11,"reasoning":92,"cache":{"write":0,"read":0}},"cost":0}}',
].join("\n");

/** 本机实测捕获的真实 401 错误流（不带 -m 时出现）。 */
const REAL_401_STREAM = [
  '{"type":"error","timestamp":1789989008817,"sessionID":"ses_f3c574eb3ffepJeoKld1mulo35","error":{"name":"APIError","data":{"message":"Invalid token (request id: 199)","statusCode":401,"isRetryable":false,"metadata":{"url":"https://codex.ai02.cn/v1/responses"}}}}',
].join("\n");

/* ------------------------------------------------------------------ *
 * 参数构造
 * ------------------------------------------------------------------ */

describe("buildOpenCodeRunArgs", () => {
  it("在缺少模型时硬失败，而不是退回默认值", () => {
    expect(() =>
      buildOpenCodeRunArgs({ prompt: "hi", cwd: ".", model: "" }),
    ).toThrow(/要求显式指定模型/);
  });

  it("始终包含 --format json 与 -m", () => {
    const args = buildOpenCodeRunArgs({
      prompt: "reply OK",
      cwd: "C:/tmp",
      model: "myapi/gpt-5.5",
    });
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe("json");
    expect(args).toContain("-m");
    expect(args[args.indexOf("-m") + 1]).toBe("myapi/gpt-5.5");
  });

  it("提示词作为最后一个参数且不被拆分为多项", () => {
    const prompt = "请修复 login 的 bug，注意 --dry-run 只是字面量";
    const args = buildOpenCodeRunArgs({ prompt, cwd: ".", model: "myapi/gpt-5.5" });
    expect(args[args.length - 1]).toBe(prompt);
    // 提示词里的 "--dry-run" 不得变成独立参数
    expect(args.filter((a) => a === "--dry-run")).toHaveLength(0);
  });

  it("默认不附加 --auto（执行器不默认放开权限）", () => {
    const args = buildOpenCodeRunArgs({ prompt: "x", cwd: ".", model: "m/x" });
    expect(args).not.toContain("--auto");
  });

  it("可在配置中显式开启 --auto", () => {
    const args = buildOpenCodeRunArgs({ prompt: "x", cwd: ".", model: "m/x" }, { auto_approve: true });
    expect(args).toContain("--auto");
  });

  it("拒绝含空格的模型标识", () => {
    expect(() => buildOpenCodeRunArgs({ prompt: "x", cwd: ".", model: "my api/gpt" })).toThrow(
      /模型标识非法/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 事件流解析
 * ------------------------------------------------------------------ */

describe("parseOpenCodeEvents", () => {
  it("解析真实成功流：文本、会话 ID、token 计量", () => {
    const parsed = parseOpenCodeEvents(REAL_SUCCESS_STREAM);
    expect(parsed.invalid_json_lines).toBe(0);
    expect(parsed.final_message).toBe("OK");
    expect(parsed.session_id).toBe("ses_f3c4e03baffem2ZYsEeF8AFLTM");
    expect(parsed.tokens).toEqual({ total: 6403, input: 6300, output: 11, reasoning: 92 });
    expect(parsed.cost).toBe(0);
    expect(parsed.error).toBeNull();
    expect(parsed.event_counts["step_start"]).toBe(1);
    expect(parsed.event_counts["text"]).toBe(1);
    expect(parsed.event_counts["step_finish"]).toBe(1);
  });

  it("解析真实 401 流：结构化错误字段完整", () => {
    const parsed = parseOpenCodeEvents(REAL_401_STREAM);
    expect(parsed.error).not.toBeNull();
    expect(parsed.error!.name).toBe("APIError");
    expect(parsed.error!.status_code).toBe(401);
    expect(parsed.error!.is_retryable).toBe(false);
    expect(parsed.error!.url).toBe("https://codex.ai02.cn/v1/responses");
  });

  it("容忍空行与噪音行，只把它们计入 invalid_json_lines", () => {
    const noisy = `\n  \nnot json at all\n${REAL_SUCCESS_STREAM}\n`;
    const parsed = parseOpenCodeEvents(noisy);
    expect(parsed.invalid_json_lines).toBe(1);
    expect(parsed.final_message).toBe("OK");
  });

  it("拼接多段 text 事件", () => {
    const stream = [
      '{"type":"text","part":{"type":"text","text":"你"}}',
      '{"type":"text","part":{"type":"text","text":"好"}}',
    ].join("\n");
    expect(parseOpenCodeEvents(stream).final_message).toBe("你好");
  });

  it("未知事件类型只计数、不抛错", () => {
    const parsed = parseOpenCodeEvents('{"type":"some.future.event","x":1}');
    expect(parsed.event_counts["some.future.event"]).toBe(1);
    expect(parsed.invalid_json_lines).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 错误分类（第 8 节 / §193：登录与配额必须分别标记）
 * ------------------------------------------------------------------ */

describe("classifyOpenCodeFailure", () => {
  it("401 归类为凭据阻塞，而不是代码失败", () => {
    const result = classifyOpenCodeFailure({
      structured: { name: "APIError", message: "Invalid token", status_code: 401, is_retryable: false, url: null },
      text: "",
    });
    expect(result).toEqual({ status: "blocked_auth", error_code: "AUTH_EXPIRED" });
  });

  it("限额文案归类为配额阻塞", () => {
    const result = classifyOpenCodeFailure({
      structured: null,
      text: "insufficient credits, please top up",
    });
    expect(result).toEqual({ status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" });
  });

  it("429 归类为可重试限流", () => {
    const result = classifyOpenCodeFailure({
      structured: { name: "APIError", message: "too many requests", status_code: 429, is_retryable: true, url: null },
      text: "",
    });
    expect(result).toEqual({ status: "retryable", error_code: "RATE_LIMITED" });
  });

  it("普通错误不误分类（交由退出码判定）", () => {
    expect(classifyOpenCodeFailure({ structured: null, text: "TypeError: x is not a function" })).toBeNull();
  });

  it("退出码 402 也判为配额问题", () => {
    const result = classifyOpenCodeFailure({
      structured: { name: "APIError", message: "", status_code: 402, is_retryable: false, url: null },
      text: "",
    });
    expect(result?.error_code).toBe("QUOTA_EXHAUSTED");
  });
});

/* ------------------------------------------------------------------ *
 * 端到端（假进程）
 * ------------------------------------------------------------------ */

describe("runOpenCodeTask", () => {
  it("成功流 → completed，且保留 token 计量", async () => {
    const runner = new FakeRunner(new FakeProcess(REAL_SUCCESS_STREAM, "", 0));
    const result = await runOpenCodeTask(
      { prompt: "reply with exactly: OK", cwd: "C:/tmp", model: "myapi/gpt-5.5" },
      {},
      runner,
    );
    expect(result.status).toBe("completed");
    expect(result.error_code).toBeNull();
    expect(result.final_message).toBe("OK");
    expect(result.tokens?.total).toBe(6403);
    expect(result.exit_code).toBe(0);
    expect(runner.lastArgs).toEqual([
      "run",
      "--format",
      "json",
      "-m",
      "myapi/gpt-5.5",
      "reply with exactly: OK",
    ]);
  });

  it("401 流 → blocked_auth 且带 request_url 诊断线索", async () => {
    const runner = new FakeRunner(new FakeProcess(REAL_401_STREAM, "", 1));
    const result = await runOpenCodeTask(
      { prompt: "hi", cwd: "C:/tmp", model: "myapi/gpt-5.5" },
      {},
      runner,
    );
    expect(result.status).toBe("blocked_auth");
    expect(result.error_code).toBe("AUTH_EXPIRED");
    expect(result.request_url).toBe("https://codex.ai02.cn/v1/responses");
  });

  it("输出非 JSON → AGENT_INVALID_OUTPUT", async () => {
    const runner = new FakeRunner(new FakeProcess("plain text, no json", "", 0));
    const result = await runOpenCodeTask({ prompt: "hi", cwd: ".", model: "m/x" }, {}, runner);
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("AGENT_INVALID_OUTPUT");
  });

  it("退出码非零且无结构化错误 → AGENT_NONZERO_EXIT", async () => {
    const runner = new FakeRunner(new FakeProcess(REAL_SUCCESS_STREAM, "", 2));
    const result = await runOpenCodeTask({ prompt: "hi", cwd: ".", model: "m/x" }, {}, runner);
    expect(result.status).toBe("failed");
    expect(result.error_code).toBe("AGENT_NONZERO_EXIT");
  });

  it("无法启动进程 → INTERNAL_ERROR 而非崩溃", async () => {
    const failing: OpenCodeProcessRunner = {
      start() {
        throw new Error("spawn opencode ENOENT");
      },
    };
    const result = await runOpenCodeTask({ prompt: "hi", cwd: ".", model: "m/x" }, {}, failing);
    expect(result.error_code).toBe("INTERNAL_ERROR");
    expect(result.exit_code).toBeNull();
  });

  it("超时 → AGENT_TIMEOUT 且发出终止信号", async () => {
    // resolvesOnKill: 收到 SIGTERM 后退出，模拟真实进程行为
    const proc = new FakeProcess("", "", null, true);
    const runner = new FakeRunner(proc);
    const result = await runOpenCodeTask(
      { prompt: "hi", cwd: ".", model: "m/x", timeout_ms: 20 },
      {},
      runner,
    );
    expect(result.timed_out).toBe(true);
    expect(result.error_code).toBe("AGENT_TIMEOUT");
    expect(proc.killed).toBe(true);
    expect(proc.killSignals).toContain("SIGTERM");
  });

  it("进程无视终止信号也会放弃等待，不会永久阻塞", async () => {
    // 这个假进程永远不退出：验证适配器有兜底而非无限 await
    const proc = new FakeProcess("", "", null, true);
    proc.kill = (signal: NodeJS.Signals = "SIGTERM") => {
      proc.killSignals.push(signal);
      // 刻意不 resolve exit_code
    };
    const runner = new FakeRunner(proc);
    const result = await runOpenCodeTask(
      { prompt: "hi", cwd: ".", model: "m/x", timeout_ms: 20 },
      {},
      runner,
    );
    expect(result.timed_out).toBe(true);
    expect(result.error_code).toBe("AGENT_TIMEOUT");
    expect(result.exit_code).toBeNull();
  }, 20_000);

  it("stdout/stderr 均给出 SHA-256 指纹", async () => {
    const runner = new FakeRunner(new FakeProcess(REAL_SUCCESS_STREAM, "warn", 0));
    const result = await runOpenCodeTask({ prompt: "x", cwd: ".", model: "m/x" }, {}, runner);
    expect(result.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stderr_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stdout_sha256).not.toBe(result.stderr_sha256);
  });
});
