import { IntegrationBatchSchema, type IntegrationBatch } from "@dac/protocol";

export interface IntegrationCommand {
  purpose: "checkout_base" | "merge_candidate" | "read_merged_sha" | "read_tree_sha";
  args: readonly string[];
}

export interface IntegrationEvidence {
  batch_id: string;
  project_id: string;
  base_sha: string;
  candidate_heads: readonly string[];
  rules_sha: string;
  contract_sha: string;
  acceptance_sha: string;
  trusted_workflow: string;
  commands: readonly (readonly string[])[];
  exit_code: number;
  tests: { passed: number; failed: number; skipped?: number };
  ci_run_id: string | null;
  merged_sha: string | null;
  tree_sha: string | null;
  dirty: boolean;
}

export interface IntegrationVerification {
  valid: boolean;
  problems: string[];
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parsePendingIntegrationBatch(input: unknown): IntegrationBatch {
  const parsed = IntegrationBatchSchema.safeParse(input);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  const batch = parsed.data;
  if (batch.conclusion !== "pending") throw new Error("新整合批次必须处于 pending 状态");
  if (new Set(batch.candidate_heads).size !== batch.candidate_heads.length) {
    throw new Error("candidate_heads 不能重复，整合顺序必须确定");
  }
  if (batch.candidate_heads.includes(batch.base_sha)) {
    throw new Error("candidate_heads 不能包含 base_sha");
  }
  return batch;
}

export function buildFixedIntegrationPlan(batch: IntegrationBatch, worktreePath: string): IntegrationCommand[] {
  return [
    { purpose: "checkout_base", args: ["git", "worktree", "add", "--detach", worktreePath, batch.base_sha] },
    ...batch.candidate_heads.map((head) => ({
      purpose: "merge_candidate" as const,
      args: ["git", "merge", "--no-edit", "--no-ff", head],
    })),
    { purpose: "read_merged_sha", args: ["git", "rev-parse", "HEAD"] },
    { purpose: "read_tree_sha", args: ["git", "rev-parse", "HEAD^{tree}"] },
  ];
}

export function verifyIntegrationEvidence(
  batch: IntegrationBatch,
  evidence: IntegrationEvidence,
): IntegrationVerification {
  const problems: string[] = [];
  const fields = ["batch_id", "project_id", "base_sha", "rules_sha", "contract_sha", "acceptance_sha", "trusted_workflow"] as const;
  for (const field of fields) {
    if (evidence[field] !== batch[field]) problems.push(`${field} 与批次绑定不一致`);
  }
  if (!sameList(evidence.candidate_heads, batch.candidate_heads)) problems.push("candidate_heads 或合并顺序与批次不一致");
  if (evidence.exit_code !== 0) problems.push("组合测试退出码不是 0");
  if (evidence.tests.failed !== 0) problems.push("组合测试仍有失败用例");
  if (evidence.dirty) problems.push("整合工作区不是 clean，不能证明合并对象可复现");
  if (!evidence.ci_run_id) problems.push("缺少受信任 CI run ID，不能接受 agent 自报成功");
  if (!evidence.merged_sha) problems.push("缺少实际 merged_sha");
  if (!evidence.tree_sha) problems.push("缺少实际 tree_sha");
  return { valid: problems.length === 0, problems };
}
