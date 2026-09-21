import {
  assertTransition,
  analyzeGraph,
  EventEnvelopeSchema,
  ExecutorRegistrationSchema,
  IntegrationBatchSchema,
  PROTOCOL_META,
  ResultReportSchema,
  TaskGraphSchema,
  type EventEnvelope,
  type ExecutorRegistration,
  type IntegrationBatch,
  type Lease,
  type ResultReport,
  type TaskGraph,
  type TaskNode,
} from "@dac/protocol";
import {
  ContractProposalSchema,
  errorResponse,
  jsonResponse,
  parseJson,
  requireIdempotencyScope,
  type ContractProposal,
  type LeaseRequest,
  type RenewLeaseRequest,
  LeaseRequestSchema,
  RenewLeaseRequestSchema,
  ApiError,
} from "./api.js";
import {
  emptyProjectState,
  loadProjectState,
  type DurableObjectStateLike,
  type ProjectState,
  type StorageTransactionLike,
} from "./storage.js";

const INTERNAL_PREFIX = "/internal/";

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function publicTask(task: TaskNode): TaskNode {
  return structuredClone(task);
}

function responseForIdempotency(state: ProjectState, key: string, body: unknown): Response | null {
  const previous = state.idempotency[key];
  if (!previous) return null;
  if (previous.fingerprint !== fingerprint(body)) {
    throw new ApiError(409, "IDEMPOTENCY_REPLAY_CONFLICT", "幂等键已用于另一份请求");
  }
  const stored = previous.response as { status: number; body: unknown };
  return jsonResponse(stored.body, stored.status, { "x-idempotent-replay": "true" });
}

function saveIdempotent(state: ProjectState, key: string, body: unknown, responseBody: unknown, status: number): void {
  state.idempotency[key] = { fingerprint: fingerprint(body), response: { status, body: responseBody } };
}

function requireTaskGraph(state: ProjectState): TaskGraph {
  if (!state.graph) throw new ApiError(409, "PROJECT_NOT_PLANNED", "项目尚未提交任务图");
  return state.graph;
}

function findTask(state: ProjectState, taskId: string): TaskNode {
  const task = requireTaskGraph(state).tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
  return task;
}

function dependencyReady(state: ProjectState, task: TaskNode): boolean {
  const graph = requireTaskGraph(state);
  return task.depends_on.every((dependencyId) => {
    const dependency = graph.tasks.find((candidate) => candidate.task_id === dependencyId);
    return dependency?.status === "passed" || dependency?.status === "merged";
  });
}

function hasCapabilities(task: TaskNode, registration: ExecutorRegistration): boolean {
  const capabilities = new Set(registration.capabilities);
  return task.requires.every((required) => capabilities.has(required));
}

function reportTargetStatus(report: ResultReport): TaskNode["status"] {
  return report.status === "failed" ? "repair_pending" : report.status;
}

function assertBindingMatches(lease: Lease, report: ResultReport): void {
  for (const key of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
    if (lease.binding[key] !== report[key]) {
      throw new ApiError(409, "VERSION_BINDING_MISMATCH", `${key} 与领取时绑定版本不一致`);
    }
  }
}

function reapExpiredLeases(state: ProjectState): void {
  const now = Date.now();
  for (const [taskId, lease] of Object.entries(state.leases)) {
    if (Date.parse(lease.expires_at) > now) continue;
    const task = state.graph?.tasks.find((candidate) => candidate.task_id === taskId);
    if (task?.status === "leased") {
      assertTransition(task.status, "ready");
      task.status = "ready";
      task.assigned_executor = null;
    }
    delete state.leases[taskId];
  }
}

function leaseExpired(lease: Lease): boolean {
  return Date.parse(lease.expires_at) <= Date.now();
}

export class ProjectDurableObject {
  constructor(private readonly state: DurableObjectStateLike, private readonly projectId: string) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(INTERNAL_PREFIX)) return errorResponse(404, "NOT_FOUND", "未知 Durable Object 路径");
      const action = url.pathname.slice(INTERNAL_PREFIX.length);
      return await this.dispatch(action, request);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error.status, error.code, error.message, error.details);
      if (error instanceof Error) return errorResponse(500, "INTERNAL_ERROR", error.message);
      return errorResponse(500, "INTERNAL_ERROR", String(error));
    }
  }

  private async withTransaction<T>(callback: (storage: StorageTransactionLike, state: ProjectState) => Promise<T>): Promise<T> {
    return this.state.storage.transaction(async (transaction) => {
      const current = await loadProjectState(transaction, this.projectId);
      const result = await callback(transaction, current);
      await transaction.put("project_state", current);
      return result;
    });
  }

  private async dispatch(action: string, request: Request): Promise<Response> {
    switch (`${request.method.toUpperCase()} ${action}`) {
      case "POST register_executor":
        return this.registerExecutor(await parseJson(request));
      case "POST submit_requirement":
        return this.submitRequirement(await parseJson(request));
      case "POST lease_task":
        return this.leaseTask(await parseJson(request));
      case "POST renew_lease":
        return this.renewLease(await parseJson(request));
      case "POST report_result":
        return this.reportResult(await parseJson(request));
      case "POST contract_proposal":
        return this.submitContractProposal(await parseJson(request));
      case "POST github_event":
        return this.receiveGithubEvent(await parseJson(request));
      case "POST integration_batch":
        return this.createIntegrationBatch(await parseJson(request));
      case "GET status":
        return this.status();
      case "GET context":
        return this.context(new URL(request.url).searchParams.get("task_id"));
      default:
        return errorResponse(404, "NOT_FOUND", `未知协调器操作：${request.method} ${action}`);
    }
  }

  private async registerExecutor(input: unknown): Promise<Response> {
    const parsed = ExecutorRegistrationSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "执行器注册数据无效", parsed.error.issues);
    const registration = parsed.data;
    const idempotencyKey = `register_executor:${registration.executor_id}`;
    return this.withTransaction(async (_storage, state) => {
      const replay = responseForIdempotency(state, idempotencyKey, registration);
      if (replay) return replay;
      state.executors[registration.executor_id] = registration;
      const body = { executor_id: registration.executor_id, registered: true };
      saveIdempotent(state, idempotencyKey, registration, body, 200);
      return jsonResponse(body);
    });
  }

  private async submitRequirement(input: unknown): Promise<Response> {
    const parsed = TaskGraphSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "任务图数据无效", parsed.error.issues);
    const graph = parsed.data;
    if (graph.project_id !== this.projectId) {
      throw new ApiError(409, "PROJECT_MISMATCH", "任务图 project_id 与 Durable Object 不一致");
    }
    const { problems } = analyzeGraph(graph);
    if (problems.length > 0) throw new ApiError(422, "TASK_GRAPH_INVALID", "任务图未通过语义校验", problems);
    return this.withTransaction(async (_storage, state) => {
      const key = requireIdempotencyScope({ idempotency_key: graph.requirement_ref }, "submit_requirement");
      const replay = responseForIdempotency(state, key, graph);
      if (replay) return replay;
      if (state.graph) throw new ApiError(409, "PROJECT_ALREADY_PLANNED", "项目已有任务图，不能覆盖");
      state.graph = graph;
      const body = { project_id: this.projectId, task_count: graph.tasks.length, status: PROTOCOL_META.status };
      saveIdempotent(state, key, graph, body, 201);
      return jsonResponse(body, 201);
    });
  }

  private async leaseTask(input: unknown): Promise<Response> {
    const parsed = LeaseRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "领取请求无效", parsed.error.issues);
    const request = parsed.data as LeaseRequest;
    return this.withTransaction(async (_storage, state) => {
      reapExpiredLeases(state);
      const key = requireIdempotencyScope(request, "lease_task");
      const replay = responseForIdempotency(state, key, request);
      if (replay) return replay;
      const registration = state.executors[request.executor_id];
      if (!registration) throw new ApiError(403, "EXECUTOR_NOT_REGISTERED", "执行器尚未注册");
      if (registration.agent_kind !== request.agent_kind) throw new ApiError(409, "EXECUTOR_MISMATCH", "agent_kind 与注册信息不一致");
      const graph = requireTaskGraph(state);
      const task = graph.tasks.find(
        (candidate) => candidate.status === "ready" && dependencyReady(state, candidate) && hasCapabilities(candidate, registration),
      );
      if (!task) {
        const body = { task: null, lease: null, status: "empty" };
        saveIdempotent(state, key, request, body, 200);
        return jsonResponse(body);
      }
      const attemptNumber = task.attempts_used + 1;
      const attemptId = `${task.task_id}-A${attemptNumber}`;
      const lease: Lease = {
        task_id: task.task_id,
        attempt_id: attemptId,
        executor_id: request.executor_id,
        lease_epoch: attemptNumber,
        expires_at: new Date(Date.now() + 180_000).toISOString(),
        binding: graph.binding,
        agent_kind: registration.agent_kind,
      };
      task.status = "leased";
      task.assigned_executor = request.executor_id;
      task.attempts_used = attemptNumber;
      state.leases[task.task_id] = lease;
      const body = { task: publicTask(task), lease };
      saveIdempotent(state, key, request, body, 200);
      return jsonResponse(body);
    });
  }

  private async renewLease(input: unknown): Promise<Response> {
    const parsed = RenewLeaseRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "续约请求无效", parsed.error.issues);
    const request = parsed.data as RenewLeaseRequest;
    return this.withTransaction(async (_storage, state) => {
      const key = requireIdempotencyScope(request, "renew_lease");
      const replay = responseForIdempotency(state, key, request);
      if (replay) return replay;
      const lease = state.leases[request.task_id];
      if (!lease || lease.attempt_id !== request.attempt_id || lease.executor_id !== request.executor_id || lease.lease_epoch !== request.lease_epoch) {
        throw new ApiError(409, "LEASE_EPOCH_STALE", "续约不匹配当前租约");
      }
      if (leaseExpired(lease)) throw new ApiError(409, "LEASE_EXPIRED", "租约已过期，不能续约");
      lease.expires_at = new Date(Date.now() + 180_000).toISOString();
      saveIdempotent(state, key, request, lease, 200);
      return jsonResponse(lease);
    });
  }

  private async reportResult(input: unknown): Promise<Response> {
    const parsed = ResultReportSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "结果报告无效", parsed.error.issues);
    const report = parsed.data;
    return this.withTransaction(async (_storage, state) => {
      const key = `report_result:${report.task_id}:${report.attempt_id}:${report.lease_epoch}`;
      const replay = responseForIdempotency(state, key, report);
      if (replay) return replay;
      const lease = state.leases[report.task_id];
      const task = findTask(state, report.task_id);
      if (!lease || lease.attempt_id !== report.attempt_id || lease.executor_id !== report.executor_id || lease.lease_epoch !== report.lease_epoch) {
        throw new ApiError(409, "LEASE_EPOCH_STALE", "结果报告不匹配当前租约");
      }
      if (leaseExpired(lease)) throw new ApiError(409, "LEASE_EXPIRED", "租约已过期，不能提交结果");
      assertBindingMatches(lease, report);
      // 结果报告由持有租约的执行器提交，因此报告本身可以确认已开工。
      // 协议要求 leased → running 只能由当前租约持有者推进；这里完成这一步，
      // 随后再按报告状态推进到 validating 或异常状态。
      if (task.status === "leased") {
        assertTransition(task.status, "running");
        task.status = "running";
      }
      if (report.status === "ready_for_integration" && task.status === "running") {
        assertTransition(task.status, "validating");
        task.status = "validating";
      }
      const target = reportTargetStatus(report);
      if (task.status !== target) assertTransition(task.status, target);
      task.status = target;
      state.reports[report.task_id] = report;
      delete state.leases[report.task_id];
      const body = { accepted: true, task_id: task.task_id, status: task.status };
      saveIdempotent(state, key, report, body, 200);
      return jsonResponse(body);
    });
  }

  private async submitContractProposal(input: unknown): Promise<Response> {
    const parsed = ContractProposalSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "契约提案无效", parsed.error.issues);
    const proposal = parsed.data as ContractProposal;
    return this.withTransaction(async (_storage, state) => {
      const key = requireIdempotencyScope(proposal, "contract_proposal");
      const replay = responseForIdempotency(state, key, proposal);
      if (replay) return replay;
      const body = { accepted: true, proposal_id: proposal.proposal_id, status: "proposed" };
      saveIdempotent(state, key, proposal, body, 202);
      return jsonResponse(body, 202);
    });
  }

  private async receiveGithubEvent(input: unknown): Promise<Response> {
    const parsed = EventEnvelopeSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "GitHub 事件无效", parsed.error.issues);
    const event = parsed.data as EventEnvelope;
    return this.withTransaction(async (_storage, state) => {
      const key = `github_event:${event.event_id}`;
      const replay = responseForIdempotency(state, key, event);
      if (replay) return replay;
      state.events.push(event);
      const body = { accepted: true, event_id: event.event_id };
      saveIdempotent(state, key, event, body, 202);
      return jsonResponse(body, 202);
    });
  }

  private async createIntegrationBatch(input: unknown): Promise<Response> {
    const parsed = IntegrationBatchSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "RESULT_SCHEMA_INVALID", "整合批次无效", parsed.error.issues);
    const batch = parsed.data as IntegrationBatch;
    return this.withTransaction(async (_storage, state) => {
      const key = `integration_batch:${batch.batch_id}`;
      const replay = responseForIdempotency(state, key, batch);
      if (replay) return replay;
      if (state.batches[batch.batch_id]) throw new ApiError(409, "BATCH_EXISTS", "整合批次已存在");
      state.batches[batch.batch_id] = batch;
      const body = { accepted: true, batch_id: batch.batch_id, conclusion: batch.conclusion };
      saveIdempotent(state, key, batch, body, 201);
      return jsonResponse(body, 201);
    });
  }

  private async status(): Promise<Response> {
    const state = await loadProjectState(this.state.storage, this.projectId);
    return jsonResponse({
      project_id: this.projectId,
      protocol: PROTOCOL_META,
      graph: state.graph,
      executors: Object.values(state.executors).map(({ executor_id, host_label, agent_kind, capabilities }) => ({ executor_id, host_label, agent_kind, capabilities })),
      leases: state.leases,
      batches: state.batches,
      event_count: state.events.length,
    });
  }

  private async context(taskId: string | null): Promise<Response> {
    if (!taskId) throw new ApiError(400, "TASK_ID_REQUIRED", "获取上下文需要 task_id");
    const state = await loadProjectState(this.state.storage, this.projectId);
    const task = findTask(state, taskId);
    return jsonResponse({
      project_id: this.projectId,
      task: publicTask(task),
      binding: state.graph?.binding ?? null,
      protocol: PROTOCOL_META,
    });
  }
}
