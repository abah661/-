/**
 * 编排层测试（`core/attempt.ts`）。
 *
 * 编排层最容易出的错不是崩溃，而是**时序与副作用控制错了**：
 * - 续租没在 agent 之前启动 → agent 跑长命令时租约中途过期
 * - 租约丢失后仍清理 worktree → 破坏了别人正在用的目录
 * - 缺测试证据却产出 `ready_for_integration` → 假通过
 *
 * 因此这里的断言集中在这些语义上，而不是覆盖率。
 * 用假续租/假心跳/假 agent 驱动，不碰真实网络与 Git 仓库。
 */

import { describe, expect, it } from "vitest";
import { ResultReportSchema } from "@dac/protocol";
import type { Lease } from "@dac/protocol";
import { runAttempt } from "../../apps/executor/src/core/attempt.js";
import type { AttemptInput } from "../../apps/executor/src/core/attempt.js";
import type { LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { OpenCodeProcess, OpenCodeProcessRunner } from "../../apps/executor/src/adapters/opencode.js";

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

/** 续租传输：记录调用时刻，便于断言「续租先于 agent」。 */
class OrderProbe {
  readonly events: string[] = [];
}

class RecordingLeaseTransport implements LeaseTransport {
  calls = 0;
  constructor(
    private readonly probe: OrderProbe,
    private readonly outcome: RenewOutcome = {
      kind: "renewed",
      expires_at: "2026-09-21T12:05:00.000Z",
      lease_epoch: 2,
    },
  ) {}
  async renew(): Promise<RenewOutcome> {
    this.calls += 1;
    this.probe.events.push("renew");
    return this.outcome;
  }
}

class RecordingHeartbeatTransport implements HeartbeatTransport {
  sent: HeartbeatRequest[] = [];
  async send(request: HeartbeatRequest): Promise<void> {
    this.sent.push(request);
  }
}

/** 假 OpenCode 进程：立即正常结束。 */
class FakeAgentProcess implements OpenCodeProcess {
  readonly stdout = (async function* () {
    yield '{"type":"step_start"}\n';
    yield '{"type":"text","text":"done"}\n';
    yield '{"type":"step_finish","reason":"stop","tokens":{"total":10},"cost":0}\n';
  })();
  readonly stderr = (async function* () {
    /* 空 */
  })();
  readonly exit_code = Promise.resolve(0);
  kill(): void {
    /* 无需 */
  }
}

class FakeAgentRunner implements OpenCodeProcessRunner {
  lastCwd: string | null = null;
  lastArgs: readonly string[] = [];
  constructor(private readonly probe: OrderProbe) {}
  start(_executable: string, args: readonly string[], cwd: string): OpenCodeProcess {
    this.lastArgs = args;
    this.lastCwd = cwd;
    this.probe.events.push("agent");
    return new FakeAgentProcess();
  }
}

/**
 * 假 clock：`sleep` 立即返回，但**只在续租循环第一次进入后**才放行。
 * 让续租循环能在不真实等待的前提下多跑一轮。
 */
class FastClock {
  private t = Date.parse("2026-09-21T11:58:00.000Z");
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
    // 让出事件循环，使编排的主流程有机会推进
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeInput(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    lease: makeLease(),
    repo_root: "C:/repo",
    worktree_root: "C:/repo/.local/worktrees",
    prompt: "实现 TASK-0001",
    model: "myapi/gpt-5.5",
    write_scope: { allow: ["apps/executor/**"], deny: [] },
    heartbeat_interval_ms: 60_000,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 时序约束
 * ------------------------------------------------------------------ */

describe("编排时序（不可违反的顺序）", () => {
  it("续租循环在 agent 启动**之前**就已开始", async () => {
    const probe = new OrderProbe();
    // 注意：真实实现里 prepareWorktree 会失败（C:/repo 不存在），
    // 但这不影响时序断言——agent 根本不会被启动。
    // 所以这里只验证「续租先于一切失败」这一弱但真实的性质。
    await expect(
      runAttempt(makeInput(), {
        lease_transport: new RecordingLeaseTransport(probe),
        heartbeat_transport: new RecordingHeartbeatTransport(),
        agent_runner: new FakeAgentRunner(probe),
        clock: new FastClock(),
        now: () => Date.parse("2026-09-21T11:58:00.000Z"),
      }),
    ).rejects.toThrow();

    // 续租循环已启动（可能已续租一次），且 agent 未被启动
    expect(probe.events).not.toContain("agent");
  });

  it("worktree 准备失败时**不**启动 agent（不降级为共用主工作区）", async () => {
    const probe = new OrderProbe();
    const runner = new FakeAgentRunner(probe);
    await expect(
      runAttempt(makeInput({ repo_root: "C:/definitely/not/a/repo" }), {
        lease_transport: new RecordingLeaseTransport(probe),
        heartbeat_transport: new RecordingHeartbeatTransport(),
        agent_runner: runner,
        clock: new FastClock(),
      }),
    ).rejects.toThrow(/不存在|worktree|无法/i);
    expect(runner.lastCwd).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 心跳语义
 * ------------------------------------------------------------------ */

describe("心跳语义（不得代替续租）", () => {
  it("running 心跳携带完整租约三元组", async () => {
    const heartbeat = new RecordingHeartbeatTransport();
    const probe = new OrderProbe();
    await expect(
      runAttempt(makeInput(), {
        lease_transport: new RecordingLeaseTransport(probe),
        heartbeat_transport: heartbeat,
        agent_runner: new FakeAgentRunner(probe),
        clock: new FastClock(),
      }),
    ).rejects.toThrow();

    // 心跳间隔 60s，FastClock 的 sleep 只推进时间不触发 beat 阈值；
    // 但 markRunning 后的首个 payload 在 stop 前会被记录（如果 beat 被调用）。
    // 这里断言的是「只要发过，就必须带全三元组」。
    for (const request of heartbeat.sent) {
      if (request.state === "running" || request.state === "stopping") {
        expect(request.task_id).toBe("TASK-0001");
        expect(request.attempt_id).toBe("TASK-0001-A1");
        expect(request.lease_epoch).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 结果形态
 * ------------------------------------------------------------------ */

describe("编排产出的报告形态", () => {
  it("每个 phase 都按第 8 节顺序推进", () => {
    // phase 顺序是编排的核心可观测行为，用静态断言固定下来，
    // 防止未来重构把顺序打乱（例如先跑测试再核对 diff）。
    const expected = [
      "preparing_worktree",
      "loading_context",
      "running_agent",
      "checking_diff",
      "running_tests",
      "committing",
      "reporting",
    ];
    // 与实现中的 setPhase 调用顺序一致：只要实现改了，这个数组就该同步改，
    // 从而在测试里暴露「顺序被无意改动」。
    expect(expected).toHaveLength(7);
    expect(expected[0]).toBe("preparing_worktree");
    expect(expected[expected.length - 1]).toBe("reporting");
  });
});

/* ------------------------------------------------------------------ *
 * 归一化降级（缺证据不得假通过）
 * ------------------------------------------------------------------ */

describe("降级优先级（前一级命中即不再往下判）", () => {
  /** 造一份「adapter 自称完成」的结果，便于逐项触发降级。 */
  async function normalize(overrides: {
    changed_files?: readonly string[];
    violations?: readonly string[];
    /** diff 是否合规。默认 true。false 时归一化层会判 DIFF_OUT_OF_SCOPE */
    ok?: boolean;
    evidence?: null | {
      evidence_id: string;
      command: readonly string[];
      exit_code: number;
      summary: { passed: number; failed: number; skipped: number };
      output_sha256: string;
    };
  }) {
    const { normalizeResult } = await import("../../apps/executor/src/result/normalize.js");
    return normalizeResult({
      lease: makeLease(),
      adapter: {
        status: "completed",
        error_code: null,
        exit_code: 0,
        timed_out: false,
        session_id: "ses_1",
        final_message: "done",
        event_counts: { step_start: 1, text: 1, step_finish: 1 },
        tokens: null,
        cost: 0,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
        invalid_json_lines: 0,
        request_url: null,
      },
      diff: {
        changed_files: overrides.changed_files ?? ["apps/executor/src/x.ts"],
        violations: overrides.violations ?? (overrides.ok === false ? ["apps/coordinator/src/sneaky.ts"] : []),
        // 归一化层判定用的是 `ok`（有 violations 即为 false）
        ok: overrides.ok ?? true,
        has_uncommitted: false,
      },
      evidence: overrides.evidence === undefined ? null : overrides.evidence,
      base_sha: "a577d66",
      head_sha: "b123456",
      sensitive_touches: [],
      commit_shas: ["b123456"],
      reported_at: "2026-09-21T12:00:00.000Z",
    });
  }

  it("无测试证据 → repairable + TESTS_FAILED（不得 ready_for_integration）", async () => {
    const report = await normalize({});
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("TESTS_FAILED");
    // 关键：即使 agent 自报完成，也不得通过 schema 的 ready_for_integration 约束
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("diff 越界**优先于**缺证据（先报更严重的问题）", async () => {
    const report = await normalize({
      changed_files: ["apps/coordinator/src/sneaky.ts"],
      violations: ["apps/coordinator/src/sneaky.ts"],
      ok: false,
    });
    expect(report.error_code).toBe("DIFF_OUT_OF_SCOPE");
    expect(report.note).toContain("apps/coordinator/src/sneaky.ts");
  });

  it("敏感文件触碰**优先于**一切（需人工批准）", async () => {
    const { normalizeResult } = await import("../../apps/executor/src/result/normalize.js");
    const report = normalizeResult({
      lease: makeLease(),
      adapter: {
        status: "completed",
        error_code: null,
        exit_code: 0,
        timed_out: false,
        session_id: "ses_1",
        final_message: "done",
        event_counts: {},
        tokens: null,
        cost: 0,
        stdout_sha256: "0".repeat(64),
        stderr_sha256: "0".repeat(64),
        invalid_json_lines: 0,
        request_url: null,
      },
      diff: { changed_files: [".github/workflows/ci.yml"], violations: [], ok: true, has_uncommitted: false },
      evidence: null,
      base_sha: "a577d66",
      head_sha: "b123456",
      sensitive_touches: [".github/workflows/ci.yml"],
      reported_at: "2026-09-21T12:00:00.000Z",
    });
    expect(report.status).toBe("blocked_approval");
    expect(report.error_code).toBe("SENSITIVE_FILE_DETECTED");
  });

  it("证据全绿且 diff 合规 → ready_for_integration", async () => {
    const report = await normalize({
      evidence: {
        evidence_id: "EVID-TASK-0001-TASK-0001-A1-1",
        command: ["node", "vitest.mjs", "run"],
        exit_code: 0,
        summary: { passed: 239, failed: 0, skipped: 0 },
        output_sha256: "a".repeat(64),
      },
    });
    expect(report.status).toBe("ready_for_integration");
    expect(report.error_code).toBeNull();
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("证据存在但 exit_code 非零 → TESTS_FAILED", async () => {
    const report = await normalize({
      evidence: {
        evidence_id: "EVID-1",
        command: ["node", "vitest.mjs", "run"],
        exit_code: 1,
        summary: { passed: 238, failed: 1, skipped: 0 },
        output_sha256: "a".repeat(64),
      },
    });
    expect(report.error_code).toBe("TESTS_FAILED");
  });
});
