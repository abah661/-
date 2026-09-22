/**
 * 租约守卫与重启恢复测试（第 7 节，验收 V08）。
 *
 * 覆盖的核心安全语义：
 * - 续租成功时 epoch 递增并被记住
 * - 服务端给出更高 epoch / 明确拒绝 → 立即判定丢失并回调（用于停子进程）
 * - **网络抖动不得误判丢失**（否则任务会被无辜中断）
 * - 恢复必须先查云端归属；已被重派则完全放手
 */

import { describe, expect, it } from "vitest";
import { LeaseGuard, isLeaseExpired, remainingLeaseMs } from "../../apps/executor/src/core/lease.js";
import type { LeaseClock, LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import { decideRecovery, checkLocalState } from "../../apps/executor/src/core/recovery.js";
import type {
  InFlightRecord,
  OwnershipQuery,
  RecoveryTransport,
  TaskOwnership,
} from "../../apps/executor/src/core/recovery.js";
import { Heartbeat, validateHeartbeat } from "../../apps/executor/src/core/heartbeat.js";
import type { HeartbeatRequest } from "../../apps/executor/src/core/heartbeat.js";
import type { Lease } from "@dac/protocol";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    executor_id: "EXE-B-DESKTOP",
    lease_epoch: 1,
    expires_at: "2026-09-21T12:00:00.000Z",
    binding: {
      base_sha: "a577d66",
      rules_sha: "a577d66",
      contract_sha: "a577d66",
      acceptance_sha: "a577d66",
    },
    agent_kind: "opencode",
    ...overrides,
  };
}

/** 可控时钟：测试中显式推进，不真实等待。 */
class ManualClock implements LeaseClock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class ScriptedTransport implements LeaseTransport {
  calls = 0;
  constructor(private readonly script: Array<RenewOutcome | Error>) {}
  async renew(): Promise<RenewOutcome> {
    const next = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls += 1;
    if (next instanceof Error) throw next;
    return next;
  }
}

/* ------------------------------------------------------------------ *
 * 租约时间判定
 * ------------------------------------------------------------------ */

describe("remainingLeaseMs / isLeaseExpired", () => {
  it("正确计算剩余时间", () => {
    const lease = makeLease({ expires_at: "2026-09-21T12:00:00.000Z" });
    const now = Date.parse("2026-09-21T11:57:00.000Z");
    expect(remainingLeaseMs(lease, now)).toBe(180_000);
  });

  it("到期时间在过去时判为已过期", () => {
    const lease = makeLease({ expires_at: "2026-09-21T12:00:00.000Z" });
    expect(isLeaseExpired(lease, Date.parse("2026-09-21T12:00:01.000Z"))).toBe(true);
    expect(isLeaseExpired(lease, Date.parse("2026-09-21T11:59:59.000Z"))).toBe(false);
  });

  it("非法时间字符串抛出明确错误", () => {
    const lease = makeLease({ expires_at: "not-a-date" });
    expect(() => remainingLeaseMs(lease)).toThrow(/ISO 8601/);
  });
});

/* ------------------------------------------------------------------ *
 * 租约守卫
 * ------------------------------------------------------------------ */

describe("LeaseGuard", () => {
  it("续租成功后 epoch 递增并被记住", async () => {
    const transport = new ScriptedTransport([
      { kind: "renewed", expires_at: "2026-09-21T12:01:00.000Z", lease_epoch: 2 },
    ]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    const held = await guard.renewOnce();
    expect(held).toBe(true);
    expect(guard.lease_epoch).toBe(2);
    expect(guard.expires_at).toBe("2026-09-21T12:01:00.000Z");
    expect(guard.lost).toBe(false);
  });

  it("服务端报 epoch 过期 → 判定丢失并触发回调", async () => {
    const seen: string[] = [];
    const transport = new ScriptedTransport([{ kind: "lost", reason: "lease_epoch_stale" }]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      onLeaseLost: (reason) => seen.push(reason),
    });
    const held = await guard.renewOnce();
    expect(held).toBe(false);
    expect(guard.lost).toBe(true);
    expect(guard.lost_reason).toBe("lease_epoch_stale");
    expect(seen).toEqual(["lease_epoch_stale"]);
  });

  it("单次网络异常**不**判定丢失（避免抖动误停任务）", async () => {
    const errors: unknown[] = [];
    const transport = new ScriptedTransport([new Error("ECONNRESET")]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      max_renew_failures: 3,
      onRenewError: (e) => errors.push(e),
    });
    const held = await guard.renewOnce();
    expect(held).toBe(true);
    expect(guard.lost).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("连续失败达到阈值才判定丢失", async () => {
    const transport = new ScriptedTransport([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      max_renew_failures: 2,
    });
    expect(await guard.renewOnce()).toBe(true);
    expect(await guard.renewOnce()).toBe(false);
    expect(guard.lost).toBe(true);
  });

  it("stop() 后续租直接返回 false 且不发请求", async () => {
    const transport = new ScriptedTransport([
      { kind: "renewed", expires_at: "2026-09-21T12:01:00.000Z", lease_epoch: 2 },
    ]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    guard.stop();
    expect(await guard.renewOnce()).toBe(false);
    expect(transport.calls).toBe(0);
  });

  it("后台循环按间隔续租，丢失后自行退出", async () => {
    const clock = new ManualClock();
    const transport = new ScriptedTransport([
      { kind: "renewed", expires_at: "2026-09-21T12:01:00.000Z", lease_epoch: 2 },
      { kind: "lost", reason: "not_lease_holder" },
      { kind: "renewed", expires_at: "2026-09-21T12:02:00.000Z", lease_epoch: 3 },
    ]);
    const guard = new LeaseGuard(makeLease(), transport, {
      heartbeat_interval_ms: 500,
      clock,
    });
    const loop = guard.start();
    // 手动推进时钟以驱动 sleep 返回
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(500);
    await new Promise((r) => setTimeout(r, 0));
    guard.stop();
    await loop;
    // 第二次续租即丢失，第三次不应发生
    expect(transport.calls).toBeLessThanOrEqual(2);
    expect(guard.lost).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 重启恢复（第 8 节；休眠恢复）
 * ------------------------------------------------------------------ */

function makeRecord(overrides: Partial<InFlightRecord> = {}): InFlightRecord {
  return {
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    executor_id: "EXE-B-DESKTOP",
    lease_epoch: 1,
    expired_at: "2026-09-21T12:00:00.000Z",
    worktree_path: "C:/nonexistent/worktree",
    completed_phases: ["preparing_worktree", "running_agent"],
    local_commits: [],
    ...overrides,
  };
}

/**
 * 记录最后一次归属查询参数，用于断言「四项必须齐全」。
 * A 端答复 §4：只传 task_id 会拿到不准确的结论，故必须验证客户端确实带全。
 */
class FakeRecoveryTransport implements RecoveryTransport {
  lastQuery: OwnershipQuery | null = null;
  constructor(private readonly answer: Awaited<ReturnType<RecoveryTransport["queryOwnership"]>>) {}
  async queryOwnership(query: OwnershipQuery): Promise<TaskOwnership> {
    this.lastQuery = query;
    return this.answer;
  }
}

describe("decideRecovery", () => {
  it("租约仍归我且未过期 → resume，并给出已完成阶段", async () => {
    const lease = makeLease({ expires_at: "2026-09-21T12:05:00.000Z" });
    const decision = await decideRecovery(
      { record: makeRecord(), now: Date.parse("2026-09-21T12:00:00.000Z") },
      new FakeRecoveryTransport({ kind: "still_mine", lease }),
    );
    expect(decision.kind).toBe("resume");
    if (decision.kind === "resume") expect(decision.from_phase).toBe("running_agent");
  });

  it("租约仍归我但已过期 → abandon_expired", async () => {
    const lease = makeLease({ expires_at: "2026-09-21T11:00:00.000Z" });
    const decision = await decideRecovery(
      { record: makeRecord(), now: Date.parse("2026-09-21T12:00:00.000Z") },
      new FakeRecoveryTransport({ kind: "still_mine", lease }),
    );
    expect(decision.kind).toBe("abandon_expired");
  });

  it("epoch 已被提高 → 视为重派，必须放手", async () => {
    const lease = makeLease({ lease_epoch: 5, executor_id: "EXE-A-LENOVO" });
    const decision = await decideRecovery(
      { record: makeRecord({ lease_epoch: 1 }) },
      new FakeRecoveryTransport({ kind: "still_mine", lease }),
    );
    expect(decision.kind).toBe("abandon_reassigned");
  });

  it("明确被重派给他人 → abandon_reassigned（不得推送）", async () => {
    const decision = await decideRecovery(
      { record: makeRecord() },
      new FakeRecoveryTransport({
        kind: "reassigned",
        reason: "reassigned_to_other_executor",
        to_executor: "EXE-A-LENOVO",
        attempt_id: "TASK-0001-A2",
        lease_epoch: 2,
      }),
    );
    expect(decision.kind).toBe("abandon_reassigned");
    if (decision.kind === "abandon_reassigned") {
      expect(decision.to_executor).toBe("EXE-A-LENOVO");
    }
  });

  it("被重派但云端当前无租约（三项为 null）→ 同样必须放手", async () => {
    // A 端答复 §4：无当前租约时 to_executor/attempt_id/lease_epoch 均为 null。
    // 这是边界：不能因为「拿不到新持有者」就当作仍归自己。
    const decision = await decideRecovery(
      { record: makeRecord() },
      new FakeRecoveryTransport({
        kind: "reassigned",
        reason: "lease_released",
        to_executor: null,
        attempt_id: null,
        lease_epoch: null,
      }),
    );
    expect(decision.kind).toBe("abandon_reassigned");
    if (decision.kind === "abandon_reassigned") {
      expect(decision.to_executor).toBe("(unknown)");
    }
  });

  it("归属查询必须带全四项（task/attempt/executor/epoch）", async () => {
    const transport = new FakeRecoveryTransport({ kind: "unknown_task" });
    await decideRecovery({ record: makeRecord() }, transport);
    expect(transport.lastQuery).toEqual({
      task_id: "TASK-0001",
      attempt_id: "TASK-0001-A1",
      executor_id: "EXE-B-DESKTOP",
      lease_epoch: 1,
    });
  });

  it("云端不可达 → halt_offline（断网停止新操作，不猜）", async () => {
    const decision = await decideRecovery(
      { record: makeRecord() },
      new FakeRecoveryTransport({ kind: "unreachable", error: "ETIMEDOUT" }),
    );
    expect(decision.kind).toBe("halt_offline");
    if (decision.kind === "halt_offline") expect(decision.error).toBe("ETIMEDOUT");
  });

  it("云端不认识该任务 → abandon_unknown", async () => {
    const decision = await decideRecovery(
      { record: makeRecord() },
      new FakeRecoveryTransport({ kind: "unknown_task" }),
    );
    expect(decision.kind).toBe("abandon_unknown");
  });
});

describe("checkLocalState", () => {
  it("worktree 不存在时报告问题而不是抛错", () => {
    const result = checkLocalState(makeRecord({ worktree_path: "C:/definitely/not/here" }));
    expect(result.is_git_repo).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 心跳（CP-0001 §1；A 端答复 v1）
 * ------------------------------------------------------------------ */

class RecordingHeartbeatTransport {
  sent: HeartbeatRequest[] = [];
  failNext: Error | null = null;
  async send(request: HeartbeatRequest): Promise<void> {
    this.sent.push(request);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }
}

describe("Heartbeat 契约字段", () => {
  it("初始为 idle，且租约三项为 null", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      makeIdempotencyKey: () => "k1",
    });
    const req = hb.buildRequest();
    expect(req.state).toBe("idle");
    expect(req.task_id).toBeNull();
    expect(req.attempt_id).toBeNull();
    expect(req.lease_epoch).toBeNull();
    expect(req.protocol_version).toBe("1");
    expect(req.executor_id).toBe("EXE-B-DESKTOP");
    expect(validateHeartbeat(req)).toBeNull();
  });

  it("markRunning 后带完整三元组，state=running", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      makeIdempotencyKey: () => "k1",
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 3 });
    const req = hb.buildRequest();
    expect(req.state).toBe("running");
    expect(req.task_id).toBe("TASK-0001");
    expect(req.attempt_id).toBe("TASK-0001-A1");
    expect(req.lease_epoch).toBe(3);
    expect(validateHeartbeat(req)).toBeNull();
  });

  it("markStopping 保留租约（正在收尾，仍需表明归属）", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 3 });
    hb.markStopping();
    const req = hb.buildRequest();
    expect(req.state).toBe("stopping");
    expect(req.lease_epoch).toBe(3);
    expect(validateHeartbeat(req)).toBeNull();
  });

  it("markIdle 清空租约与本地 phase", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 3 });
    hb.setPhase("running_agent", "agent 已运行 1s");
    hb.markIdle();
    const req = hb.buildRequest();
    expect(req.state).toBe("idle");
    expect(req.lease_epoch).toBeNull();
    expect(req.detail).toBeUndefined();
    expect(validateHeartbeat(req)).toBeNull();
  });

  it("setLeaseEpoch 同步续租后的新 epoch（否则上报过期值会被服务端拒绝）", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 3 });
    hb.setLeaseEpoch(7);
    expect(hb.buildRequest().lease_epoch).toBe(7);
  });

  it("phase 只是本地诊断信息，不改变 state", () => {
    const hb = new Heartbeat("EXE-B-DESKTOP", new RecordingHeartbeatTransport(), {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 1 });
    hb.setPhase("running_tests", "vitest 178/178");
    const req = hb.buildRequest();
    expect(req.state).toBe("running");
    expect(req.detail).toBe("vitest 178/178");
  });

  it("心跳发送失败**不抛错也不改状态**（不得影响任务）", async () => {
    const transport = new RecordingHeartbeatTransport();
    const errors: unknown[] = [];
    const hb = new Heartbeat("EXE-B-DESKTOP", transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
      onError: (e) => errors.push(e),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 1 });
    transport.failNext = new Error("ECONNRESET");
    await expect(hb.beat()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(hb.buildRequest().state).toBe("running");
  });

  it("每次幂等键不同（否则服务端会去重导致协调器误判失联）", async () => {
    const transport = new RecordingHeartbeatTransport();
    const hb = new Heartbeat("EXE-B-DESKTOP", transport, {
      heartbeat_interval_ms: 1000,
      clock: new ManualClock(),
    });
    hb.markRunning({ task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 1 });
    await hb.beat();
    await hb.beat();
    await hb.beat();
    const keys = transport.sent.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("validateHeartbeat（服务端也会做同样校验，客户端提前自检）", () => {
  const base: HeartbeatRequest = {
    protocol_version: "1",
    executor_id: "EXE-B-DESKTOP",
    state: "running",
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    lease_epoch: 1,
    sent_at: "2026-09-21T12:00:00.000Z",
    idempotency_key: "k1",
  };

  it("running 缺三元组 → 报错", () => {
    expect(validateHeartbeat({ ...base, attempt_id: null })).toMatch(/attempt_id/);
  });

  it("stopping 缺三元组 → 报错", () => {
    expect(validateHeartbeat({ ...base, state: "stopping", lease_epoch: null })).toMatch(
      /lease_epoch/,
    );
  });

  it("idle 带了三元组 → 报错（服务端要求全 null）", () => {
    expect(validateHeartbeat({ ...base, state: "idle" })).toMatch(/idle/);
  });

  it("epoch 非正整数 → 报错", () => {
    expect(validateHeartbeat({ ...base, lease_epoch: 0 })).toMatch(/>= 1/);
    expect(validateHeartbeat({ ...base, lease_epoch: 1.5 })).toMatch(/>= 1/);
  });

  it("合法 running 请求 → null", () => {
    expect(validateHeartbeat(base)).toBeNull();
  });
});
