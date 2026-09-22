/**
 * 协调器 HTTP 客户端契约测试（CP-0001）。
 *
 * 用**假 fetch** 驱动，不启动真实服务端。重点覆盖：
 * 1. 认证头与路径形态（契约 §统一规则）
 * 2. 幂等键在重试中**保持不变**（否则幂等保护失效）
 * 3. 状态码 → 错误码 → 可重试性 的映射（契约 §重试规则）
 * 4. 凭据绝不进错误信息（红线）
 * 5. 三个适配器把 HTTP 应答正确翻译为内核语义
 */

import { describe, expect, it } from "vitest";
import {
  CoordinatorClient,
  CoordinatorHttpError,
  MissingConfigError,
  backoffDelay,
  classifyHttpStatus,
  loadExecutorConfig,
  parseRetryAfter,
  redactSecrets,
  DEFAULT_RETRY_POLICY,
} from "../../apps/executor/src/transport/http.js";
import {
  HttpHeartbeatTransport,
  HttpLeaseTransport,
  HttpRecoveryTransport,
  HttpResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import type { HeartbeatRequest } from "../../apps/executor/src/core/heartbeat.js";

/* ------------------------------------------------------------------ *
 * 假 fetch
 * ------------------------------------------------------------------ */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeResponseSpec {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * 按脚本依次返回响应。
 *
 * 特意记录**每一次**请求，用于断言重试时 URL/body 不变（幂等前提）。
 */
class FakeFetch {
  readonly captured: CapturedRequest[] = [];
  private index = 0;

  constructor(private readonly script: Array<FakeResponseSpec | Error>) {}

  get calls(): number {
    return this.captured.length;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let parsedBody: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    this.captured.push({ url, method: init?.method ?? "GET", headers, body: parsedBody });

    const next = this.script[this.index] ?? this.script[this.script.length - 1]!;
    this.index += 1;
    if (next instanceof Error) throw next;

    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: {
        get: (name: string) => next.headers?.[name.toLowerCase()] ?? null,
      },
      text: async () => text,
    } as unknown as Response;
  }
}

function makeClient(
  fake: FakeFetch,
  overrides: Partial<ConstructorParameters<typeof CoordinatorClient>[0]> = {},
  sleeps: number[] = [],
): CoordinatorClient {
  return new CoordinatorClient(
    {
      base_url: "https://coord.example.workers.dev",
      project_id: "dac-demo",
      executor_id: "EXE-B-DESKTOP",
      token: "super-secret-token",
      ...overrides,
    },
    {
      fetch: fake.fetch.bind(fake),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5, // 固定抖动，便于断言
      now: () => 1_700_000_000_000,
    },
  );
}

/* ------------------------------------------------------------------ *
 * 配置装载
 * ------------------------------------------------------------------ */

describe("loadExecutorConfig", () => {
  it("四个变量齐全时正常返回，并去掉 base_url 尾部斜杠", () => {
    const config = loadExecutorConfig({
      COORDINATOR_BASE_URL: "https://x.workers.dev///",
      PROJECT_ID: "p1",
      EXECUTOR_ID: "EXE-B",
      COORDINATOR_API_TOKEN: "t0ken",
    });
    expect(config.base_url).toBe("https://x.workers.dev");
    expect(config.project_id).toBe("p1");
    expect(config.executor_id).toBe("EXE-B");
  });

  it("缺变量时抛 MissingConfigError 并列出全部缺失项（不提供占位默认值）", () => {
    try {
      loadExecutorConfig({ PROJECT_ID: "p1" });
      expect.unreachable("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigError);
      const missing = (error as MissingConfigError).missing;
      // token 缺失必须被点名——避免「用空 token 请求然后收到 401」把配置问题伪装成认证问题
      expect(missing).toContain("COORDINATOR_API_TOKEN");
      expect(missing).toContain("COORDINATOR_BASE_URL");
      expect(missing).toContain("EXECUTOR_ID");
    }
  });

  it("只有空白字符视为未设置", () => {
    expect(() =>
      loadExecutorConfig({
        COORDINATOR_BASE_URL: "https://x",
        PROJECT_ID: "p1",
        EXECUTOR_ID: " ",
        COORDINATOR_API_TOKEN: "t",
      }),
    ).toThrow(MissingConfigError);
  });
});

/* ------------------------------------------------------------------ *
 * 凭据屏蔽
 * ------------------------------------------------------------------ */

describe("redactSecrets", () => {
  it("抹掉已知 token", () => {
    const out = redactSecrets("failed with token=super-secret-token here", ["super-secret-token"]);
    expect(out).not.toContain("super-secret-token");
    expect(out).toContain("[REDACTED]");
  });

  it("兜底抹掉 Bearer 形态（即使不在已知列表里）", () => {
    const out = redactSecrets("Authorization: Bearer abc123.def-456_ghi", []);
    expect(out).toBe("Authorization: Bearer [REDACTED]");
  });
});

/* ------------------------------------------------------------------ *
 * 重试与退避
 * ------------------------------------------------------------------ */

describe("parseRetryAfter / backoffDelay", () => {
  it("解析秒数形式", () => {
    expect(parseRetryAfter("7")).toBe(7000);
  });

  it("解析 HTTP 日期形式", () => {
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    expect(parseRetryAfter("Mon, 21 Sep 2026 12:00:05 GMT", now)).toBe(5000);
  });

  it("无法解析时返回 null（不猜）", () => {
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("Retry-After 优先于指数退避，但受 max_delay 约束", () => {
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, 3000, () => 0.5)).toBe(3000);
    expect(backoffDelay(0, DEFAULT_RETRY_POLICY, 999_999, () => 0.5)).toBe(
      DEFAULT_RETRY_POLICY.max_delay_ms,
    );
  });

  it("指数退避随尝试次数增长", () => {
    const d0 = backoffDelay(0, DEFAULT_RETRY_POLICY, null, () => 0.5);
    const d1 = backoffDelay(1, DEFAULT_RETRY_POLICY, null, () => 0.5);
    const d2 = backoffDelay(2, DEFAULT_RETRY_POLICY, null, () => 0.5);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });
});

describe("classifyHttpStatus（与协议 ERROR_POLICY 保持一致）", () => {
  it("401/403 → AUTH_EXPIRED 且不可重试（blocked，不得返修）", () => {
    for (const status of [401, 403]) {
      const r = classifyHttpStatus(status);
      expect(r.code).toBe("AUTH_EXPIRED");
      expect(r.retryable).toBe(false);
    }
  });

  it("402 → QUOTA_EXHAUSTED 且不可重试", () => {
    const r = classifyHttpStatus(402);
    expect(r.code).toBe("QUOTA_EXHAUSTED");
    expect(r.retryable).toBe(false);
  });

  it("429 → RATE_LIMITED 且可重试", () => {
    const r = classifyHttpStatus(429);
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.retryable).toBe(true);
  });

  it("409 → LEASE_EPOCH_STALE 且**不重试**", () => {
    const r = classifyHttpStatus(409);
    expect(r.code).toBe("LEASE_EPOCH_STALE");
    expect(r.retryable).toBe(false);
  });

  it("400/422 → RESULT_SCHEMA_INVALID 且不盲目重试", () => {
    for (const status of [400, 422]) {
      const r = classifyHttpStatus(status);
      expect(r.code).toBe("RESULT_SCHEMA_INVALID");
      expect(r.retryable).toBe(false);
    }
  });

  it("502/503/504 → INTERNAL_ERROR 且可重试", () => {
    for (const status of [502, 503, 504]) {
      const r = classifyHttpStatus(status);
      expect(r.code).toBe("INTERNAL_ERROR");
      expect(r.retryable).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 请求形态
 * ------------------------------------------------------------------ */

describe("CoordinatorClient 请求形态", () => {
  it("路径以 /v1/projects/<project_id> 开头，project_id 做 URL 编码", async () => {
    const fake = new FakeFetch([{ status: 200, body: {} }]);
    const client = makeClient(fake, { project_id: "dac demo/1" });
    await client.request({ method: "POST", path: "/ping", body: {}, idempotency_key: "k" });
    expect(fake.captured[0]!.url).toBe(
      "https://coord.example.workers.dev/v1/projects/dac%20demo%2F1/ping",
    );
  });

  it("带 Authorization: Bearer 与 Content-Type", async () => {
    const fake = new FakeFetch([{ status: 200, body: {} }]);
    await makeClient(fake).request({
      method: "POST",
      path: "/x",
      body: { a: 1 },
      idempotency_key: "k",
    });
    const req = fake.captured[0]!;
    expect(req.headers["authorization"]).toBe("Bearer super-secret-token");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("204 空响应体返回 undefined 而不是抛解析错误", async () => {
    const fake = new FakeFetch([{ status: 204 }]);
    const out = await makeClient(fake).request({ method: "POST", path: "/x", body: {} });
    expect(out).toBeUndefined();
  });

  it("响应非 JSON 时归为 RESULT_SCHEMA_INVALID", async () => {
    const fake = new FakeFetch([{ status: 200, body: "not-json-object" }]);
    // 手动构造一个 text() 返回非法 JSON 的响应
    fake.fetch = (async (url: string, init?: RequestInit) => {
      fake.captured.push({ url, method: init?.method ?? "GET", headers: {}, body: undefined });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "<html>oops</html>",
      } as unknown as Response;
    }) as typeof fake.fetch;
    const client = makeClient(fake);
    await expect(
      client.request({ method: "POST", path: "/x", body: {}, idempotency_key: "k" }),
    ).rejects.toMatchObject({ code: "RESULT_SCHEMA_INVALID" });
  });
});

/* ------------------------------------------------------------------ *
 * 重试中的幂等键稳定性
 * ------------------------------------------------------------------ */

describe("重试语义", () => {
  it("可重试错误按策略重试，且**每次请求体完全相同**（幂等键不变）", async () => {
    const fake = new FakeFetch([
      { status: 503 },
      { status: 503 },
      { status: 200, body: { ok: true } },
    ]);
    const sleeps: number[] = [];
    const client = makeClient(fake, {}, sleeps);
    const body = { protocol_version: "1", idempotency_key: "fixed-key" };
    const out = await client.request({ method: "POST", path: "/x", body, idempotency_key: "fixed-key" });

    expect(out).toEqual({ ok: true });
    expect(fake.calls).toBe(3);
    // 关键：三次请求体字节级相同 → 服务端会识别为同一逻辑操作
    expect(fake.captured[1]!.body).toEqual(fake.captured[0]!.body);
    expect(fake.captured[2]!.body).toEqual(fake.captured[0]!.body);
    expect(sleeps).toHaveLength(2);
  });

  it("不可重试错误立刻放弃（401 只请求一次）", async () => {
    const fake = new FakeFetch([{ status: 401 }, { status: 200, body: {} }]);
    const client = makeClient(fake);
    await expect(
      client.request({ method: "POST", path: "/x", body: {}, idempotency_key: "k" }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED", retryable: false });
    expect(fake.calls).toBe(1);
  });

  it("409 立刻放弃（交由上层停子进程并查归属，不重试）", async () => {
    const fake = new FakeFetch([{ status: 409 }, { status: 200, body: {} }]);
    await expect(
      makeClient(fake).request({ method: "POST", path: "/x", body: {}, idempotency_key: "k" }),
    ).rejects.toMatchObject({ code: "LEASE_EPOCH_STALE" });
    expect(fake.calls).toBe(1);
  });

  it("retry:false 时网络错误也不重试", async () => {
    const fake = new FakeFetch([new Error("ECONNRESET"), { status: 200, body: {} }]);
    await expect(
      makeClient(fake).request({ method: "POST", path: "/x", body: {}, retry: false }),
    ).rejects.toBeInstanceOf(CoordinatorHttpError);
    expect(fake.calls).toBe(1);
  });

  it("尊重 Retry-After（秒）计算退避", async () => {
    const fake = new FakeFetch([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, body: {} },
    ]);
    const sleeps: number[] = [];
    await makeClient(fake, {}, sleeps).request({
      method: "POST",
      path: "/x",
      body: {},
      idempotency_key: "k",
    });
    expect(sleeps).toEqual([2000]);
  });

  it("耗尽重试次数后抛出最后一次错误", async () => {
    const fake = new FakeFetch([{ status: 503 }]);
    const sleeps: number[] = [];
    await expect(
      makeClient(fake, {}, sleeps).request({
        method: "POST",
        path: "/x",
        body: {},
        idempotency_key: "k",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 503 });
    expect(fake.calls).toBe(DEFAULT_RETRY_POLICY.max_retries + 1);
  });
});

/* ------------------------------------------------------------------ *
 * 凭据不进错误信息（红线）
 * ------------------------------------------------------------------ */

describe("凭据保护", () => {
  it("网络错误信息中不含 token", async () => {
    const fake = new FakeFetch([new Error("connect failed to super-secret-token.host")]);
    try {
      await makeClient(fake).request({
        method: "POST",
        path: "/x",
        body: {},
        retry: false,
      });
      expect.unreachable("应当抛错");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-token");
    }
  });

  it("HTTP 错误信息只含状态与方法路径，不含响应体或请求头", async () => {
    const fake = new FakeFetch([{ status: 500, body: { secret: "super-secret-token" } }]);
    try {
      await makeClient(fake).request({ method: "POST", path: "/x", body: {}, retry: false });
      expect.unreachable("应当抛错");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("HTTP 500");
      expect(message).not.toContain("super-secret-token");
      expect(message).not.toContain("Bearer");
    }
  });

  it("health() 不带认证头（契约：唯此端点免认证）", async () => {
    const fake = new FakeFetch([{ status: 200, body: { ok: true } }]);
    const result = await makeClient(fake).health();
    expect(result.ok).toBe(true);
    expect(fake.captured[0]!.headers["authorization"]).toBeUndefined();
    expect(fake.captured[0]!.url).toBe("https://coord.example.workers.dev/v1/health");
  });
});

/* ------------------------------------------------------------------ *
 * 适配器：HTTP → 内核语义
 * ------------------------------------------------------------------ */

describe("HttpLeaseTransport", () => {
  const leaseResponse = {
    status: 200,
    body: {
      task: { id: "TASK-0001" },
      lease: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: "EXE-B-DESKTOP",
        lease_epoch: 4,
        expires_at: "2026-09-21T12:10:00.000Z",
      },
    },
  };

  it("成功续租 → renewed，携带新 epoch 与到期时间", async () => {
    const fake = new FakeFetch([leaseResponse]);
    const out = await new HttpLeaseTransport(makeClient(fake)).renew("TASK-0001", "TASK-0001-A1", 3);
    expect(out).toEqual({
      kind: "renewed",
      expires_at: "2026-09-21T12:10:00.000Z",
      lease_epoch: 4,
    });
  });

  it("请求体带完整三元组 + executor_id + protocol_version", async () => {
    const fake = new FakeFetch([leaseResponse]);
    await new HttpLeaseTransport(makeClient(fake)).renew("TASK-0001", "TASK-0001-A1", 3);
    expect(fake.captured[0]!.body).toEqual({
      protocol_version: "1",
      task_id: "TASK-0001",
      attempt_id: "TASK-0001-A1",
      executor_id: "EXE-B-DESKTOP",
      lease_epoch: 3,
    });
    expect(fake.captured[0]!.url).toContain("/tasks/TASK-0001/lease/renew");
  });

  it("409 → lost(lease_epoch_stale)，且不重试", async () => {
    const fake = new FakeFetch([{ status: 409 }, { status: 200, body: {} }]);
    const out = await new HttpLeaseTransport(makeClient(fake)).renew("T", "T-A1", 1);
    expect(out).toEqual({ kind: "lost", reason: "lease_epoch_stale" });
    expect(fake.calls).toBe(1);
  });

  it("应答缺 expires_at → 不当作成功（避免拿着未知租约继续跑）", async () => {
    const fake = new FakeFetch([{ status: 200, body: { lease: { lease_epoch: 2 } } }]);
    await expect(
      new HttpLeaseTransport(makeClient(fake)).renew("T", "T-A1", 1),
    ).rejects.toMatchObject({ code: "RESULT_SCHEMA_INVALID" });
  });

  it("服务端 epoch 倒退 → 按丢失处理", async () => {
    const fake = new FakeFetch([
      { status: 200, body: { lease: { lease_epoch: 1, expires_at: "2026-09-21T12:00:00.000Z" } } },
    ]);
    const out = await new HttpLeaseTransport(makeClient(fake)).renew("T", "T-A1", 5);
    expect(out.kind).toBe("lost");
  });

  it("网络错误**不**转成丢失，而是上抛（交由 LeaseGuard 计数，避免抖动误停）", async () => {
    const fake = new FakeFetch([new Error("ECONNRESET")]);
    await expect(
      new HttpLeaseTransport(makeClient(fake)).renew("T", "T-A1", 1),
    ).rejects.toBeInstanceOf(CoordinatorHttpError);
  });

  it("401 **不**转成丢失（认证失效 ≠ 被抢走），上抛为 blocked 语义", async () => {
    const fake = new FakeFetch([{ status: 401 }]);
    await expect(
      new HttpLeaseTransport(makeClient(fake)).renew("T", "T-A1", 1),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("HttpHeartbeatTransport", () => {
  const request: HeartbeatRequest = {
    protocol_version: "1",
    executor_id: "EXE-B-DESKTOP",
    state: "running",
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    lease_epoch: 3,
    sent_at: "2026-09-21T12:00:00.000Z",
    idempotency_key: "heartbeat:EXE-B-DESKTOP:1:1700000000000",
  };

  it("按契约路径上报，键取自请求自身", async () => {
    const fake = new FakeFetch([{ status: 200, body: { ok: true } }]);
    await new HttpHeartbeatTransport(makeClient(fake)).send(request);
    expect(fake.captured[0]!.url).toContain("/executors/EXE-B-DESKTOP/heartbeat");
    expect(fake.captured[0]!.body).toMatchObject({
      state: "running",
      lease_epoch: 3,
      idempotency_key: "heartbeat:EXE-B-DESKTOP:1:1700000000000",
    });
  });
});

describe("HttpRecoveryTransport", () => {
  const query = {
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    executor_id: "EXE-B-DESKTOP",
    lease_epoch: 1,
  };

  it("still_mine 且带完整 lease → 透传", async () => {
    const fake = new FakeFetch([
      {
        status: 200,
        body: {
          ownership: "still_mine",
          lease: {
            task_id: "TASK-0001",
            attempt_id: "TASK-0001-A1",
            executor_id: "EXE-B-DESKTOP",
            lease_epoch: 1,
            expires_at: "2026-09-21T12:10:00.000Z",
            agent_kind: "opencode",
          },
        },
      },
    ]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out.kind).toBe("still_mine");
  });

  it("请求体带全四项（只传 task_id 会得到不准确结论）", async () => {
    const fake = new FakeFetch([{ status: 200, body: { ownership: "unknown_task" } }]);
    await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(fake.captured[0]!.body).toEqual({
      protocol_version: "1",
      attempt_id: "TASK-0001-A1",
      executor_id: "EXE-B-DESKTOP",
      lease_epoch: 1,
    });
  });

  it("reassigned 带当前持有者", async () => {
    const fake = new FakeFetch([
      {
        status: 200,
        body: {
          ownership: "reassigned",
          reason: "lease_expired_then_reassigned",
          to_executor: "EXE-A-LENOVO",
          attempt_id: "TASK-0001-A2",
          lease_epoch: 2,
        },
      },
    ]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out).toEqual({
      kind: "reassigned",
      reason: "lease_expired_then_reassigned",
      to_executor: "EXE-A-LENOVO",
      attempt_id: "TASK-0001-A2",
      lease_epoch: 2,
    });
  });

  it("reassigned 但无当前租约 → 三项 null（客户端仍需放手）", async () => {
    const fake = new FakeFetch([
      { status: 200, body: { ownership: "reassigned", reason: "released" } },
    ]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out).toEqual({
      kind: "reassigned",
      reason: "released",
      to_executor: null,
      attempt_id: null,
      lease_epoch: null,
    });
  });

  it("网络错误 → unreachable（恢复流程据此 halt_offline，不猜）", async () => {
    const fake = new FakeFetch([new Error("ETIMEDOUT")]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out.kind).toBe("unreachable");
  });

  it("无法识别的 ownership 取值 → unreachable（保守，不乐观认为仍归我）", async () => {
    const fake = new FakeFetch([{ status: 200, body: { ownership: "something_new" } }]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out.kind).toBe("unreachable");
  });

  it("still_mine 但缺 lease → unreachable（缺证据不得继续）", async () => {
    const fake = new FakeFetch([{ status: 200, body: { ownership: "still_mine" } }]);
    const out = await new HttpRecoveryTransport(makeClient(fake)).queryOwnership(query);
    expect(out.kind).toBe("unreachable");
  });
});

describe("HttpResultReporter", () => {
  it("幂等键是确定性的 report_result:<task>:<attempt>:<epoch>", async () => {
    const fake = new FakeFetch([{ status: 200, body: { accepted: true, state: "validating" } }]);
    await new HttpResultReporter(makeClient(fake)).report({
      task_id: "TASK-0001",
      attempt_id: "TASK-0001-A1",
      lease_epoch: 7,
      report: { status: "ready_for_integration" },
    });
    expect(fake.captured[0]!.body).toMatchObject({
      protocol_version: "1",
      executor_id: "EXE-B-DESKTOP",
      lease_epoch: 7,
    });
    // 确定性键：同一 attempt 重复上报会被服务端识别为同一操作
    expect(fake.captured[0]!.url).toContain("/tasks/TASK-0001/attempts/TASK-0001-A1/result");
  });

  it("旧 epoch 上报 → 409 上抛（说明该 attempt 已作废，不得伪装成功）", async () => {
    const fake = new FakeFetch([{ status: 409 }]);
    await expect(
      new HttpResultReporter(makeClient(fake)).report({
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        lease_epoch: 1,
        report: {},
      }),
    ).rejects.toMatchObject({ code: "LEASE_EPOCH_STALE" });
  });
});
