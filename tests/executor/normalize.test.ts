/**
 * 结果归一化测试（第 8 节步骤 8，验收 V06 / V10）。
 *
 * 本文件是「agent 说完成不等于成功」这条规则的可执行证明。
 * 重点验证：
 * - adapter `completed` 在证据缺失/失败/越界时被正确降级
 * - 登录与配额阻塞**不计入返修次数**（V10）
 * - 限流不计返修，但仍是 repair_pending
 * - 生成的报告能通过协议 schema（含 superRefine）
 */

import { describe, expect, it } from "vitest";
import { ResultReportSchema } from "@dac/protocol";
import type { ErrorCode, Lease, TestEvidence } from "@dac/protocol";
import {
  countsAsRepair,
  isReadyForIntegration,
  mapAdapterStatus,
  normalizeResult,
  requiresUserIntervention,
} from "../../apps/executor/src/result/normalize.js";
import type { NormalizeInput } from "../../apps/executor/src/result/normalize.js";
import type { OpenCodeAdapterResult } from "../../apps/executor/src/adapters/opencode.js";
import type { DiffCheckResult } from "../../apps/executor/src/core/diff-check.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const LEASE: Lease = {
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-DESKTOP",
  lease_epoch: 3,
  expires_at: "2026-09-21T12:00:00.000Z",
  binding: {
    base_sha: "a577d66",
    rules_sha: "a577d66",
    contract_sha: "a577d66",
    acceptance_sha: "a577d66",
  },
  agent_kind: "opencode",
};

const BASE = "a577d66";
const HEAD = "327d311";

function adapter(overrides: Partial<OpenCodeAdapterResult> = {}): OpenCodeAdapterResult {
  return {
    status: "completed",
    error_code: null,
    exit_code: 0,
    timed_out: false,
    session_id: "ses_x",
    final_message: "done",
    event_counts: { step_start: 1, text: 1, step_finish: 1 },
    tokens: { total: 100, input: 80, output: 20, reasoning: 0 },
    cost: 0,
    stdout_sha256: "a".repeat(64),
    stderr_sha256: "b".repeat(64),
    invalid_json_lines: 0,
    request_url: null,
    ...overrides,
  };
}

function diff(overrides: Partial<DiffCheckResult> = {}): DiffCheckResult {
  return {
    changed_files: ["apps/executor/src/a.ts"],
    violations: [],
    ok: true,
    has_uncommitted: false,
    ...overrides,
  };
}

function evidence(overrides: Partial<TestEvidence> = {}): TestEvidence {
  return {
    evidence_id: "EVID-TASK-0001-A1-1",
    command: ["npm", "run", "check"],
    exit_code: 0,
    summary: { passed: 80, failed: 0, skipped: 0 },
    log_artifact: null,
    output_sha256: "c".repeat(64),
    ...overrides,
  };
}

function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    lease: LEASE,
    adapter: adapter(),
    diff: diff(),
    evidence: evidence(),
    base_sha: BASE,
    head_sha: HEAD,
    sensitive_touches: [],
    commit_shas: [HEAD],
    note: null,
    reported_at: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 适配器状态映射
 * ------------------------------------------------------------------ */

describe("mapAdapterStatus", () => {
  it("completed 映射为乐观的 ready_for_integration", () => {
    expect(mapAdapterStatus(adapter())).toEqual({
      status: "ready_for_integration",
      error_code: null,
    });
  });

  it("凭据失败映射为 blocked_auth（不计返修）", () => {
    const mapped = mapAdapterStatus(adapter({ status: "blocked_auth", error_code: "AUTH_EXPIRED" }));
    expect(mapped.status).toBe("blocked_auth");
    expect(mapped.error_code).toBe("AUTH_EXPIRED");
  });

  it("配额失败映射为 blocked_quota", () => {
    const mapped = mapAdapterStatus(
      adapter({ status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" }),
    );
    expect(mapped.status).toBe("blocked_quota");
  });

  it("限流映射为 repair_pending 但保留 RATE_LIMITED 以免误计返修", () => {
    const mapped = mapAdapterStatus(adapter({ status: "retryable", error_code: "RATE_LIMITED" }));
    expect(mapped.status).toBe("repair_pending");
    expect(mapped.error_code).toBe("RATE_LIMITED");
  });
});

/* ------------------------------------------------------------------ *
 * 降级判定：核心
 * ------------------------------------------------------------------ */

describe("normalizeResult — 成功路径", () => {
  it("证据齐全且全绿 → ready_for_integration，且通过协议 schema", () => {
    const report = normalizeResult(input());
    expect(report.status).toBe("ready_for_integration");
    expect(report.error_code).toBeNull();
    expect(isReadyForIntegration(report)).toBe(true);
    // 必须能通过协议校验（含 superRefine）
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("携带租约的全部身份字段", () => {
    const report = normalizeResult(input());
    expect(report.task_id).toBe("TASK-0001");
    expect(report.attempt_id).toBe("TASK-0001-A1");
    expect(report.executor_id).toBe("EXE-B-DESKTOP");
    expect(report.lease_epoch).toBe(3);
    expect(report.agent_kind).toBe("opencode");
  });

  it("透传版本绑定四元组", () => {
    const report = normalizeResult(input());
    expect(report.rules_sha).toBe("a577d66");
    expect(report.contract_sha).toBe("a577d66");
    expect(report.acceptance_sha).toBe("a577d66");
  });
});

describe("normalizeResult — 必须降级的场景", () => {
  it("没有测试证据 → 降为 repair_pending + TESTS_FAILED", () => {
    const report = normalizeResult(input({ evidence: null }));
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("TESTS_FAILED");
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("测试退出码非零 → 降级", () => {
    const report = normalizeResult(input({ evidence: evidence({ exit_code: 1 }) }));
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("TESTS_FAILED");
  });

  it("有失败用例 → 降级（退出码 0 也不能绕过）", () => {
    const report = normalizeResult(
      input({ evidence: evidence({ exit_code: 0, summary: { passed: 79, failed: 1, skipped: 0 } }) }),
    );
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("TESTS_FAILED");
  });

  it("diff 越界 → DIFF_OUT_OF_SCOPE，且备注列出越界文件", () => {
    const report = normalizeResult(
      input({
        diff: diff({ ok: false, violations: ["apps/coordinator/src/api.ts"] }),
      }),
    );
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("DIFF_OUT_OF_SCOPE");
    expect(report.note).toContain("apps/coordinator/src/api.ts");
  });

  it("触碰敏感文件 → blocked_approval + SENSITIVE_FILE_DETECTED", () => {
    const report = normalizeResult(input({ sensitive_touches: ["apps/executor/.env"] }));
    expect(report.status).toBe("blocked_approval");
    expect(report.error_code).toBe("SENSITIVE_FILE_DETECTED");
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("head_sha 等于 base_sha（无提交）→ 降级", () => {
    const report = normalizeResult(input({ head_sha: BASE }));
    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("INTERNAL_ERROR");
  });

  it("敏感文件优先级高于 diff 越界", () => {
    const report = normalizeResult(
      input({
        sensitive_touches: ["keys/id_rsa"],
        diff: diff({ ok: false, violations: ["other/x.ts"] }),
      }),
    );
    expect(report.error_code).toBe("SENSITIVE_FILE_DETECTED");
  });
});

/* ------------------------------------------------------------------ *
 * 返修计数（验收 V10）
 * ------------------------------------------------------------------ */

describe("返修计数判定", () => {
  it("凭据阻塞不计返修，且需用户介入", () => {
    const report = normalizeResult(
      input({ adapter: adapter({ status: "blocked_auth", error_code: "AUTH_EXPIRED" }) }),
    );
    expect(countsAsRepair(report)).toBe(false);
    expect(requiresUserIntervention(report)).toBe(true);
  });

  it("配额阻塞不计返修，且需用户介入", () => {
    const report = normalizeResult(
      input({ adapter: adapter({ status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" }) }),
    );
    expect(countsAsRepair(report)).toBe(false);
    expect(requiresUserIntervention(report)).toBe(true);
  });

  it("限流不计返修", () => {
    const report = normalizeResult(
      input({ adapter: adapter({ status: "retryable", error_code: "RATE_LIMITED" }) }),
    );
    expect(countsAsRepair(report)).toBe(false);
  });

  it("测试失败算返修", () => {
    const report = normalizeResult(
      input({ evidence: evidence({ summary: { passed: 0, failed: 3, skipped: 0 } }) }),
    );
    expect(countsAsRepair(report)).toBe(true);
  });

  it("超时算返修", () => {
    const report = normalizeResult(
      input({ adapter: adapter({ status: "failed", error_code: "AGENT_TIMEOUT" }) }),
    );
    expect(countsAsRepair(report)).toBe(true);
  });

  it("成功结果既不计返修也不需要介入", () => {
    const report = normalizeResult(input());
    expect(countsAsRepair(report)).toBe(false);
    expect(requiresUserIntervention(report)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * schema 一致性：所有状态都能通过协议校验
 * ------------------------------------------------------------------ */

describe("与协议 schema 的一致性", () => {
  const cases: Array<[string, NormalizeInput]> = [
    ["成功", input()],
    ["无证据", input({ evidence: null })],
    ["越界", input({ diff: diff({ ok: false, violations: ["x.ts"] }) })],
    ["敏感文件", input({ sensitive_touches: [".env"] })],
    ["无提交", input({ head_sha: BASE })],
    ["凭据阻塞", input({ adapter: adapter({ status: "blocked_auth", error_code: "AUTH_EXPIRED" }) })],
    ["配额阻塞", input({ adapter: adapter({ status: "blocked_quota", error_code: "QUOTA_EXHAUSTED" }) })],
    ["限流", input({ adapter: adapter({ status: "retryable", error_code: "RATE_LIMITED" }) })],
    ["超时", input({ adapter: adapter({ status: "failed", error_code: "AGENT_TIMEOUT" }) })],
    ["非零退出", input({ adapter: adapter({ status: "failed", error_code: "AGENT_NONZERO_EXIT" }) })],
  ];

  it.each(cases)("%s 情形生成的报告可通过 ResultReportSchema", (_name, normalizeInputValue) => {
    const report = normalizeResult(normalizeInputValue);
    const parsed = ResultReportSchema.safeParse(report);
    if (!parsed.success) {
      throw new Error(`schema 校验失败：${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  it("非成功状态必定带 error_code（schema 的强制要求）", () => {
    const failureInputs: NormalizeInput[] = [
      input({ evidence: null }),
      input({ diff: diff({ ok: false, violations: ["x.ts"] }) }),
      input({ adapter: adapter({ status: "failed", error_code: "AGENT_TIMEOUT" }) }),
    ];
    for (const each of failureInputs) {
      const report = normalizeResult(each);
      if (report.status !== "ready_for_integration") {
        expect(report.error_code).not.toBeNull();
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 备注长度限制
 * ------------------------------------------------------------------ */

describe("备注长度", () => {
  it("超长越界列表被截断在 2000 字符内", () => {
    const many = Array.from({ length: 500 }, (_, i) => `path/to/very/long/file-${i}.ts`);
    const report = normalizeResult(input({ diff: diff({ ok: false, violations: many }) }));
    expect(report.note).not.toBeNull();
    expect(report.note!.length).toBeLessThanOrEqual(2000);
    expect(() => ResultReportSchema.parse(report)).not.toThrow();
  });

  it("无异常时备注为 null", () => {
    expect(normalizeResult(input()).note).toBeNull();
  });
});
