import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  buildFixedIntegrationPlan,
  parsePendingIntegrationBatch,
  verifyIntegrationEvidence,
  type IntegrationEvidence,
  type TrustedIntegrationObservation,
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
    commands: [["npm", "test"]],
    exit_code: 0,
    tests: { passed: 12, failed: 0, skipped: 0 },
    ci_run_id: "RUN-1001",
    merged_sha: hashes.merged,
    tree_sha: hashes.tree,
    dirty: false,
    ...overrides,
  };
}

function trusted(): TrustedIntegrationObservation {
  return { batch_id: batch.batch_id, ci_run_id: "RUN-1001", trusted_workflow: batch.trusted_workflow,
    conclusion: "success", merged_sha: hashes.merged, tree_sha: hashes.tree };
}

describe("fixed integration and independent acceptance", () => {
  it("实际执行整合计划时，合并只发生在独立 worktree", () => {
    const repo = mkdtempSync(resolve(tmpdir(), "dac-fixed-integration-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "DAC test");
    git("config", "user.email", "dac-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(resolve(repo, "baseline.txt"), "base\n");
    git("add", "baseline.txt"); git("commit", "-m", "baseline");
    const base = git("rev-parse", "HEAD");
    git("switch", "-c", "candidate");
    writeFileSync(resolve(repo, "candidate.txt"), "candidate\n");
    git("add", "candidate.txt"); git("commit", "-m", "candidate");
    const head = git("rev-parse", "HEAD");
    git("switch", "main");
    const worktree = resolve(repo, "isolated worktree");
    const plan = buildFixedIntegrationPlan({ ...batch, base_sha: base, candidate_heads: [head] }, worktree);
    for (const command of plan) git(...command.args.slice(1));
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(existsSync(resolve(repo, "candidate.txt"))).toBe(false);
    expect(existsSync(resolve(worktree, "candidate.txt"))).toBe(true);
    expect(git("-C", worktree, "status", "--porcelain")).toBe("");
    // 本项目不自动删除工作树或日志；测试夹具保留在系统临时目录。
  });
  it("按固定 base 和候选顺序生成参数数组", () => {
    const path = resolve("E:/tmp/integration-worktree");
    expect(buildFixedIntegrationPlan(batch, "E:/tmp/integration-worktree")).toEqual([
      { purpose: "checkout_base", args: ["git", "worktree", "add", "--detach", path, hashes.base_sha] },
      { purpose: "merge_candidate", args: ["git", "-C", path, "-c", "core.hooksPath=", "-c", "merge.autoStash=false", "merge", "--no-edit", "--no-ff", hashes.first] },
      { purpose: "merge_candidate", args: ["git", "-C", path, "-c", "core.hooksPath=", "-c", "merge.autoStash=false", "merge", "--no-edit", "--no-ff", hashes.second] },
      { purpose: "read_merged_sha", args: ["git", "-C", path, "rev-parse", "HEAD"] },
      { purpose: "read_tree_sha", args: ["git", "-C", path, "rev-parse", "HEAD^{tree}"] },
    ]);
  });

  it("拒绝重复候选或把 base 混入候选", () => {
    expect(() => parsePendingIntegrationBatch({ ...batch, candidate_heads: [hashes.first, hashes.first] })).toThrow("不能重复");
    expect(() => parsePendingIntegrationBatch({ ...batch, candidate_heads: [hashes.base_sha] })).toThrow("不能包含");
  });

  it("只有受信任 CI 和实际合并对象齐全才通过", () => {
    expect(verifyIntegrationEvidence(batch, evidence(), trusted())).toEqual({ valid: true, problems: [] });
    const failed = verifyIntegrationEvidence(batch, evidence({ ci_run_id: null, tests: { passed: 11, failed: 1 } }));
    expect(failed.valid).toBe(false);
    expect(failed.problems).toEqual(expect.arrayContaining(["缺少受信任 CI run ID，不能接受 agent 自报成功", "组合测试仍有失败用例"]));
  });

  it("自填 CI run ID 不能替代独立回查", () => {
    expect(verifyIntegrationEvidence(batch, evidence()).valid).toBe(false);
    expect(verifyIntegrationEvidence(batch, evidence(), { ...trusted(), conclusion: "failure" }).valid).toBe(false);
    expect(verifyIntegrationEvidence(batch, evidence(), { ...trusted(), merged_sha: hashes.first }).valid).toBe(false);
  });

  it.each([null, {}, { tests: null }, { candidate_heads: 1 }, evidence({ tests: { passed: 0, failed: 0 } }),
    evidence({ commands: [] }), evidence({ tree_sha: "anything" }), evidence({ dirty: undefined as any })])
  ("恶意或空证据安全拒绝而不抛出异常", (input) => {
    expect(verifyIntegrationEvidence(batch, input, trusted()).valid).toBe(false);
  });

  it("整合计划拒绝短 SHA 和浮动工作流", () => {
    expect(() => parsePendingIntegrationBatch({ ...batch, base_sha: "1234567" })).toThrow("完整 SHA");
    expect(() => parsePendingIntegrationBatch({ ...batch, trusted_workflow: ".github/workflows/ci.yml@main" })).toThrow("trusted_workflow");
  });
});
