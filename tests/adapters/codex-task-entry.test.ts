import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Lease, TaskNode } from "@dac/protocol";
import { buildCodexExecArgs, runCodexTask } from "../../packages/codex-adapter/src/index.js";
import {
  buildAReport, detachCoordinatorToken, gateDisplayEntrypoint, loadATaskOptions, localPreflight,
  taskPrompt, validateLeasedTask, verifyCodexWriteProbe,
} from "../../packages/codex-adapter/src/task-entry.js";

const base = "a9434a87f6f2513e7c32185a8f9a6e365162e253";
const lease: Lease = {
  task_id: "TASK-1002", attempt_id: "TASK-1002-A1", executor_id: "EXE-A-TEST",
  lease_epoch: 1, expires_at: "2030-01-01T00:00:00Z", agent_kind: "codex",
  binding: { base_sha: base, rules_sha: base, contract_sha: base, acceptance_sha: base },
};
const task: TaskNode = {
  task_id: "TASK-1002", kind: "implement", title: "实现展示模块", status: "leased",
  acceptance_criteria: ["Ada (u-1)"], depends_on: [],
  write_scope: { allow: ["src/display/**", "tests/display/**"],
    deny: ["src/provider/**", "acceptance/**", "contracts/**"] },
  contracts: [], requires: ["code", "test", "git_push"], expected_interfaces: [],
  assigned_executor: "EXE-A-TEST", attempts_used: 1,
};
const env = {
  COORDINATOR_BASE_URL: "https://example.test", COORDINATOR_API_TOKEN: "fixture-only",
  PROJECT_ID: "demo-user-profile-p3", EXECUTOR_ID: "EXE-A-TEST",
  TARGET_REPO_ROOT: "E:/fixture", TARGET_REPO_URL: "https://github.com/hdsakj-sudo/first-one.git",
  EXPECTED_BASE_SHA: base, NODE22_PATH: "E:/node22.exe", TASK_ID: "TASK-1002",
};

describe("A 端 Codex 单任务门禁", () => {
  it("缺配置一次列全，且未显式准许 push 时不领取", () => {
    expect(() => loadATaskOptions({}, [])).toThrow("COORDINATOR_BASE_URL");
    expect(() => loadATaskOptions(env, [])).toThrow("--push");
  });
  it("HTTP token 载入后从子进程环境移除，受限写入探针必须有真实文件", () => {
    const runtime = { ...env };
    const options = loadATaskOptions(runtime, ["--push"]);
    detachCoordinatorToken(runtime);
    expect(runtime.COORDINATOR_API_TOKEN).toBeUndefined();
    expect(options.coordinator_token).toBe("fixture-only");
    const completed = { status: "completed", kill_failed: false, aborted: false } as const;
    expect(() => verifyCodexWriteProbe(completed,
      "Z:/codex-probe-definitely-not-created.txt", "expected\n")).toThrow("未领取任务");
    const knownFile = fileURLToPath(new URL("../../AGENTS.md", import.meta.url));
    expect(() => verifyCodexWriteProbe(completed, knownFile, "incorrect\n")).toThrow("未领取任务");
    expect(() => verifyCodexWriteProbe(completed, knownFile, readFileSync(knownFile, "utf8"))).not.toThrow();
  });
  it("授权表不会被参数扩展到别的任务或仓库", () => {
    expect(() => loadATaskOptions({ ...env, TASK_ID: "TASK-1001" }, ["--push"])).toThrow("AUTH-0007");
    expect(() => loadATaskOptions({ ...env, TARGET_REPO_URL: "https://github.com/other/repo" }, ["--push"])).toThrow("AUTH-0007");
    expect(() => localPreflight({ ...loadATaskOptions(env, ["--push"]), push_authorized: false })).toThrow("授权");
  });
  it("TASK-1004 仅允许独立回归项目，不借用 P3 原项目或别的分支授权", () => {
    const regression = { ...env, TASK_ID: "TASK-1004", PROJECT_ID: "a-codex-regression-20261008" };
    expect(loadATaskOptions(regression, ["--push"]).task_id).toBe("TASK-1004");
    expect(() => loadATaskOptions({ ...regression, PROJECT_ID: env.PROJECT_ID }, ["--push"])).toThrow("隔离项目");
    expect(() => loadATaskOptions({ ...env, PROJECT_ID: regression.PROJECT_ID }, ["--push"])).toThrow("隔离项目");
    expect(() => loadATaskOptions({ ...regression, TARGET_REPO_URL: "https://github.com/other/repo" }, ["--push"])).toThrow("隔离项目");
    expect(() => localPreflight({ ...loadATaskOptions(regression, ["--push"]), push_authorized: false })).toThrow("授权");
  });
  it("可显式选择本机已安装的独立 Codex JS 入口，不修改全局配置", () => {
    const options = loadATaskOptions({ ...env, CODEX_EXECUTABLE: "E:/tools/codex.js" }, ["--push"]);
    expect(options.codex.executable).toMatch(/codex\.js$/);
  });
  it("任务和冻结版本必须与 A 身份及 display 写入范围一致", () => {
    const options = { task_id: "TASK-1002", executor_id: "EXE-A-TEST", expected_base_sha: base };
    expect(() => validateLeasedTask(task, lease, options)).not.toThrow();
    expect(() => validateLeasedTask({ ...task, write_scope: { allow: ["src/provider/**", "tests/display/**"], deny: [] } }, lease, options)).toThrow("写入范围");
    expect(() => validateLeasedTask(task, { ...lease, agent_kind: "opencode" }, options)).toThrow("身份");
    expect(() => validateLeasedTask(task, { ...lease, binding: { ...lease.binding, acceptance_sha: "b".repeat(40) } }, options)).toThrow("冻结版本");
  });
  it("提示词只包含任务边界，不让 agent 代替执行器推送", () => {
    const prompt = taskPrompt(task, lease);
    expect(prompt).toContain("不要自行 git commit/push/merge");
    expect(prompt).toContain("src/display/**");
    expect(prompt).toContain("src/display/render-user.js");
    expect(prompt).not.toContain("fixture-only");
  });
  it("自测通过但缺少冻结组合验收入口时禁止提交并请求返修", () => {
    const ready = { status: "ready_for_integration", code: null } as const;
    expect(gateDisplayEntrypoint(ready, false)).toEqual({ status: "repair_pending", code: "AGENT_INVALID_OUTPUT" });
    expect(gateDisplayEntrypoint(ready, true)).toEqual(ready);
    const blocked = { status: "blocked_auth", code: "AUTH_EXPIRED" } as const;
    expect(gateDisplayEntrypoint(blocked, false)).toEqual(blocked);
  });
  it("协议报告需要真实提交、绿测证据；失败不能伪装成功", () => {
    const evidence = { evidence_id: "EVID-TASK-1002-A1-1", command: ["node", "--test"],
      exit_code: 0, summary: { passed: 3, failed: 0, skipped: 0 }, log_artifact: null, output_sha256: "f".repeat(64) };
    expect(() => buildAReport({ lease, status: "ready_for_integration", code: null,
      head_sha: base, changed_files: [], evidence })).toThrow();
    const result = buildAReport({ lease, status: "ready_for_integration", code: null,
      head_sha: "b".repeat(40), changed_files: ["src/display/user.js"], evidence });
    expect(result.status).toBe("ready_for_integration");
    expect(result.commit_shas).toEqual(["b".repeat(40)]);
    expect(buildAReport({ lease, status: "blocked_auth", code: "AUTH_EXPIRED",
      head_sha: base, changed_files: [], evidence: null }).status).toBe("blocked_auth");
  });
  it("旧 CLI 配置可通过显式安全枚举覆盖，不修改用户配置", () => {
    expect(buildCodexExecArgs({ prompt: "x", cwd: "E:/repo" }, { reasoning_effort: "high" }).slice(0, 4))
      .toEqual(["-c", "model_reasoning_effort=high", "exec", "--json"]);
  });
  it("丢租约触发取消时会停 agent；未观察到退出不能声称已停", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const never = async function* () { await new Promise(() => undefined); yield ""; };
      const kill = vi.fn();
      const run = runCodexTask({ prompt: "x", cwd: ".", signal: controller.signal, timeout_ms: 1000 },
        { termination_grace_ms: 10 }, { start: () => ({ stdout: never(), stderr: never(),
          exit_code: new Promise(() => undefined), kill }) });
      controller.abort();
      await vi.advanceTimersByTimeAsync(21);
      expect(await run).toMatchObject({ status: "failed", aborted: true, kill_failed: true });
      expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    } finally { vi.useRealTimers(); }
  });
});
