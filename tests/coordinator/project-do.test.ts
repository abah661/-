import { describe, expect, it, vi } from "vitest";
import { ProjectDurableObject } from "../../apps/coordinator/src/project-do.js";
import { createCoordinatorWorker, type CoordinatorEnv } from "../../apps/coordinator/src/worker.js";
import type {
  DurableObjectStateLike,
  DurableObjectStorageLike,
  StorageTransactionLike,
} from "../../apps/coordinator/src/storage.js";

class MemoryStorage implements DurableObjectStorageLike {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: StorageTransactionLike) => Promise<T>): Promise<T> {
    const draft = new Map<string, unknown>();
    for (const [key, value] of this.values) draft.set(key, structuredClone(value));
    const transaction: StorageTransactionLike = {
      get: async <V>(key: string) => structuredClone(draft.get(key)) as V | undefined,
      put: async <V>(key: string, value: V) => void draft.set(key, structuredClone(value)),
      delete: async (key: string) => void draft.delete(key),
    };
    const result = await callback(transaction);
    this.values = draft;
    return result;
  }
}

const binding = {
  base_sha: "1111111111111111111111111111111111111111",
  rules_sha: "2222222222222222222222222222222222222222",
  contract_sha: "3333333333333333333333333333333333333333",
  acceptance_sha: "4444444444444444444444444444444444444444",
};

const graph = {
  protocol_version: "1" as const,
  project_id: "PROJECT-TEST",
  requirement_ref: "requirement-001",
  tasks: [
    {
      task_id: "TASK-0001",
      kind: "implement" as const,
      title: "测试任务",
      acceptance_criteria: ["测试通过"],
      depends_on: [],
      write_scope: { allow: ["src/**"], deny: [] },
      contracts: [],
      requires: ["code" as const, "test" as const],
      expected_interfaces: [],
      status: "ready" as const,
      assigned_executor: null,
      attempts_used: 0,
    },
  ],
  binding,
  created_at: "2026-09-21T00:00:00.000Z",
};

const registration = {
  protocol_version: "1" as const,
  executor_id: "EXE-A-TEST",
  host_label: "A-test",
  agent_kind: "codex" as const,
  capabilities: ["code" as const, "test" as const, "dry_run" as const],
  tool_versions: { codex: "test" },
  project_root: "E:/project",
  registered_at: "2026-09-21T00:00:00.000Z",
};

function makeState(storage: DurableObjectStorageLike, projectId = "PROJECT-TEST"): DurableObjectStateLike {
  return {
    id: {
      name: projectId,
      toString: () => projectId,
    },
    storage,
  };
}

function makeDo() {
  return new ProjectDurableObject(makeState(new MemoryStorage()), {
    PROJECTS: { idFromName: () => ({}) },
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("ProjectDurableObject", () => {
  it("支持注册、提交任务图、领取和回报结果", async () => {
    const projectDo = makeDo();
    const register = await projectDo.fetch(new Request("https://internal/internal/register_executor", {
      method: "POST",
      body: JSON.stringify(registration),
    }));
    expect(register.status).toBe(200);

    const submit = await projectDo.fetch(new Request("https://internal/internal/submit_requirement", {
      method: "POST",
      body: JSON.stringify(graph),
    }));
    expect(submit.status).toBe(201);

    const leaseResponse = await projectDo.fetch(new Request("https://internal/internal/lease_task", {
      method: "POST",
      body: JSON.stringify({
        protocol_version: "1",
        executor_id: registration.executor_id,
        agent_kind: registration.agent_kind,
        capabilities: registration.capabilities,
        idempotency_key: "lease-001",
      }),
    }));
    expect(leaseResponse.status).toBe(200);
    const leased = await json(leaseResponse);
    expect(leased.task.task_id).toBe("TASK-0001");
    expect(leased.lease.attempt_id).toBe("TASK-0001-A1");

    const report = {
      protocol_version: "1",
      task_id: "TASK-0001",
      attempt_id: leased.lease.attempt_id,
      executor_id: registration.executor_id,
      lease_epoch: leased.lease.lease_epoch,
      agent_kind: "codex",
      ...binding,
      head_sha: "5555555555555555555555555555555555555555",
      status: "ready_for_integration",
      evidence_id: "EVIDENCE-001",
      changed_files: ["src/example.ts"],
      evidence: {
        evidence_id: "EVIDENCE-001",
        command: ["npm", "test"],
        exit_code: 0,
        summary: { passed: 1, failed: 0, skipped: 0 },
        log_artifact: null,
        output_sha256: null,
      },
      error_code: null,
      commit_shas: ["5555555555555555555555555555555555555555"],
      note: null,
      reported_at: "2026-09-21T00:01:00.000Z",
    };
    const result = await projectDo.fetch(new Request("https://internal/internal/report_result", {
      method: "POST",
      body: JSON.stringify(report),
    }));
    expect(result.status).toBe(200);
    expect(await json(result)).toMatchObject({ accepted: true, status: "ready_for_integration" });

    const replay = await projectDo.fetch(new Request("https://internal/internal/report_result", {
      method: "POST",
      body: JSON.stringify(report),
    }));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");

    const status = await projectDo.fetch(new Request("https://internal/internal/status"));
    expect(status.status).toBe(200);
    expect((await json(status)).graph.tasks[0].status).toBe("ready_for_integration");
  });

  it("拒绝旧 lease_epoch 的报告", async () => {
    const projectDo = makeDo();
    await projectDo.fetch(new Request("https://internal/internal/register_executor", {
      method: "POST",
      body: JSON.stringify(registration),
    }));
    await projectDo.fetch(new Request("https://internal/internal/submit_requirement", {
      method: "POST",
      body: JSON.stringify(graph),
    }));
    const leaseResponse = await projectDo.fetch(new Request("https://internal/internal/lease_task", {
      method: "POST",
      body: JSON.stringify({
        protocol_version: "1",
        executor_id: registration.executor_id,
        agent_kind: registration.agent_kind,
        capabilities: registration.capabilities,
        idempotency_key: "lease-002",
      }),
    }));
    const leased = await json(leaseResponse);
    const invalidReport = {
      protocol_version: "1",
      task_id: "TASK-0001",
      attempt_id: leased.lease.attempt_id,
      executor_id: registration.executor_id,
      lease_epoch: 2,
      agent_kind: "codex",
      ...binding,
      head_sha: "5555555555555555555555555555555555555555",
      status: "repair_pending",
      error_code: "AGENT_TIMEOUT",
      reported_at: "2026-09-21T00:01:00.000Z",
    };
    const result = await projectDo.fetch(new Request("https://internal/internal/report_result", {
      method: "POST",
      body: JSON.stringify(invalidReport),
    }));
    expect(result.status).toBe(409);
    expect(await json(result)).toMatchObject({ error: { code: "LEASE_EPOCH_STALE" } });
  });

  it("过期租约拒绝续约，并在下一次领取时恢复为新尝试", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
    try {
      const projectDo = makeDo();
      await projectDo.fetch(new Request("https://internal/internal/register_executor", {
        method: "POST",
        body: JSON.stringify(registration),
      }));
      await projectDo.fetch(new Request("https://internal/internal/submit_requirement", {
        method: "POST",
        body: JSON.stringify(graph),
      }));
      const leaseResponse = await projectDo.fetch(new Request("https://internal/internal/lease_task", {
        method: "POST",
        body: JSON.stringify({
          protocol_version: "1",
          executor_id: registration.executor_id,
          agent_kind: registration.agent_kind,
          capabilities: registration.capabilities,
          idempotency_key: "lease-expired-001",
        }),
      }));
      const leased = await json(leaseResponse);
      vi.advanceTimersByTime(181_000);

      const renew = await projectDo.fetch(new Request("https://internal/internal/renew_lease", {
        method: "POST",
        body: JSON.stringify({
          protocol_version: "1",
          task_id: "TASK-0001",
          attempt_id: leased.lease.attempt_id,
          executor_id: registration.executor_id,
          lease_epoch: leased.lease.lease_epoch,
          idempotency_key: "renew-expired-001",
        }),
      }));
      expect(renew.status).toBe(409);
      expect(await json(renew)).toMatchObject({ error: { code: "LEASE_EXPIRED" } });

      const reassignedResponse = await projectDo.fetch(new Request("https://internal/internal/lease_task", {
        method: "POST",
        body: JSON.stringify({
          protocol_version: "1",
          executor_id: registration.executor_id,
          agent_kind: registration.agent_kind,
          capabilities: registration.capabilities,
          idempotency_key: "lease-expired-002",
        }),
      }));
      expect(reassignedResponse.status).toBe(200);
      const reassigned = await json(reassignedResponse);
      expect(reassigned.lease.attempt_id).toBe("TASK-0001-A2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("记录心跳并支持重启后的租约归属查询", async () => {
    const projectDo = makeDo();
    await projectDo.fetch(new Request("https://internal/internal/register_executor", {
      method: "POST",
      body: JSON.stringify(registration),
    }));
    await projectDo.fetch(new Request("https://internal/internal/submit_requirement", {
      method: "POST",
      body: JSON.stringify(graph),
    }));
    const leaseResponse = await projectDo.fetch(new Request("https://internal/internal/lease_task", {
      method: "POST",
      body: JSON.stringify({
        protocol_version: "1",
        executor_id: registration.executor_id,
        agent_kind: registration.agent_kind,
        capabilities: registration.capabilities,
        idempotency_key: "lease-heartbeat-001",
      }),
    }));
    const leased = await json(leaseResponse);

    const heartbeat = await projectDo.fetch(new Request("https://internal/internal/executor_heartbeat", {
      method: "POST",
      body: JSON.stringify({
        protocol_version: "1",
        executor_id: registration.executor_id,
        state: "running",
        task_id: leased.lease.task_id,
        attempt_id: leased.lease.attempt_id,
        lease_epoch: leased.lease.lease_epoch,
        sent_at: "2026-09-21T00:00:30.000Z",
        idempotency_key: "heartbeat-001",
      }),
    }));
    expect(heartbeat.status).toBe(200);
    expect(await json(heartbeat)).toMatchObject({ accepted: true, executor_id: registration.executor_id });

    const ownershipUrl = new URL("https://internal/internal/query_ownership");
    ownershipUrl.search = new URLSearchParams({
      task_id: leased.lease.task_id,
      attempt_id: leased.lease.attempt_id,
      executor_id: registration.executor_id,
      lease_epoch: String(leased.lease.lease_epoch),
    }).toString();
    const ownership = await projectDo.fetch(new Request(ownershipUrl));
    expect(ownership.status).toBe(200);
    expect(await json(ownership)).toMatchObject({ ownership: "still_mine", lease_epoch: leased.lease.lease_epoch });
  });
});

describe("Worker route", () => {
  it("健康检查公开，业务路由需要 Bearer 认证", async () => {
    const worker = createCoordinatorWorker();
    const storage = new MemoryStorage();
    const stub = {
      fetch: (request: Request) => new ProjectDurableObject(makeState(storage), env).fetch(request),
    };
    const env: CoordinatorEnv = {
      COORDINATOR_API_TOKEN: "test-token",
      PROJECTS: {
        idFromName: () => ({}),
        get: () => stub,
      },
    };

    expect((await worker.fetch(new Request("https://api/health"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://api/v1/health"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://api/v1/projects/PROJECT-TEST/status"), env)).status).toBe(401);
    const authorized = await worker.fetch(
      new Request("https://api/v1/projects/PROJECT-TEST/status", {
        headers: { authorization: "Bearer test-token" },
      }),
      env,
    );
    expect(authorized.status).toBe(200);
  });

  it("执行器 Bearer token 不能冒充其他 executor_id", async () => {
    const worker = createCoordinatorWorker();
    const storage = new MemoryStorage();
    const env: CoordinatorEnv = {
      COORDINATOR_EXECUTOR_TOKENS_JSON: JSON.stringify({ "EXE-A-TEST": "executor-token" }),
      PROJECTS: {
        idFromName: () => ({}),
        get: () => ({ fetch: (request: Request) => new ProjectDurableObject(makeState(storage), env).fetch(request) }),
      },
    };
    const response = await worker.fetch(new Request("https://api/v1/projects/PROJECT-TEST/executors/register", {
      method: "POST",
      headers: { authorization: "Bearer executor-token", "content-type": "application/json" },
      body: JSON.stringify({ ...registration, executor_id: "EXE-B-OTHER" }),
    }), env);
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ error: { code: "EXECUTOR_IDENTITY_MISMATCH" } });
  });

  it("兼容 B 端已实现的嵌套资源路径", async () => {
    const worker = createCoordinatorWorker();
    const forwarded: string[] = [];
    const env: CoordinatorEnv = {
      COORDINATOR_API_TOKEN: "admin-token",
      PROJECTS: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (request: Request) => {
            forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response("{}", { headers: { "content-type": "application/json" } });
          },
        }),
      },
    };
    const headers = { authorization: "Bearer admin-token", "content-type": "application/json" };
    const calls = [
      ["https://api/v1/projects/PROJECT-TEST/tasks/TASK-0001/lease/renew", { task_id: "TASK-0001" }],
      ["https://api/v1/projects/PROJECT-TEST/executors/EXE-B-TEST/heartbeat", { executor_id: "EXE-B-TEST" }],
      ["https://api/v1/projects/PROJECT-TEST/tasks/TASK-0001/ownership", { task_id: "TASK-0001" }],
      [
        "https://api/v1/projects/PROJECT-TEST/tasks/TASK-0001/attempts/TASK-0001-A1/result",
        { task_id: "TASK-0001", attempt_id: "TASK-0001-A1" },
      ],
    ] as const;
    for (const [url, body] of calls) {
      const response = await worker.fetch(new Request(url, { method: "POST", headers, body: JSON.stringify(body) }), env);
      expect(response.status).toBe(200);
    }
    expect(forwarded).toEqual([
      "POST /internal/renew_lease",
      "POST /internal/executor_heartbeat",
      "POST /internal/query_ownership",
      "POST /internal/report_result",
    ]);
  });
});

async function post(project: ProjectDurableObject, action: string, body: unknown) {
  return project.fetch(new Request(`https://internal/internal/${action}`, { method: "POST", body: JSON.stringify(body) }));
}
const secondRegistration = { ...registration, executor_id: "EXE-B-TEST", agent_kind: "opencode" as const };
const leaseRequest = (executor = registration, key = "lease") => ({
  protocol_version: "1", executor_id: executor.executor_id, agent_kind: executor.agent_kind,
  capabilities: executor.capabilities, idempotency_key: key,
});
async function prepared(tasks: unknown[] = graph.tasks) {
  const project = makeDo();
  expect((await post(project, "register_executor", registration)).status).toBe(200);
  expect((await post(project, "register_executor", secondRegistration)).status).toBe(200);
  expect((await post(project, "submit_requirement", { ...graph, tasks })).status).toBe(201);
  return project;
}
function reportFor(lease: any, overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "1", ...binding, task_id: lease.task_id, attempt_id: lease.attempt_id,
    executor_id: lease.executor_id, lease_epoch: lease.lease_epoch, agent_kind: lease.agent_kind,
    head_sha: "5".repeat(40), status: "ready_for_integration", evidence_id: "EV-1",
    evidence: { evidence_id: "EV-1", command: ["npm", "test"], exit_code: 0, summary: { passed: 1, failed: 0, skipped: 0 } },
    commit_shas: ["5".repeat(40)], changed_files: ["src/a.ts"], error_code: null,
    reported_at: new Date().toISOString(), ...overrides,
  };
}

describe("A 审计：调度、恢复和验收边界", () => {
  it("禁止同一个执行器领取第二个活动任务", async () => {
    const project = await prepared([graph.tasks[0], { ...graph.tasks[0], task_id: "TASK-0002", write_scope: { allow: ["other/**"], deny: [] } }]);
    await post(project, "lease_task", leaseRequest());
    expect((await post(project, "lease_task", leaseRequest(registration, "second"))).status).toBe(409);
  });

  it.each(["src/**", "SRC/**"])("不同执行器不能并行领取重叠范围 %s", async (allow) => {
    const project = await prepared([graph.tasks[0], { ...graph.tasks[0], task_id: "TASK-0002", write_scope: { allow: [allow], deny: [] } }]);
    await post(project, "lease_task", leaseRequest());
    expect(await json(await post(project, "lease_task", leaseRequest(secondRegistration as any)))).toMatchObject({ task: null });
  });

  it("互不重叠任务可以并行；不同执行器可使用相同幂等键", async () => {
    const project = await prepared([graph.tasks[0], { ...graph.tasks[0], task_id: "TASK-0002", write_scope: { allow: ["other/**"], deny: [] } }]);
    await post(project, "lease_task", leaseRequest());
    expect(await json(await post(project, "lease_task", leaseRequest(secondRegistration as any)))).toMatchObject({ task: { task_id: "TASK-0002" } });
  });

  it("重启注册允许新的 registered_at；持有租约时不能改变配置", async () => {
    const project = await prepared();
    await post(project, "lease_task", leaseRequest());
    expect((await post(project, "register_executor", { ...registration, registered_at: "2026-09-25T00:00:00.000Z" })).status).toBe(200);
    expect((await post(project, "register_executor", { ...registration, project_root: "E:/other" })).status).toBe(409);
  });

  it("领取请求能力缩减时不使用陈旧注册能力派发", async () => {
    const project = await prepared();
    expect(await json(await post(project, "lease_task", { ...leaseRequest(), capabilities: ["code"] }))).toMatchObject({ task: null });
  });

  it.each(["passed", "merged", "leased"])("新任务图不能预置运行/通过状态 %s", async (status) => {
    expect((await post(makeDo(), "submit_requirement", { ...graph, tasks: [{ ...graph.tasks[0], status }] })).status).toBe(422);
  });

  it("拒绝含路径穿越的写入范围", async () => {
    expect((await post(makeDo(), "submit_requirement", { ...graph, tasks: [{ ...graph.tasks[0], write_scope: { allow: ["src/../private/**"], deny: [] } }] })).status).toBe(422);
  });

  it("过期的领取/续约/心跳不能通过旧幂等键重新获得成功", async () => {
    vi.useFakeTimers();
    try {
      const project = await prepared();
      const { lease } = await json(await post(project, "lease_task", leaseRequest()));
      const renew = { protocol_version: "1", task_id: lease.task_id, attempt_id: lease.attempt_id,
        executor_id: lease.executor_id, lease_epoch: lease.lease_epoch, idempotency_key: "renew" };
      const heartbeat = { ...renew, state: "running", sent_at: new Date().toISOString(), idempotency_key: "heartbeat" };
      expect((await post(project, "renew_lease", renew)).status).toBe(200);
      expect((await post(project, "executor_heartbeat", heartbeat)).status).toBe(200);
      vi.advanceTimersByTime(181_000);
      expect((await post(project, "renew_lease", renew)).status).toBe(409);
      expect((await post(project, "executor_heartbeat", heartbeat)).status).toBe(409);
      expect((await post(project, "lease_task", leaseRequest())).status).toBe(409);
      const status = await json(await project.fetch(new Request("https://internal/internal/status")));
      expect(status.graph.tasks[0]).toMatchObject({ status: "ready", assigned_executor: null });
      expect(await json(await post(project, "lease_task", leaseRequest(registration, "new")))).toMatchObject({ lease: { lease_epoch: 2 } });
    } finally { vi.useRealTimers(); }
  });

  it("续租不会改写之前领取的幂等响应", async () => {
    vi.useFakeTimers();
    try {
      const project = await prepared();
      const { lease } = await json(await post(project, "lease_task", leaseRequest()));
      vi.advanceTimersByTime(10_000);
      await post(project, "renew_lease", { protocol_version: "1", task_id: lease.task_id, attempt_id: lease.attempt_id,
        executor_id: lease.executor_id, lease_epoch: lease.lease_epoch, idempotency_key: "renew" });
      expect(await json(await post(project, "lease_task", leaseRequest()))).toMatchObject({ lease: { expires_at: lease.expires_at } });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["AUTH_EXPIRED", "blocked_auth"], ["QUOTA_EXHAUSTED", "blocked_quota"],
    ["UNAUTHORIZED_OPERATION", "blocked_approval"], ["ACCEPTANCE_TAMPERED", "needs_input"],
    ["INTERNAL_ERROR", "needs_input"], ["RATE_LIMITED", "needs_input"], ["TESTS_FAILED", "repair_pending"],
  ])("按错误策略处理 %s，不接受任意 failed 分类", async (error_code, status) => {
    const project = await prepared();
    const { lease } = await json(await post(project, "lease_task", leaseRequest()));
    const response = await post(project, "report_result", reportFor(lease, { status: "failed", error_code }));
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ status });
  });

  it.each([
    { agent_kind: "opencode" }, { evidence_id: "OTHER" }, { commit_shas: [] },
    { error_code: "TESTS_FAILED" }, { changed_files: ["../secret"] }, { changed_files: ["src/.env"] },
  ])("拒绝不一致或越界成功报告 %j", async (overrides) => {
    const project = await prepared();
    const { lease } = await json(await post(project, "lease_task", leaseRequest()));
    expect((await post(project, "report_result", reportFor(lease, overrides))).status).toBeGreaterThanOrEqual(400);
  });

  it("批次只接受当前项目已交付候选，且一次只能一个 pending", async () => {
    const project = await prepared();
    const { lease } = await json(await post(project, "lease_task", leaseRequest()));
    const batch = { batch_id: "BATCH-0001", project_id: graph.project_id, ...binding, candidate_heads: ["5".repeat(40)],
      trusted_workflow: `.github/workflows/integration.yml@${"a".repeat(40)}`, created_at: new Date().toISOString(), conclusion: "pending" };
    expect((await post(project, "integration_batch", batch)).status).toBe(422);
    expect((await post(project, "report_result", reportFor(lease))).status).toBe(200);
    expect((await post(project, "integration_batch", { ...batch, conclusion: "passed" })).status).toBe(422);
    expect((await post(project, "integration_batch", { ...batch, project_id: "OTHER" })).status).toBe(422);
    expect((await post(project, "integration_batch", batch)).status).toBe(201);
    expect((await post(project, "integration_batch", { ...batch, batch_id: "BATCH-0002" })).status).toBe(409);
  });

  it("GitHub 事件入口拒绝跨项目和非 GitHub 事件", async () => {
    const project = await prepared();
    const event = { event_id: "event", event_type: "batch.passed", protocol_version: "1", project_id: graph.project_id, occurred_at: new Date().toISOString() };
    expect((await post(project, "github_event", event)).status).toBe(422);
    expect((await post(project, "github_event", { ...event, event_type: "github.workflow_run", project_id: "OTHER" })).status).toBe(422);
  });
});

describe("A 审计：Worker 权限和路径边界", () => {
  const makeEnv = (fetch: (request: Request) => Promise<Response>): CoordinatorEnv => ({
    COORDINATOR_API_TOKEN: "admin", COORDINATOR_EXECUTOR_TOKENS_JSON: JSON.stringify({ "EXE-A-TEST": "executor" }),
    PROJECTS: { idFromName: () => ({ toString: () => "PROJECT-TEST" }), get: () => ({ fetch }) },
  });
  it.each(["requirements/submit", "batches", "events/github"])("执行器不能调用管理路由 %s", async (route) => {
    const forward = vi.fn(async () => new Response("{}"));
    const response = await createCoordinatorWorker().fetch(new Request(`https://api/v1/projects/PROJECT-TEST/${route}`, {
      method: "POST", headers: { authorization: "Bearer executor" }, body: "{}",
    }), makeEnv(forward));
    expect(response.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });
  it("畸形百分号编码返回 400 而不抛异常", async () => {
    const response = await createCoordinatorWorker().fetch(new Request("https://api/v1/projects/%ZZ/status"), makeEnv(async () => new Response()));
    expect(response.status).toBe(400);
  });
  it("嵌套 GET ownership 路径和 query 必须一致", async () => {
    const response = await createCoordinatorWorker().fetch(new Request("https://api/v1/projects/P/tasks/TASK-0001/ownership?task_id=TASK-0002&executor_id=EXE-A-TEST", {
      headers: { authorization: "Bearer executor" },
    }), makeEnv(async () => new Response()));
    expect(response.status).toBe(409);
  });
});
