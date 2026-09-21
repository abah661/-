/**
 * 协议 schema 与错误分类测试。
 * 对应验收 V06（虚假完成）、V10（登录与配额失败分类）、V11（越界与敏感文件）。
 */
import { describe, expect, it } from "vitest";
import {
  ResultReportSchema,
  TaskGraphSchema,
  ExecutorRegistrationSchema,
  ERROR_POLICY,
  ERROR_CODES,
  blockedStatusFor,
  isRepairable,
  isRetryable,
  DEFAULT_LIMITS,
  DEFAULT_TIMING,
  validateTimingConfig,
  PROTOCOL_VERSION,
} from "@dac/protocol";

const baseResult = {
  protocol_version: PROTOCOL_VERSION,
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-DESKTOP",
  lease_epoch: 1,
  agent_kind: "opencode",
  base_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  head_sha: "b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80",
  rules_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  contract_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  acceptance_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
  reported_at: "2026-09-21T03:12:30.000Z",
} as const;

const greenEvidence = {
  evidence_id: "EV-0001",
  command: ["npm", "run", "test"],
  exit_code: 0,
  summary: { passed: 4, failed: 0, skipped: 0 },
  log_artifact: null,
  output_sha256: null,
};

describe("验收 V06：虚假完成不能绕过测试", () => {
  it("声称 ready_for_integration 但无证据 → 拒绝", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "ready_for_integration",
      evidence_id: null,
      evidence: null,
      error_code: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/必须附带测试证据/);
  });

  it("有证据但退出码非 0 → 拒绝", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "ready_for_integration",
      evidence_id: "EV-0001",
      evidence: { ...greenEvidence, exit_code: 1 },
      error_code: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/退出码为 0/);
  });

  it("有证据但存在失败用例 → 拒绝", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "ready_for_integration",
      evidence_id: "EV-0001",
      evidence: { ...greenEvidence, summary: { passed: 3, failed: 1, skipped: 0 } },
      error_code: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/失败用例数为 0/);
  });

  it("无提交（head == base）却声称完成 → 拒绝", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      head_sha: baseResult.base_sha,
      status: "ready_for_integration",
      evidence_id: "EV-0001",
      evidence: greenEvidence,
      error_code: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/head_sha 不能等于 base_sha/);
  });

  it("证据齐全的完成报告 → 接受", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "ready_for_integration",
      evidence_id: "EV-0001",
      evidence: greenEvidence,
      error_code: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("验收 V10：登录与配额必须分类，不得算作代码失败", () => {
  it("失败状态缺少 error_code → 拒绝", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "repair_pending",
      evidence_id: null,
      evidence: null,
      error_code: null,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/必须提供 error_code/);
  });

  it("登录过期被标成 repair_pending 时，error_code 必须是 AUTH_EXPIRED 而非代码类错误", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      status: "blocked_auth",
      evidence_id: null,
      evidence: null,
      error_code: "AUTH_EXPIRED",
    });
    expect(parsed.success).toBe(true);
    // 且策略上不计入返修
    expect(isRepairable("AUTH_EXPIRED")).toBe(false);
    expect(blockedStatusFor("AUTH_EXPIRED")).toBe("blocked_auth");
  });

  it("AUTH_EXPIRED 与 QUOTA_EXHAUSTED 都归为 blocked 且映射到各自的阻塞状态", () => {
    expect(ERROR_POLICY.AUTH_EXPIRED.disposition).toBe("blocked");
    expect(ERROR_POLICY.QUOTA_EXHAUSTED.disposition).toBe("blocked");
    expect(blockedStatusFor("QUOTA_EXHAUSTED")).toBe("blocked_quota");
    expect(isRetryable("AUTH_EXPIRED")).toBe(false);
    expect(isRetryable("QUOTA_EXHAUSTED")).toBe(false);
  });

  it("代码类失败才是 repairable", () => {
    for (const code of ["AGENT_NONZERO_EXIT", "TESTS_FAILED", "CONTRACT_MISMATCH"] as const) {
      expect(isRepairable(code), code).toBe(true);
    }
  });

  it("授权类失败映射到 blocked_approval", () => {
    expect(blockedStatusFor("UNAUTHORIZED_OPERATION")).toBe("blocked_approval");
    expect(blockedStatusFor("SENSITIVE_FILE_DETECTED")).toBe("blocked_approval");
    expect(isRepairable("UNAUTHORIZED_OPERATION")).toBe(false);
  });

  it("每个错误码都有明确策略", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_POLICY[code], code).toBeDefined();
      expect(["repairable", "blocked", "retryable", "fatal"]).toContain(
        ERROR_POLICY[code].disposition,
      );
    }
  });

  it("所有非 fatal 错误都声明了是否可重试", () => {
    for (const code of ERROR_CODES) {
      expect(typeof ERROR_POLICY[code].retryable, code).toBe("boolean");
    }
  });
});

describe("版本绑定字段约束", () => {
  it("版本绑定必须是合法 SHA", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      rules_sha: "not-a-sha",
      status: "repair_pending",
      error_code: "TESTS_FAILED",
    });
    expect(parsed.success).toBe(false);
  });

  it("协议版本必须是 1", () => {
    const parsed = ResultReportSchema.safeParse({
      ...baseResult,
      protocol_version: "2",
      status: "repair_pending",
      error_code: "TESTS_FAILED",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("任务图 schema", () => {
  it("拒绝重复的任务 ID", () => {
    const shared = {
      kind: "implement",
      title: "t",
      acceptance_criteria: ["a"],
      depends_on: [],
      write_scope: { allow: ["src/**"], deny: [] },
      contracts: [],
      requires: ["code"],
      expected_interfaces: [],
      status: "draft",
      assigned_executor: null,
      attempts_used: 0,
    };
    const parsed = TaskGraphSchema.safeParse({
      protocol_version: "1",
      project_id: "p",
      requirement_ref: "REQ-1",
      binding: {
        base_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        rules_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        contract_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        acceptance_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
      },
      created_at: "2026-09-21T02:40:00.000Z",
      tasks: [
        { task_id: "TASK-0001", ...shared },
        { task_id: "TASK-0001", ...shared },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/任务 ID 重复/);
  });

  it("拒绝依赖不存在的任务", () => {
    const parsed = TaskGraphSchema.safeParse({
      protocol_version: "1",
      project_id: "p",
      requirement_ref: "REQ-1",
      binding: {
        base_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        rules_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        contract_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        acceptance_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
      },
      created_at: "2026-09-21T02:40:00.000Z",
      tasks: [
        {
          task_id: "TASK-0001",
          kind: "implement",
          title: "t",
          acceptance_criteria: ["a"],
          depends_on: ["TASK-0002"],
          write_scope: { allow: ["src/**"], deny: [] },
          contracts: [],
          requires: ["code"],
          expected_interfaces: [],
          status: "draft",
          assigned_executor: null,
          attempts_used: 0,
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/不存在的任务/);
  });

  it("任务必须声明至少一项能力", () => {
    const parsed = TaskGraphSchema.safeParse({
      protocol_version: "1",
      project_id: "p",
      requirement_ref: "REQ-1",
      binding: {
        base_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        rules_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        contract_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        acceptance_sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f001234567",
      },
      created_at: "2026-09-21T02:40:00.000Z",
      tasks: [
        {
          task_id: "TASK-0001",
          kind: "implement",
          title: "t",
          acceptance_criteria: ["a"],
          depends_on: [],
          write_scope: { allow: ["src/**"], deny: [] },
          contracts: [],
          requires: [],
          expected_interfaces: [],
          status: "draft",
          assigned_executor: null,
          attempts_used: 0,
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("执行器注册", () => {
  it("接受合法注册并补齐 tool_versions 默认值", () => {
    const parsed = ExecutorRegistrationSchema.safeParse({
      protocol_version: "1",
      executor_id: "EXE-B-DESKTOP",
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: ["code", "test"],
      project_root: "C:/work/coordinator",
      registered_at: "2026-09-21T02:40:00.000Z",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.tool_versions).toEqual({});
  });

  it("拒绝格式不合法的执行器 ID", () => {
    const parsed = ExecutorRegistrationSchema.safeParse({
      protocol_version: "1",
      executor_id: "executor-b",
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: ["code"],
      project_root: "C:/work/coordinator",
      registered_at: "2026-09-21T02:40:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });

  it("拒绝空的 capability 列表", () => {
    const parsed = ExecutorRegistrationSchema.safeParse({
      protocol_version: "1",
      executor_id: "EXE-B-DESKTOP",
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: [],
      project_root: "C:/work/coordinator",
      registered_at: "2026-09-21T02:40:00.000Z",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("默认参数自洽性（第 7 节可调建议值）", () => {
  it("默认时序参数通过一致性检查", () => {
    expect(validateTimingConfig(DEFAULT_TIMING)).toEqual([]);
  });

  it("心跳过大时被检出", () => {
    const problems = validateTimingConfig({ ...DEFAULT_TIMING, heartbeatIntervalMs: 120_000 });
    expect(problems.join("\n")).toMatch(/心跳间隔/);
  });

  it("单任务超时不大于租约时被检出", () => {
    const problems = validateTimingConfig({ ...DEFAULT_TIMING, taskTimeoutMs: 60_000 });
    expect(problems.join("\n")).toMatch(/大于租约时长/);
  });

  it("返修上限为两次，每台并发一个任务", () => {
    expect(DEFAULT_LIMITS.maxRepairAttempts).toBe(2);
    expect(DEFAULT_LIMITS.maxConcurrentTasksPerExecutor).toBe(1);
    expect(DEFAULT_LIMITS.maxConcurrentBatchesPerProject).toBe(1);
  });
});
