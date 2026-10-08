import { describe, expect, it } from "vitest";
import {
  BatchConclusionRequestSchema,
  ExecutorRegistrationSchema,
  IntegrationBatchSchema,
  ResultReportSchema,
  TaskGraphSchema,
} from "@dac/protocol";
import { applyVerifiedBatchConclusion, type ServerVerifiedBatchObservation } from
  "../../apps/coordinator/src/batch-conclusion.js";
import { emptyProjectState } from "../../apps/coordinator/src/storage.js";

const binding = {
  base_sha: "1".repeat(40),
  rules_sha: "2".repeat(40),
  contract_sha: "3".repeat(40),
  acceptance_sha: "4".repeat(40),
};
const workflow = `.github/workflows/integration.yml@${"a".repeat(40)}`;

function fixture(count = 1, attempts = 1) {
  const state = emptyProjectState("PROJECT-TEST");
  const heads = Array.from({ length: count }, (_, index) => String(index + 5).repeat(40));
  state.graph = TaskGraphSchema.parse({
    protocol_version: "1", project_id: state.project_id, requirement_ref: "req",
    created_at: "2026-10-08T00:00:00.000Z", binding,
    tasks: heads.map((head, index) => ({
      task_id: `TASK-${String(index + 1).padStart(4, "0")}`, kind: "implement", title: `任务 ${index + 1}`,
      acceptance_criteria: ["固定验收通过"], depends_on: [],
      write_scope: { allow: [`src/${index + 1}/**`], deny: [] }, contracts: [],
      requires: ["code"], expected_interfaces: [], status: "integrating", assigned_executor: null,
      attempts_used: attempts, head,
    })),
  });
  const registration = ExecutorRegistrationSchema.parse({
    protocol_version: "1", executor_id: "EXE-A-TEST", host_label: "A",
    agent_kind: "codex", capabilities: ["code"], tool_versions: { codex: "test" },
    project_root: "E:/test", registered_at: "2026-10-08T00:00:00.000Z",
  });
  state.executors[registration.executor_id] = registration;
  for (const [index, head] of heads.entries()) {
    const taskId = `TASK-${String(index + 1).padStart(4, "0")}`;
    state.reports[taskId] = ResultReportSchema.parse({
      protocol_version: "1", task_id: taskId, attempt_id: `${taskId}-A${attempts}`,
      executor_id: registration.executor_id, lease_epoch: attempts, agent_kind: "codex", ...binding,
      head_sha: head, status: "ready_for_integration", evidence_id: `EV-${index + 1}`,
      evidence: { evidence_id: `EV-${index + 1}`, command: ["npm", "test"], exit_code: 0,
        summary: { passed: 1, failed: 0, skipped: 0 } },
      commit_shas: [head], changed_files: [`src/${index + 1}/a.ts`], error_code: null,
      reported_at: "2026-10-08T00:01:00.000Z",
    });
  }
  const batch = IntegrationBatchSchema.parse({
    batch_id: "BATCH-0001", project_id: state.project_id, ...binding,
    candidate_heads: heads, trusted_workflow: workflow, created_at: "2026-10-08T00:02:00.000Z",
    conclusion: "pending", ci_run_id: null, merged_sha: null, tree_sha: null,
  });
  state.batches[batch.batch_id] = batch;
  const request = BatchConclusionRequestSchema.parse({
    protocol_version: "1", project_id: state.project_id, batch_id: batch.batch_id,
    candidate_heads: heads, conclusion: "failed", error_code: "TESTS_FAILED",
    affected_task_ids: [state.graph.tasks[0]!.task_id], github_run_id: "42", idempotency_key: "conclude-1",
  });
  const observation: ServerVerifiedBatchObservation = {
    batch_id: batch.batch_id, project_id: state.project_id, candidate_heads: heads,
    ...binding, trusted_workflow: workflow, ci_run_id: "42", conclusion: "failure",
    merged_sha: "c".repeat(40), tree_sha: "d".repeat(40),
    affected_task_ids: [...request.affected_task_ids], evidence: null,
  };
  return { state, request, observation, batch, heads };
}

describe("CP-0002 可信批次结论状态事务", () => {
  it("单候选失败：保留旧报告并将任务回流 ready，下一次租约才递增 attempt", () => {
    const { state, request, observation } = fixture();
    const receipt = applyVerifiedBatchConclusion(state, request, observation);
    expect(receipt).toMatchObject({ conclusion: "failed", task_statuses: { "TASK-0001": "ready" } });
    expect(state.graph!.tasks[0]!.attempts_used).toBe(1);
    expect(state.reports["TASK-0001"]!.attempt_id).toBe("TASK-0001-A1");
    expect(state.batches["BATCH-0001"]!.conclusion).toBe("failed");
  });

  it("双候选只返修有独立归因者，另一候选从 integrating 回待整合", () => {
    const { state, request, observation } = fixture(2);
    const receipt = applyVerifiedBatchConclusion(state, request, observation);
    expect(receipt.task_statuses).toEqual({ "TASK-0001": "ready", "TASK-0002": "ready_for_integration" });
  });

  it("归因不清或非代码故障时全部停 needs_input，不猜测谁负责", () => {
    const { state, request, observation } = fixture(2);
    const unknown = BatchConclusionRequestSchema.parse({ ...request, error_code: "INTERNAL_ERROR", affected_task_ids: [] });
    observation.affected_task_ids = [];
    const receipt = applyVerifiedBatchConclusion(state, unknown, observation);
    expect(Object.values(receipt.task_statuses)).toEqual(["needs_input", "needs_input"]);
  });

  it("superseded 将所有 integrating 候选安全收口，不遗留卡住的任务", () => {
    const { state, request } = fixture(2);
    const superseded = BatchConclusionRequestSchema.parse({ ...request, conclusion: "superseded",
      error_code: null, affected_task_ids: [], github_run_id: null });
    const receipt = applyVerifiedBatchConclusion(state, superseded, null);
    expect(receipt.conclusion).toBe("superseded");
    expect(Object.values(receipt.task_statuses)).toEqual(["needs_input", "needs_input"]);
  });

  it("超过返修上限留在 repair_pending，不产生 A4", () => {
    const { state, request, observation } = fixture(1, 3);
    const receipt = applyVerifiedBatchConclusion(state, request, observation);
    expect(receipt.task_statuses["TASK-0001"]).toBe("repair_pending");
    expect(state.graph!.tasks[0]!.attempts_used).toBe(3);
  });

  it("通过必须有独立 CI/Git 与实际整合证据；不凭自报通过", () => {
    const { state, request, observation, batch } = fixture();
    const passed = BatchConclusionRequestSchema.parse({ ...request, conclusion: "passed", error_code: null, affected_task_ids: [] });
    observation.conclusion = "success";
    expect(() => applyVerifiedBatchConclusion(state, passed, observation)).toThrow(/完整组合证据/);
    observation.affected_task_ids = [];
    observation.evidence = {
      batch_id: batch.batch_id, project_id: batch.project_id, ...binding,
      candidate_heads: batch.candidate_heads, trusted_workflow: workflow,
      commands: [["npm", "test"]], exit_code: 0, tests: { passed: 1, failed: 0 },
      ci_run_id: "42", merged_sha: observation.merged_sha, tree_sha: observation.tree_sha, dirty: false,
    };
    const clean = fixture();
    const receipt = applyVerifiedBatchConclusion(clean.state, passed, observation);
    expect(receipt.task_statuses["TASK-0001"]).toBe("passed");
  });

  it("旧 attempt、有活动租约或伪造归因一律拒绝", () => {
    const old = fixture();
    old.state.graph!.tasks[0]!.attempts_used = 2;
    expect(() => applyVerifiedBatchConclusion(old.state, old.request, old.observation)).toThrow(/最新已接受报告/);
    const forged = fixture();
    forged.observation.affected_task_ids = [];
    expect(() => applyVerifiedBatchConclusion(forged.state, forged.request, forged.observation)).toThrow(/归因/);
  });
});
