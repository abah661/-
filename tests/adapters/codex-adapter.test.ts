import { describe, expect, it } from "vitest";
import {
  buildCodexExecArgs,
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
  it("生成显式、可审计的 codex exec 参数", () => {
    expect(buildCodexExecArgs({ prompt: "执行任务", cwd: "E:/repo", sandbox: "workspace-write" })).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "执行任务",
    ]);
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
