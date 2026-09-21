import { describe, expect, it, vi } from "vitest";
import { ProjectDurableObject } from "../../apps/coordinator/src/project-do.js";
import { createCoordinatorWorker, type CoordinatorEnv } from "../../apps/coordinator/src/worker.js";
import type { DurableObjectStorageLike, StorageTransactionLike } from "../../apps/coordinator/src/storage.js";

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

function makeDo() {
  return new ProjectDurableObject({ storage: new MemoryStorage() }, "PROJECT-TEST");
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
});

describe("Worker route", () => {
  it("健康检查公开，业务路由需要 Bearer 认证", async () => {
    const worker = createCoordinatorWorker();
    const storage = new MemoryStorage();
    const stub = {
      fetch: (request: Request) => new ProjectDurableObject({ storage }, "PROJECT-TEST").fetch(request),
    };
    const env: CoordinatorEnv = {
      COORDINATOR_API_TOKEN: "test-token",
      PROJECTS: {
        idFromName: () => ({}),
        get: () => stub,
      },
    };

    expect((await worker.fetch(new Request("https://api/health"), env)).status).toBe(200);
    expect((await worker.fetch(new Request("https://api/v1/projects/PROJECT-TEST/status"), env)).status).toBe(401);
    const authorized = await worker.fetch(
      new Request("https://api/v1/projects/PROJECT-TEST/status", {
        headers: { authorization: "Bearer test-token" },
      }),
      env,
    );
    expect(authorized.status).toBe(200);
  });
});
