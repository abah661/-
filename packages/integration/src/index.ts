import { IntegrationBatchSchema, type IntegrationBatch } from "@dac/protocol";
import { resolve } from "node:path";

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

/** 只能由受信任的 CI 回查/本地 Git 检查器提供，不能从候选任务 JSON 反序列化。 */
export interface TrustedIntegrationObservation {
  batch_id: string;
  ci_run_id: string;
  trusted_workflow: string;
  conclusion: "success" | "failure";
  merged_sha: string;
  tree_sha: string;
}

const fullSha = (value: unknown): value is string => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parsePendingIntegrationBatch(input: unknown): IntegrationBatch {
  const parsed = IntegrationBatchSchema.safeParse(input);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  const batch = parsed.data;
  if (batch.conclusion !== "pending") throw new Error("新整合批次必须处于 pending 状态");
  if (![batch.base_sha, batch.rules_sha, batch.contract_sha, batch.acceptance_sha, ...batch.candidate_heads].every(fullSha)) {
    throw new Error("固定提交整合必须使用完整 SHA");
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(batch.trusted_workflow)) {
    throw new Error("trusted_workflow 必须绑定工作流路径和完整 SHA");
  }
  if (new Set(batch.candidate_heads).size !== batch.candidate_heads.length) {
    throw new Error("candidate_heads 不能重复，整合顺序必须确定");
  }
  if (batch.candidate_heads.includes(batch.base_sha)) {
    throw new Error("candidate_heads 不能包含 base_sha");
  }
  return batch;
}

export function buildFixedIntegrationPlan(batch: IntegrationBatch, worktreePath: string): IntegrationCommand[] {
  parsePendingIntegrationBatch(batch);
  if (!worktreePath.trim() || worktreePath.includes("\0")) throw new Error("worktree 路径无效");
  const absolutePath = resolve(worktreePath);
  return [
    { purpose: "checkout_base", args: ["git", "worktree", "add", "--detach", absolutePath, batch.base_sha] },
    ...batch.candidate_heads.map((head) => ({
      purpose: "merge_candidate" as const,
      args: ["git", "-C", absolutePath, "-c", "core.hooksPath=", "-c", "merge.autoStash=false", "merge", "--no-edit", "--no-ff", head],
    })),
    { purpose: "read_merged_sha", args: ["git", "-C", absolutePath, "rev-parse", "HEAD"] },
    { purpose: "read_tree_sha", args: ["git", "-C", absolutePath, "rev-parse", "HEAD^{tree}"] },
  ];
}

export function verifyIntegrationEvidence(
  batch: IntegrationBatch,
  input: unknown,
  trusted?: TrustedIntegrationObservation,
): IntegrationVerification {
  const problems: string[] = [];
  try { parsePendingIntegrationBatch(batch); }
  catch { problems.push("批次不是有效的固定提交待验收批次"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return { valid: false, problems: [...problems, "证据必须是 JSON 对象"] };
  const evidence = input as IntegrationEvidence;
  const fields = ["batch_id", "project_id", "base_sha", "rules_sha", "contract_sha", "acceptance_sha", "trusted_workflow"] as const;
  for (const field of fields) {
    if (evidence[field] !== batch[field]) problems.push(`${field} 与批次绑定不一致`);
  }
  if (!Array.isArray(evidence.candidate_heads) || !sameList(evidence.candidate_heads, batch.candidate_heads)) problems.push("candidate_heads 或合并顺序与批次不一致");
  if (evidence.exit_code !== 0) problems.push("组合测试退出码不是 0");
  if (!evidence.tests || evidence.tests.failed !== 0) problems.push("组合测试仍有失败用例");
  if (!evidence.tests || !Number.isSafeInteger(evidence.tests.passed) || evidence.tests.passed < 1 ||
      (evidence.tests.skipped !== undefined && (!Number.isSafeInteger(evidence.tests.skipped) || evidence.tests.skipped < 0))) {
    problems.push("缺少有效的实际通过用例统计");
  }
  if (evidence.dirty !== false) problems.push("整合工作区不是 clean，不能证明合并对象可复现");
  if (typeof evidence.ci_run_id !== "string" || !evidence.ci_run_id.trim()) problems.push("缺少受信任 CI run ID，不能接受 agent 自报成功");
  if (!fullSha(evidence.merged_sha)) problems.push("缺少实际 merged_sha");
  if (!fullSha(evidence.tree_sha)) problems.push("缺少实际 tree_sha");
  if (!Array.isArray(evidence.commands) || evidence.commands.length < 1 || evidence.commands.some((command) =>
    !Array.isArray(command) || command.length === 0 || command.some((arg) => typeof arg !== "string" || !arg.trim()))) {
    problems.push("缺少实际验收命令");
  }
  if (!trusted) problems.push("未取得独立 CI/Git 回查结果，不能把提交的 JSON 当作验收成功");
  else if (trusted.conclusion !== "success" || trusted.batch_id !== batch.batch_id ||
    trusted.trusted_workflow !== batch.trusted_workflow || trusted.ci_run_id !== evidence.ci_run_id ||
    trusted.merged_sha !== evidence.merged_sha || trusted.tree_sha !== evidence.tree_sha) {
    problems.push("独立 CI/Git 回查结果与证据不一致或 CI 未成功");
  }
  return { valid: problems.length === 0, problems };
}
