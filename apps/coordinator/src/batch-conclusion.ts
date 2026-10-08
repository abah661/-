import {
  assertTransition,
  DEFAULT_LIMITS,
  ERROR_POLICY,
  EventEnvelopeSchema,
  type BatchConclusionRequest,
  type IntegrationBatch,
  type TaskNode,
} from "@dac/protocol";
import {
  verifyIntegrationEvidence,
  type IntegrationEvidence,
  type TrustedIntegrationObservation,
} from "@dac/integration";
import { ApiError } from "./api.js";
import type { ProjectState } from "./storage.js";

/** 仅由 Worker 的独立 GitHub/Git 核验器构造；绝不从管理请求或 Agent 报告反序列化。 */
export interface ServerVerifiedBatchObservation {
  batch_id: string;
  project_id: string;
  candidate_heads: string[];
  base_sha: string;
  rules_sha: string;
  contract_sha: string;
  acceptance_sha: string;
  trusted_workflow: string;
  ci_run_id: string;
  conclusion: "success" | "failure";
  merged_sha: string | null;
  tree_sha: string | null;
  /** 只有可信 CI 产物能确定多候选归因；未知时为空。 */
  affected_task_ids: string[];
  evidence: IntegrationEvidence | null;
}

export interface BatchConclusionReceipt {
  batch_id: string;
  conclusion: "passed" | "failed" | "superseded";
  task_statuses: Record<string, TaskNode["status"]>;
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function transition(task: TaskNode, target: TaskNode["status"]): void {
  assertTransition(task.status, target);
  task.status = target;
}

function selectedTasks(state: ProjectState, batch: IntegrationBatch): TaskNode[] {
  const graph = state.graph;
  if (!graph) throw new ApiError(409, "PROJECT_NOT_PLANNED", "项目尚未提交任务图");
  for (const field of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
    if (graph.binding[field] !== batch[field]) {
      throw new ApiError(409, "VERSION_BINDING_MISMATCH", `${field} 已变化，旧批次不得终结`);
    }
  }
  return batch.candidate_heads.map((head) => {
    const matches = graph.tasks.filter((task) => state.reports[task.task_id]?.head_sha === head);
    if (matches.length !== 1) throw new ApiError(409, "BATCH_CANDIDATE_STALE", "候选提交已失效或归属不唯一");
    const task = matches[0]!;
    const report = state.reports[task.task_id]!;
    if (task.status !== "integrating" || task.attempts_used !== report.lease_epoch ||
        report.attempt_id !== `${task.task_id}-A${task.attempts_used}` ||
        report.status !== "ready_for_integration" || state.leases[task.task_id]) {
      throw new ApiError(409, "LEASE_EPOCH_STALE", "候选不是最新已接受报告，或仍有活动租约");
    }
    for (const field of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
      if (report[field] !== batch[field]) throw new ApiError(409, "VERSION_BINDING_MISMATCH", "报告版本与批次不一致");
    }
    return task;
  });
}

function assertObservation(batch: IntegrationBatch, request: BatchConclusionRequest,
  observation: ServerVerifiedBatchObservation | null): ServerVerifiedBatchObservation {
  if (!observation || observation.batch_id !== batch.batch_id || observation.project_id !== batch.project_id ||
      observation.ci_run_id !== request.github_run_id || observation.trusted_workflow !== batch.trusted_workflow ||
      !sameList(observation.candidate_heads, batch.candidate_heads)) {
    throw new ApiError(422, "UNTRUSTED_INTEGRATION_EVIDENCE", "缺少匹配批次的独立 CI/Git 观察");
  }
  for (const field of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
    if (observation[field] !== batch[field]) {
      throw new ApiError(409, "VERSION_BINDING_MISMATCH", "独立观察的版本与批次不一致");
    }
  }
  if (observation.conclusion !== (request.conclusion === "passed" ? "success" : "failure")) {
    throw new ApiError(422, "CI_CONCLUSION_MISMATCH", "CI 结论与请求不一致");
  }
  return observation;
}

/** 在同一个 Durable Object 事务中调用；调用方必须先完成鉴权与独立取证。 */
export function applyVerifiedBatchConclusion(
  state: ProjectState,
  request: BatchConclusionRequest,
  input: ServerVerifiedBatchObservation | null,
): BatchConclusionReceipt {
  const batch = state.batches[request.batch_id];
  if (!batch || batch.project_id !== request.project_id || request.project_id !== state.project_id) {
    throw new ApiError(404, "BATCH_NOT_FOUND", "批次不存在或项目不匹配");
  }
  if (batch.conclusion !== "pending") throw new ApiError(409, "BATCH_ALREADY_CONCLUDED", "批次已终结");
  if (!sameList(batch.candidate_heads, request.candidate_heads)) {
    throw new ApiError(409, "BATCH_CANDIDATE_MISMATCH", "候选提交或顺序与固定批次不一致");
  }
  const tasks = selectedTasks(state, batch);
  const taskIds = new Set(tasks.map((task) => task.task_id));
  if (request.affected_task_ids.some((taskId) => !taskIds.has(taskId))) {
    throw new ApiError(422, "BATCH_ATTRIBUTION_INVALID", "返修归因不在当前批次内");
  }

  if (request.conclusion === "superseded") {
    for (const task of tasks) transition(task, "needs_input");
    batch.conclusion = "superseded";
  } else {
    const observation = assertObservation(batch, request, input);
    batch.ci_run_id = observation.ci_run_id;
    batch.merged_sha = observation.merged_sha;
    batch.tree_sha = observation.tree_sha;

    if (request.conclusion === "passed") {
      if (!observation.evidence || !observation.merged_sha || !observation.tree_sha) {
        throw new ApiError(422, "UNTRUSTED_INTEGRATION_EVIDENCE", "通过结论缺少完整组合证据");
      }
      const trusted: TrustedIntegrationObservation = {
        batch_id: batch.batch_id,
        ci_run_id: observation.ci_run_id,
        trusted_workflow: batch.trusted_workflow,
        conclusion: "success",
        merged_sha: observation.merged_sha,
        tree_sha: observation.tree_sha,
      };
      const verified = verifyIntegrationEvidence(batch, observation.evidence, trusted);
      if (!verified.valid) {
        throw new ApiError(422, "UNTRUSTED_INTEGRATION_EVIDENCE", "独立整合证据未通过", verified.problems);
      }
      for (const task of tasks) transition(task, "passed");
      batch.conclusion = "passed";
    } else {
      if (!sameList([...request.affected_task_ids].sort(), [...observation.affected_task_ids].sort())) {
        throw new ApiError(422, "BATCH_ATTRIBUTION_INVALID", "请求归因与独立观察不一致");
      }
      const canRepair = request.error_code === "TESTS_FAILED" &&
        ERROR_POLICY[request.error_code].disposition === "repairable" && request.affected_task_ids.length > 0;
      const affected = new Set(request.affected_task_ids);
      for (const task of tasks) {
        if (!canRepair) {
          transition(task, "needs_input");
          continue;
        }
        if (!affected.has(task.task_id)) {
          transition(task, "ready_for_integration");
          continue;
        }
        const prior = state.reports[task.task_id]!;
        const registration = state.executors[prior.executor_id];
        if (!registration || registration.agent_kind !== prior.agent_kind) {
          transition(task, "needs_input");
          continue;
        }
        transition(task, "repair_pending");
        if (task.attempts_used <= DEFAULT_LIMITS.maxRepairAttempts) transition(task, "ready");
      }
      batch.conclusion = "failed";
    }
  }

  const statuses = Object.fromEntries(tasks.map((task) => [task.task_id, task.status])) as Record<string, TaskNode["status"]>;
  state.events.push(EventEnvelopeSchema.parse({
    event_id: crypto.randomUUID(),
    event_type: batch.conclusion === "passed" ? "batch.passed" :
      batch.conclusion === "failed" ? "batch.failed" : "task.transitioned",
    protocol_version: "1",
    project_id: state.project_id,
    occurred_at: new Date().toISOString(),
    batch_id: batch.batch_id,
    payload: {
      conclusion: batch.conclusion,
      ci_run_id: batch.ci_run_id,
      error_code: request.error_code,
      affected_task_ids: request.affected_task_ids,
      task_statuses: statuses,
    },
  }));
  return { batch_id: batch.batch_id, conclusion: batch.conclusion, task_statuses: statuses };
}
