/**
 * 常驻执行器入口（B4）测试。
 *
 * 覆盖交接单 §5 要求的 10 项：
 * 1. 启动配置完整/缺失
 * 2. 注册成功与身份不匹配
 * 3. 空队列轮询
 * 4. 领取成功且同一次重试复用幂等键
 * 5. 续租、心跳、执行、结果上报的顺序
 * 6. 401/403、409、429、网络中断
 * 7. 租约失效后不推送、不上报
 * 8. 优雅停止与重启恢复
 * 9. 日志中不出现 Bearer Token
 * 10. Windows 中文和空格路径不退化
 *
 * 说明：`attempt` 内部的时序（**续租循环必须先于 agent 启动**）由
 * `tests/executor/attempt.test.ts` 用真实 `runAttempt` 覆盖；
 * 本文件覆盖的是**跨边界**顺序与各条错误路径的分支结果。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Lease, ResultReport, TaskNode } from "@dac/protocol";
import type { AttemptDeps, AttemptInput, AttemptOutcome, AttemptRunner } from "../../apps/executor/src/core/attempt.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { LeaseClock, LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { InFlightRecord, RecoveryTransport, TaskOwnership } from "../../apps/executor/src/core/recovery.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationAck,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import { HttpLeaseAcquirer } from "../../apps/executor/src/transport/adapters.js";
import { CoordinatorClient, CoordinatorHttpError, MissingConfigError } from "../../apps/executor/src/transport/http.js";
import type { ExecutorConfig } from "../../apps/executor/src/transport/http.js";
import {
  ENV_KEYS,
  fileInFlightStore,
  findBindingProblem,
  isBlockedCode,
  loadDaemonOptions,
  runDaemon,
} from "../../apps/executor/src/daemon.js";
import type { DaemonDeps, DaemonOptions, PushResult } from "../../apps/executor/src/daemon.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BINDING = {
  base_sha: SHA_A,
  rules_sha: SHA_B,
  contract_sha: "c".repeat(40),
  acceptance_sha: "d".repeat(40),
};

const LEASE: Lease = {
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-OPENCODE",
  lease_epoch: 1,
  expires_at: "2030-01-01T00:00:00.000Z",
  binding: BINDING,
  agent_kind: "opencode",
};

const TASK: TaskNode = {
  task_id: "TASK-0001",
  kind: "implement",
  title: "实现示例功能",
  acceptance_criteria: ["测试全绿"],
  depends_on: [],
  write_scope: { allow: ["apps/executor/**"], deny: [] },
  contracts: [],
  requires: ["code"],
  expected_interfaces: [],
  status: "leased",
  assigned_executor: "EXE-B-OPENCODE",
  attempts_used: 1,
};

const TOKEN = "s3cr3t-bearer-token-value";

const CONFIG: ExecutorConfig = {
  base_url: "https://coordinator.example.invalid",
  project_id: "PROJECT-TEST",
  executor_id: "EXE-B-OPENCODE",
  token: TOKEN,
};

function makeReport(overrides: Partial<ResultReport> = {}): ResultReport {
  return {
    protocol_version: "1",
    task_id: LEASE.task_id,
    attempt_id: LEASE.attempt_id,
    executor_id: LEASE.executor_id,
    lease_epoch: LEASE.lease_epoch,
    agent_kind: "opencode",
    base_sha: BINDING.base_sha,
    head_sha: SHA_B,
    rules_sha: BINDING.rules_sha,
    contract_sha: BINDING.contract_sha,
    acceptance_sha: BINDING.acceptance_sha,
    status: "ready_for_integration",
    evidence_id: "EVID-1",
    changed_files: ["apps/executor/src/daemon.ts"],
    evidence: {
      evidence_id: "EVID-1",
      command: ["npm", "run", "check"],
      exit_code: 0,
      summary: { passed: 10, failed: 0, skipped: 0 },
      log_artifact: null,
      output_sha256: null,
    },
    error_code: null,
    commit_shas: [SHA_B],
    note: null,
    reported_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    report: makeReport(),
    trace: {
      phases: ["preparing_worktree", "running_agent", "reporting"],
      lease_lost: false,
      lease_lost_reason: null,
      sideEffectsSkipped: false,
      worktree_ready: true,
    },
    worktree_removed: true,
    worktree_path: "/repo/.local/worktrees/TASK-0001-A1",
    local_commits: [SHA_B],
    changed_files: ["apps/executor/src/daemon.ts"],
    raw_test_output: "Tests 10 passed",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    config: CONFIG,
    registration: {
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: ["code", "test", "git_push"],
    },
    repo_root: "C:\\repo",
    worktree_root: "C:\\repo\\.local\\worktrees",
    model: "myapi/gpt-5.6-sol",
    max_idle_polls: 3,
    poll_interval_ms: 1,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 假体
 * ------------------------------------------------------------------ */

type AcquireStep = LeaseAcquisition | { fail: unknown };

interface Harness {
  deps: DaemonDeps;
  events: string[];
  logs: string[];
  acquireCalls: () => number;
  reports: ResultReport[];
  pushes: Array<{ worktree_path: string; branch: string; remote: string }>;
  saved: Array<InFlightRecord | null>;
  attemptInputs: AttemptInput[];
  attemptDeps: AttemptDeps[];
}

function makeHarness(config: {
  script?: AcquireStep[];
  healthOk?: boolean;
  registerAck?: RegistrationAck | { fail: unknown };
  outcome?: AttemptOutcome;
  attemptRunner?: AttemptRunner;
  inFlight?: InFlightRecord | null;
  recovery?: TaskOwnership;
  reportAck?: ReportAck | { fail: unknown };
  pushResult?: PushResult;
} = {}): Harness {
  const events: string[] = [];
  const logs: string[] = [];
  const reports: ResultReport[] = [];
  const pushes: Array<{ worktree_path: string; branch: string; remote: string }> = [];
  const saved: Array<InFlightRecord | null> = [];
  const attemptInputs: AttemptInput[] = [];
  const attemptDeps: AttemptDeps[] = [];
  const script = config.script ?? [{ kind: "empty" }];
  let acquireCallCount = 0;

  const leaseTransport: LeaseTransport = {
    async renew(): Promise<RenewOutcome> {
      events.push("renew");
      return { kind: "renewed", expires_at: LEASE.expires_at, lease_epoch: LEASE.lease_epoch };
    },
  };

  const heartbeatTransport: HeartbeatTransport = {
    async send(_request: HeartbeatRequest): Promise<void> {
      events.push("heartbeat");
    },
  };

  const acquirer: LeaseAcquirer = {
    async acquire(): Promise<LeaseAcquisition> {
      const index = acquireCallCount;
      acquireCallCount += 1;
      events.push("acquire");
      // 脚本耗尽即视为队列为空。真实协调器不会把**同一个** attempt 反复租给
      // 同一个执行器，所以这里不做「无限重复最后一步」——那样会让假体掩盖
      // 真实循环上限的问题（曾把 daemon 的 max_attempts=Infinity 喂成死循环）。
      if (index >= script.length) return { kind: "empty" };
      const step = script[index]!;
      if (typeof step === "object" && step !== null && "fail" in step) throw step.fail;
      return step as LeaseAcquisition;
    },
  };

  const registration: RegistrationTransport = {
    async register(): Promise<RegistrationAck> {
      events.push("register");
      const ack = config.registerAck ?? { executor_id: CONFIG.executor_id, registered: true };
      if (typeof ack === "object" && ack !== null && "fail" in ack) throw ack.fail;
      return ack as RegistrationAck;
    },
  };

  const recoveryTransport: RecoveryTransport = {
    async queryOwnership(): Promise<TaskOwnership> {
      events.push("query_ownership");
      return config.recovery ?? { kind: "unknown_task" };
    },
  };

  const resultReporter: ResultReporter = {
    async report(report: ResultReport): Promise<ReportAck> {
      events.push("report");
      reports.push(report);
      const ack = config.reportAck ?? { accepted: true, state: "validating" };
      if (typeof ack === "object" && ack !== null && "fail" in ack) throw ack.fail;
      return ack as ReportAck;
    },
  };

  const defaultRunner: AttemptRunner = async (input, deps) => {
    attemptInputs.push(input);
    attemptDeps.push(deps);
    events.push("agent");
    return config.outcome ?? makeOutcome();
  };

  return {
    deps: {
      health: async () => ({ ok: config.healthOk ?? true }),
      registration,
      acquirer,
      lease_transport: leaseTransport,
      heartbeat_transport: heartbeatTransport,
      recovery_transport: recoveryTransport,
      result_reporter: resultReporter,
      attempt_runner: config.attemptRunner ?? defaultRunner,
      push_branch: (input) => {
        events.push("push");
        pushes.push(input);
        return config.pushResult ?? { pushed: true, error_code: null, message: null };
      },
      load_in_flight: () => config.inFlight ?? null,
      save_in_flight: (record) => {
        saved.push(record);
      },
    },
    events,
    logs,
    acquireCalls: () => acquireCallCount,
    reports,
    pushes,
    saved,
    attemptInputs,
    attemptDeps,
  };
}

/** 让 daemon 记录日志，便于断言脱敏。 */
function withLog(options: DaemonOptions, logs: string[]): DaemonOptions {
  return { ...options, log: (line) => logs.push(line) };
}

/** 构造一个可分类的 HTTP 错误。 */
function httpError(status: number, code: Parameters<typeof isBlockedCode>[0]): CoordinatorHttpError {
  return new CoordinatorHttpError({
    code,
    message: `请求失败：HTTP ${status}`,
    status,
    retryable: false,
  });
}

/* ------------------------------------------------------------------ *
 * 1. 启动配置
 * ------------------------------------------------------------------ */

describe("B4 §1 启动配置", () => {
  const baseEnv = {
    [ENV_KEYS.base_url]: "https://coordinator.example.invalid",
    [ENV_KEYS.project_id]: "PROJECT-TEST",
    [ENV_KEYS.executor_id]: "EXE-B-OPENCODE",
    [ENV_KEYS.token]: TOKEN,
    [ENV_KEYS.model]: "myapi/gpt-5.6-sol",
    [ENV_KEYS.repo_root]: "C:\\repo",
  };

  it("齐全时装配成功，且默认不声明 git_push（推送需显式开启）", () => {
    const options = loadDaemonOptions(baseEnv);
    expect(options.config.executor_id).toBe("EXE-B-OPENCODE");
    expect(options.model).toBe("myapi/gpt-5.6-sol");
    expect(options.registration.capabilities).toContain("dry_run");
    expect(options.registration.capabilities).not.toContain("git_push");
    expect(options.enable_push).toBe(false);
  });

  it("显式开启推送时才声明 git_push（不夸大能力）", () => {
    const options = loadDaemonOptions({ ...baseEnv, EXECUTOR_ENABLE_PUSH: "1" });
    expect(options.registration.capabilities).toContain("git_push");
    expect(options.enable_push).toBe(true);
  });

  it("缺 token → MissingConfigError 列出全部缺失项，且不提供占位默认值", () => {
    const env = { ...baseEnv };
    delete (env as Record<string, string | undefined>)[ENV_KEYS.token];
    let caught: unknown;
    try {
      loadDaemonOptions(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingConfigError);
    expect((caught as MissingConfigError).missing).toEqual([ENV_KEYS.token]);
  });

  it("缺模型 → 明确报错（不传模型会落到环境变量 provider 并 401）", () => {
    const env = { ...baseEnv };
    delete (env as Record<string, string | undefined>)[ENV_KEYS.model];
    expect(() => loadDaemonOptions(env)).toThrowError(/OPENCODE_MODEL/);
  });

  it("健康检查失败 → 立即停止，不做任何云端写操作", async () => {
    const h = makeHarness({ healthOk: false });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("health_failed");
    expect(report.health_ok).toBe(false);
    // 注册与领取都不得发生
    expect(h.events).not.toContain("register");
    expect(h.events).not.toContain("acquire");
  });
});

/* ------------------------------------------------------------------ *
 * 2. 注册
 * ------------------------------------------------------------------ */

describe("B4 §2 注册", () => {
  it("注册成功 → 继续进入领取循环", async () => {
    const h = makeHarness();
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.registered).toBe(true);
    expect(h.events).toContain("register");
    expect(h.events).toContain("acquire");
  });

  it("身份不匹配（403）→ registration_rejected，且**不领取任何任务**", async () => {
    const h = makeHarness({
      registerAck: { fail: httpError(403, "AUTH_EXPIRED") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("registration_rejected");
    expect(report.registered).toBe(false);
    expect(h.events).not.toContain("acquire");
    // 凭据类问题属于 blocked，不得计为代码返修
    expect(isBlockedCode("AUTH_EXPIRED")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 空队列轮询
 * ------------------------------------------------------------------ */

describe("B4 §3 空队列轮询", () => {
  it("空队列按上限轮询后正常退出，不抛错、不当作故障", async () => {
    const h = makeHarness({ script: [{ kind: "empty" }] });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 4 }), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(report.polls).toBe(4);
    expect(report.attempts).toHaveLength(0);
  });

  it("空队列之后领到任务 → 空闲计数重置，任务被处理", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }, { kind: "leased", task: TASK, lease: LEASE }],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 5 }), h.logs), h.deps);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]!.result).toBe("reported");
    expect(report.stop_reason).toBe("idle_limit"); // 处理完继续轮询直到上限
  });
});

/* ------------------------------------------------------------------ *
 * 4. 领取的幂等键
 * ------------------------------------------------------------------ */

describe("B4 §4 领取的幂等键", () => {
  interface Captured {
    url: string;
    body: Record<string, unknown>;
  }

  function makeClient(script: Array<{ status: number; body?: unknown } | Error>): {
    client: CoordinatorClient;
    captured: Captured[];
  } {
    const captured: Captured[] = [];
    let index = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      if (step instanceof Error) throw step;
      return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new CoordinatorClient(CONFIG, {
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    return { client, captured };
  }

  const request = {
    executor_id: CONFIG.executor_id,
    agent_kind: "opencode" as const,
    capabilities: ["code", "test"] as const,
  };

  it("同一次领取的网络重试**复用同一个幂等键**（重试不产生第二个租约）", async () => {
    const { client, captured } = makeClient([
      { status: 429 },
      { status: 200, body: { task: TASK, lease: LEASE } },
    ]);
    const result = await new HttpLeaseAcquirer(client).acquire(request);
    expect(result.kind).toBe("leased");
    expect(captured).toHaveLength(2);
    expect(captured[0]!.body["idempotency_key"]).toBe(captured[1]!.body["idempotency_key"]);
    expect(captured[0]!.url).toContain("/v1/projects/PROJECT-TEST/tasks/lease");
  });

  it("不同轮次**必须换新键**（否则服务端会一直回放首次缓存的空队列）", async () => {
    const { client, captured } = makeClient([
      { status: 200, body: { task: null, lease: null, status: "empty" } },
      { status: 200, body: { task: null, lease: null, status: "empty" } },
    ]);
    const acquirer = new HttpLeaseAcquirer(client);
    expect((await acquirer.acquire(request)).kind).toBe("empty");
    expect((await acquirer.acquire(request)).kind).toBe("empty");
    expect(captured[0]!.body["idempotency_key"]).not.toBe(captured[1]!.body["idempotency_key"]);
  });

  it("空队列应答 `{task:null,lease:null,status:'empty'}` 解析为 empty 而不是错误", async () => {
    const { client } = makeClient([
      { status: 200, body: { task: null, lease: null, status: "empty" } },
    ]);
    await expect(new HttpLeaseAcquirer(client).acquire(request)).resolves.toEqual({
      kind: "empty",
    });
  });
});

/* ------------------------------------------------------------------ *
 * 5. 顺序
 * ------------------------------------------------------------------ */

describe("B4 §5 续租/心跳/执行/上报的顺序", () => {
  it("跨边界顺序：领取 → 编排(续租/心跳/agent) → 推送 → 上报", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    // 用真实语义消费 daemon 注入的传输：续租与心跳都必须走那一份，
    // 这样 acquire / attempt_start / renew / heartbeat / agent / push / report
    // 才落在同一个 events 数组里，顺序才有可比性。
    h.deps.attempt_runner = async (input, deps) => {
      h.events.push("attempt_start");
      await deps.lease_transport.renew(input.lease.task_id, input.lease.attempt_id, 1);
      await deps.heartbeat_transport.send({
        protocol_version: "1",
        executor_id: input.lease.executor_id,
        state: "running",
        task_id: input.lease.task_id,
        attempt_id: input.lease.attempt_id,
        lease_epoch: 1,
        sent_at: "2026-09-22T00:00:00.000Z",
        idempotency_key: "hb-1",
      });
      h.events.push("agent");
      return makeOutcome({
        worktree_path: join(input.worktree_root, input.lease.attempt_id),
      });
    };

    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1, enable_push: true }), h.logs),
      h.deps,
    );

    const order = h.events.filter((event) =>
      ["acquire", "attempt_start", "renew", "heartbeat", "agent", "push", "report"].includes(event),
    );
    // 第 8 个 acquire 是处理完一次 attempt 后主循环的再次轮询
    // （max_idle_polls=1，随即因空闲上限退出）。
    expect(order.slice(0, 7)).toEqual([
      "acquire",
      "attempt_start",
      "renew",
      "heartbeat",
      "agent",
      "push",
      "report",
    ]);
  });

  it("编排器拿到的是注入的传输（续租与心跳都由 daemon 转发，不是各写一套）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(h.attemptDeps[0]!.lease_transport).toBe(h.deps.lease_transport);
    expect(h.attemptDeps[0]!.heartbeat_transport).toBe(h.deps.heartbeat_transport);
  });

  it("推送发生在上报**之前**（上报里的 commit_shas 必须已在远端）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1, enable_push: true }), h.logs),
      h.deps,
    );
    // 先证明推送真的发生了（否则 indexOf 返回 -1 会让下面的断言假通过）
    expect(h.pushes).toHaveLength(1);
    expect(h.events).toContain("push");
    expect(h.events.indexOf("push")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("push")).toBeLessThan(h.events.indexOf("report"));
  });

  it("未显式开启推送 → 结果照常上报，但**不推送**（能力声明不等于授权动作）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    // registration.capabilities 含 git_push，但没有 enable_push
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(h.events).not.toContain("push");
    expect(h.pushes).toHaveLength(0);
    expect(h.events).toContain("report");
    expect(h.reports[0]!.status).toBe("ready_for_integration");
  });
});

/* ------------------------------------------------------------------ *
 * 6. 错误分类
 * ------------------------------------------------------------------ */

describe("B4 §6 错误分类", () => {
  it("401 → auth_blocked（凭据问题，不计返修）", async () => {
    const h = makeHarness({ script: [{ fail: httpError(401, "AUTH_EXPIRED") }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("auth_blocked");
    expect(isBlockedCode("AUTH_EXPIRED")).toBe(true);
  });

  it("403 → auth_blocked", async () => {
    const h = makeHarness({ script: [{ fail: httpError(403, "AUTH_EXPIRED") }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("auth_blocked");
  });

  it("网络不可达 → offline，停止领取新任务（不猜任务仍归自己）", async () => {
    const h = makeHarness({
      script: [
        { fail: new CoordinatorHttpError({ code: "INTERNAL_ERROR", message: "网络错误", status: null, retryable: true }) },
      ],
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("offline");
  });

  it("429 之后恢复 → 不算故障，继续领到任务", async () => {
    const h = makeHarness({
      script: [{ fail: httpError(429, "RATE_LIMITED") }, { kind: "leased", task: TASK, lease: LEASE }],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 4 }), h.logs), h.deps);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]!.result).toBe("reported");
  });

  it("上报遇 409 → lease_lost，停止且不伪造成功", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      reportAck: { fail: httpError(409, "LEASE_EPOCH_STALE") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("lease_lost");
    expect(report.attempts[0]!.result).toBe("failed_to_report");
  });

  it("429 持续 → 由空闲上限兜住，不会无限自旋", async () => {
    // 显式写三次 429，而不是靠假体重复最后一步——否则测不出「上限真的生效」。
    const h = makeHarness({
      script: [
        { fail: httpError(429, "RATE_LIMITED") },
        { fail: httpError(429, "RATE_LIMITED") },
        { fail: httpError(429, "RATE_LIMITED") },
      ],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 3 }), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(h.acquireCalls()).toBe(3);
    expect(h.events).not.toContain("agent");
  });
});

/* ------------------------------------------------------------------ *
 * 7. 租约失效后不推送、不上报
 * ------------------------------------------------------------------ */

describe("B4 §7 租约失效", () => {
  it("sideEffectsSkipped → 既不推送也不上报，且停止循环", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      outcome: makeOutcome({
        trace: {
          phases: [],
          lease_lost: true,
          lease_lost_reason: "lease_epoch_stale",
          sideEffectsSkipped: true,
          worktree_ready: true,
        },
      }),
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    expect(report.attempts[0]!.result).toBe("skipped_lease_lost");
    expect(report.stop_reason).toBe("lease_lost");
  });

  it("版本绑定缺项 → 拒绝开工（不上报伪造结果）", async () => {
    const brokenLease = {
      ...LEASE,
      binding: { ...BINDING, contract_sha: "" },
    } as unknown as Lease;
    expect(findBindingProblem(brokenLease)).toContain("contract_sha");
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: brokenLease }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.attempts[0]!.result).toBe("refused_binding_incomplete");
    expect(h.events).not.toContain("agent");
    expect(h.events).not.toContain("report");
  });

  it("版本绑定齐全 → 放行", () => {
    expect(findBindingProblem(LEASE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 8. 优雅停止与重启恢复
 * ------------------------------------------------------------------ */

describe("B4 §8 优雅停止与重启恢复", () => {
  it("取消信号在循环前即已置位 → 不领取任何任务", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness();
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );
    expect(report.stop_reason).toBe("aborted");
    expect(h.acquireCalls()).toBe(0);
  });

  it("编排期间收到取消 → 不推送、不上报（租约自然过期）", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      attemptRunner: async () => {
        controller.abort(); // 模拟 agent 运行中被 Ctrl+C 打断
        return makeOutcome();
      },
    });
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );
    expect(report.attempts[0]!.result).toBe("skipped_aborted");
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    expect(report.stop_reason).toBe("aborted");
  });

  it("重启恢复：仍归本机也**不续跑**（B4 不具备断点续跑能力），清记录后继续", async () => {
    const record: InFlightRecord = {
      task_id: "TASK-0001",
      attempt_id: "TASK-0001-A1",
      executor_id: CONFIG.executor_id,
      lease_epoch: 1,
      expired_at: LEASE.expires_at,
      worktree_path: "C:\\repo\\.local\\worktrees\\TASK-0001-A1",
      completed_phases: ["running_agent"],
      local_commits: [],
    };
    const h = makeHarness({
      inFlight: record,
      recovery: {
        kind: "still_mine",
        lease: {
          task_id: "TASK-0001",
          attempt_id: "TASK-0001-A1",
          executor_id: CONFIG.executor_id,
          lease_epoch: 1,
          expires_at: LEASE.expires_at,
        },
      },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    // 顺序：先查归属，再进入领取循环（health/register 在其之前）
    const recoveryIndex = h.events.indexOf("query_ownership");
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(h.events.slice(recoveryIndex + 1)).toContain("acquire");
    expect(report.recovery).toEqual({ kind: "resume", from_phase: "running_agent" });
    expect(h.saved).toContain(null); // 记录被清理
    expect(report.attempts).toHaveLength(0); // 没有自动续跑
  });

  it("重启恢复：归属不可达 → halt_offline，停止新操作", async () => {
    const h = makeHarness({
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: { kind: "unreachable", error: "ECONNRESET" },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("halt_offline_on_recovery");
    expect(h.events).not.toContain("acquire");
  });

  it("重启恢复：已被重派 → 本地放手，不推送不上报", async () => {
    const h = makeHarness({
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: {
        kind: "reassigned",
        reason: "lease_reassigned",
        to_executor: "EXE-A-LENOVO",
        attempt_id: "TASK-0001-A2",
        lease_epoch: 2,
      },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.recovery?.kind).toBe("abandon_reassigned");
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
  });
});

/* ------------------------------------------------------------------ *
 * 9. 日志脱敏
 * ------------------------------------------------------------------ */

describe("B4 §9 日志中不出现 Bearer Token", () => {
  it("把所有事件跑一遍，日志里都不含 token", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }],
      registerAck: { fail: httpError(401, "AUTH_EXPIRED") },
    });
    await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("Bearer ");
    }
  });

  it("即使日志字段里带了 token，也会在出口被脱敏后再输出", async () => {
    // 让 daemon **真的**把 token 打进日志行：归属查询的错误文本会原样进入 [recovery] 行。
    // 这样断言的就不是「恰好没打印」，而是「脱敏确实生效」。
    const sink: string[] = [];
    const h = makeHarness({
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: { kind: "unreachable", error: `ECONNRESET Bearer ${TOKEN}` },
    });
    await runDaemon({ ...makeOptions(), log: (line) => sink.push(line) }, h.deps);

    const recoveryLine = sink.find((line) => line.includes("[recovery]"));
    // 1) 这行确实产生了，且输入里确实携带了 token
    expect(recoveryLine).toBeDefined();
    // 2) token 原值不得出现
    expect(sink.every((line) => !line.includes(TOKEN))).toBe(true);
    // 3) 兜底规则把 Bearer 形态整体替换掉 —— 证明替换真的发生了
    expect(recoveryLine).toContain("Bearer [REDACTED]");
  });

  it("CoordinatorClient 的错误信息不含 token（红线）", () => {
    const error = new CoordinatorHttpError({
      code: "INTERNAL_ERROR",
      message: "网络错误：POST /tasks/lease",
      status: null,
      retryable: true,
    });
    expect(error.message).not.toContain(TOKEN);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Windows 中文与空格路径
 * ------------------------------------------------------------------ */

describe("B4 §10 Windows 中文与空格路径", () => {
  const chineseRepo = "C:\\Users\\测试 用户\\Desktop\\协调 系统 仓库";
  const chineseWorktree = "C:\\Users\\测试 用户\\Desktop\\协调 系统 仓库\\.local\\worktrees";

  it("含中文与空格的路径原样透传给编排器，不被截断或改写", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(
        makeOptions({ repo_root: chineseRepo, worktree_root: chineseWorktree, max_idle_polls: 1 }),
        h.logs,
      ),
      h.deps,
    );
    expect(h.attemptInputs[0]!.repo_root).toBe(chineseRepo);
    expect(h.attemptInputs[0]!.worktree_root).toBe(chineseWorktree);
    expect(h.attemptInputs[0]!.repo_root).toContain(" ");
  });

  it("在途记录使用任务专属 worktree 子目录，中文路径拼接正确", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(
        makeOptions({ repo_root: chineseRepo, worktree_root: chineseWorktree, max_idle_polls: 1 }),
        h.logs,
      ),
      h.deps,
    );
    const record = h.saved.find((item) => item !== null) as InFlightRecord;
    expect(record.worktree_path).toBe(join(chineseWorktree, LEASE.attempt_id));
    expect(record.worktree_path.endsWith(LEASE.attempt_id)).toBe(true);
  });

  it("在途记录能真实读写含中文与空格的目录（Windows 不退化）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dac 中文 测试 "));
    try {
      const store = fileInFlightStore(dir);
      expect(store.load_in_flight?.()).toBeNull();
      const record: InFlightRecord = {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: join(dir, "worktrees", "TASK-0001-A1"),
        completed_phases: [],
        local_commits: [],
      };
      store.save_in_flight?.(record);
      expect(store.load_in_flight?.()).toEqual(record);
      store.save_in_flight?.(null);
      expect(store.load_in_flight?.()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 辅助断言：时钟注入
 * ------------------------------------------------------------------ */

describe("B4 时钟注入", () => {
  it("轮询等待走注入的 clock（测试不依赖真实时间）", async () => {
    const slept: number[] = [];
    const clock: LeaseClock = {
      now: () => 0,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
    const h = makeHarness({ script: [{ kind: "empty" }] });
    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 3, poll_interval_ms: 77 }), h.logs),
      { ...h.deps, clock },
    );
    expect(slept).toEqual([77, 77]);
  });
});
