import { describe, expect, it } from "vitest";
import {
  buildFixedIntegrationPlan,
  parsePendingIntegrationBatch,
  verifyIntegrationEvidence,
  type IntegrationEvidence,
} from "../../apps/coordinator/src/integration.js";

const hashes = {
  base_sha: "1111111111111111111111111111111111111111",
  rules_sha: "2222222222222222222222222222222222222222",
  contract_sha: "3333333333333333333333333333333333333333",
  acceptance_sha: "4444444444444444444444444444444444444444",
  first: "5555555555555555555555555555555555555555",
  second: "6666666666666666666666666666666666666666",
  merged: "7777777777777777777777777777777777777777",
  tree: "8888888888888888888888888888888888888888",
};

const batch = parsePendingIntegrationBatch({
  batch_id: "BATCH-0001",
  project_id: "PROJECT-TEST",
  base_sha: hashes.base_sha,
  candidate_heads: [hashes.first, hashes.second],
  rules_sha: hashes.rules_sha,
  contract_sha: hashes.contract_sha,
  acceptance_sha: hashes.acceptance_sha,
  trusted_workflow: ".github/workflows/integration.yml@a577d6688b323afbdbc647b3a1288c0316f7fb1e",
  created_at: "2026-09-21T00:00:00.000Z",
  conclusion: "pending",
  ci_run_id: null,
  merged_sha: null,
  tree_sha: null,
});

function evidence(overrides: Partial<IntegrationEvidence> = {}): IntegrationEvidence {
  return {
    batch_id: batch.batch_id,
    project_id: batch.project_id,
    base_sha: batch.base_sha,
    candidate_heads: batch.candidate_heads,
    rules_sha: batch.rules_sha,
    contract_sha: batch.contract_sha,
    acceptance_sha: batch.acceptance_sha,
    trusted_workflow: batch.trusted_workflow,
    commands: [],
    exit_code: 0,
    tests: { passed: 12, failed: 0, skipped: 0 },
    ci_run_id: "RUN-1001",
    merged_sha: hashes.merged,
    tree_sha: hashes.tree,
    dirty: false,
    ...overrides,
  };
}

describe("fixed integration and independent acceptance", () => {
  it("按固定 base 和候选顺序生成参数数组", () => {
    expect(buildFixedIntegrationPlan(batch, "E:/tmp/integration-worktree")).toEqual([
      { purpose: "checkout_base", args: ["git", "worktree", "add", "--detach", "E:/tmp/integration-worktree", hashes.base_sha] },
      { purpose: "merge_candidate", args: ["git", "merge", "--no-edit", "--no-ff", hashes.first] },
      { purpose: "merge_candidate", args: ["git", "merge", "--no-edit", "--no-ff", hashes.second] },
      { purpose: "read_merged_sha", args: ["git", "rev-parse", "HEAD"] },
      { purpose: "read_tree_sha", args: ["git", "rev-parse", "HEAD^{tree}"] },
    ]);
  });

  it("拒绝重复候选或把 base 混入候选", () => {
    expect(() => parsePendingIntegrationBatch({ ...batch, candidate_heads: [hashes.first, hashes.first] })).toThrow("不能重复");
    expect(() => parsePendingIntegrationBatch({ ...batch, candidate_heads: [hashes.base_sha] })).toThrow("不能包含");
  });

  it("只有受信任 CI 和实际合并对象齐全才通过", () => {
    expect(verifyIntegrationEvidence(batch, evidence())).toEqual({ valid: true, problems: [] });
    const failed = verifyIntegrationEvidence(batch, evidence({ ci_run_id: null, tests: { passed: 11, failed: 1 } }));
    expect(failed.valid).toBe(false);
    expect(failed.problems).toEqual(expect.arrayContaining(["缺少受信任 CI run ID，不能接受 agent 自报成功", "组合测试仍有失败用例"]));
  });
});
