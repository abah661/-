import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexExecArgs,
  codexChildEnvironment,
  resolveCodexLaunch,
  runCodexTask,
  type CodexProcess,
  type CodexProcessRunner,
} from "../../packages/codex-adapter/src/index.js";

async function* chunks(value: string): AsyncIterable<string> {
  yield value;
}

function fakeRunner(stdout: string, stderr = "", exitCode = 0): CodexProcessRunner {
  return {
    start: () => {
      const process: CodexProcess = {
        stdout: chunks(stdout),
        stderr: chunks(stderr),
        exit_code: Promise.resolve(exitCode),
        kill: () => undefined,
      };
      return process;
    },
  };
}

describe("Codex adapter", () => {
  it("Windows npm 包装器改用 node + JS 入口，参数不经过 shell", () => {
    const root = mkdtempSync(join(tmpdir(), "dac-codex-launch-"));
    const bin = join(root, "node_modules", "@openai", "codex", "bin");
    mkdirSync(bin, { recursive: true });
    const entry = join(bin, "codex.js");
    writeFileSync(entry, "// fixture\n");
    expect(resolveCodexLaunch("codex", ["exec", "--", "a & b"], "win32", root)).toEqual({
      executable: process.execPath, args: [entry, "exec", "--", "a & b"],
    });
    expect(() => resolveCodexLaunch("codex.cmd", [], "win32", root)).toThrow("shell");
  });
  it("不会把协调器和部署凭据继承给写代码的子进程", () => {
    const env = codexChildEnvironment({ PATH: "tools", COORDINATOR_API_TOKEN: "test-only",
      cloudflare_api_token: "test-only", GITHUB_TOKEN: "test-only", CODEX_HOME: "profile" });
    expect(env).toEqual({ PATH: "tools", CODEX_HOME: "profile" });
  });
  it("生成显式、可审计的 codex exec 参数", () => {
    expect(buildCodexExecArgs({ prompt: "执行任务", cwd: "E:/repo", sandbox: "workspace-write" })).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--",
      "执行任务",
    ]);
  });

  it.each(["", "null", "[]", "42", '{"type":"turn.failed","error":{"message":"failed"}}', '{"type":"turn.completed"}\n{"type":"turn.started"}'])
  ("不会把空、非对象或失败事件判为完成：%s", async (stdout) => {
    expect((await runCodexTask({ prompt: "x", cwd: "." }, {}, fakeRunner(stdout))).status).toBe("failed");
  });

  it("普通回复里的 quota/401 不冒充认证错误", async () => {
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "implemented quota and 401 handling" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect((await runCodexTask({ prompt: "x", cwd: "." }, {}, fakeRunner(stdout))).status).toBe("completed");
  });

  it("真实启动不存在的程序可返回失败，而不会触发未处理 error", async () => {
    const result = await runCodexTask({ prompt: "x", cwd: ".", timeout_ms: 1000 }, { executable: "dac-nonexistent-codex-binary-090925" });
    expect(result.status).toBe("failed");
  });

  it("真实原生子进程可以完成 JSONL 读取（不是模型调用）", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dac-codex-process-"));
    writeFileSync(join(cwd, "exec"), 'process.stdout.write(JSON.stringify({type:"turn.completed"})+"\\n");');
    const result = await runCodexTask({ prompt: "--danger-full-access", cwd, timeout_ms: 5000 }, { executable: process.execPath });
    expect(result).toMatchObject({ status: "completed", exit_code: 0, kill_failed: false });
  });

  it("进程和输出流永不结束时，在超时和两级宽限后返回", async () => {
    vi.useFakeTimers();
    try {
      const never = async function* (): AsyncIterable<string> { await new Promise(() => undefined); yield ""; };
      const kill = vi.fn();
      const run = runCodexTask({ prompt: "x", cwd: ".", timeout_ms: 20 }, { termination_grace_ms: 10 }, {
        start: () => ({ stdout: never(), stderr: never(), exit_code: new Promise(() => undefined), kill }),
      });
      await vi.advanceTimersByTimeAsync(41);
      expect(await run).toMatchObject({ status: "failed", error_code: "AGENT_TIMEOUT", timed_out: true, kill_failed: true, exit_code: null });
      expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("UTF-8 跨 chunk 不损坏中文", async () => {
    const bytes = Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"中文"}}\n{"type":"turn.completed"}');
    async function* split() { for (const byte of bytes) yield Buffer.from([byte]); }
    const result = await runCodexTask({ prompt: "x", cwd: "." }, {}, {
      start: () => ({ stdout: split(), stderr: chunks(""), exit_code: Promise.resolve(0), kill: () => undefined }),
    });
    expect(result.final_message).toBe("中文");
  });

  it("拒绝无效超时，避免 Node 计时器溢出", async () => {
    await expect(runCodexTask({ prompt: "x", cwd: ".", timeout_ms: Infinity }, {}, fakeRunner(""))).rejects.toThrow("timeout_ms");
  });

  it("解析 JSONL 完成事件，并只返回摘要与哈希", async () => {
    const result = await runCodexTask(
      { prompt: "执行任务", cwd: "E:/repo", sandbox: "workspace-write" },
      {},
      fakeRunner([
        JSON.stringify({ type: "thread.started", thread_id: "THREAD-001" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "已完成" } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")),
    );
    expect(result).toMatchObject({
      status: "completed",
      error_code: null,
      exit_code: 0,
      thread_id: "THREAD-001",
      final_message: "已完成",
      invalid_json_lines: 0,
    });
    expect(result.stdout_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.event_counts).toEqual({ "thread.started": 1, "item.completed": 1, "turn.completed": 1 });
  });

  it("把登录、非零退出和非法 JSON 分开归类", async () => {
    const auth = await runCodexTask(
      { prompt: "执行任务", cwd: "E:/repo" },
      {},
      fakeRunner(JSON.stringify({ type: "error", message: "authentication required" }), "", 1),
    );
    expect(auth).toMatchObject({ status: "blocked_auth", error_code: "AUTH_EXPIRED" });

    const invalid = await runCodexTask({ prompt: "执行任务", cwd: "E:/repo" }, {}, fakeRunner("not-json\n", "", 0));
    expect(invalid).toMatchObject({ status: "failed", error_code: "AGENT_INVALID_OUTPUT", invalid_json_lines: 1 });
  });
});
