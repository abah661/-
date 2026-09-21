/**
 * 结果归一化：把两端适配器的输出映射为协议 ResultReport。
 *
 * ## 为什么需要这一层
 * 第 8 节末要求「Codex 适配器与 OpenCode 适配器…归一成同一种结果」。
 * 两个适配器的 `status` 词汇表各自合理，但**不能直接把 adapter status
 * 当作协议 status** —— 协议的状态机有严格语义（`ready_for_integration`
 * 只在证据齐全且全绿时才允许），且 schema 层有 superRefine 强制校验。
 *
 * ## 本层承担的判定（第 8 节步骤 8）
 * 「agent 说完成或退出码为 0 都不足以判定成功」。因此：
 * - adapter `completed` **不等于** `ready_for_integration`
 * - 必须同时满足：测试证据存在、`exit_code === 0`、`failed === 0`、
 *   `head_sha !== base_sha`、diff 未越界、无敏感文件触碰
 * - 任一不满足即降级为 `repair_pending` 并给出精确 error_code
 */

import type {
  ErrorCode,
  ResultReport,
  ResultStatus,
  TestEvidence,
  Lease,
} from "@dac/protocol";
import { ERROR_POLICY } from "@dac/protocol";
import type { OpenCodeAdapterResult } from "../adapters/opencode.js";
import type { DiffCheckResult } from "../core/diff-check.js";

/** 归一化所需的全部输入。刻意做成显式对象，避免隐式默认值。 */
export interface NormalizeInput {
  /** 领取时得到的租约，提供 task/attempt/executor/epoch/binding */
  lease: Lease;
  /** 适配器结果 */
  adapter: OpenCodeAdapterResult;
  /** diff 核对结果 */
  diff: DiffCheckResult;
  /** 测试证据；未跑测试时为 null */
  evidence: TestEvidence | null;
  /** git 提交号 */
  base_sha: string;
  head_sha: string;
  /** 敏感文件触碰列表（来自 findSensitiveTouches） */
  sensitive_touches?: readonly string[];
  /** 本地提交哈希列表 */
  commit_shas?: readonly string[];
  /** 备注 */
  note?: string | null;
  /** 注入的当前时间，便于测试确定性 */
  reported_at: string;
}

/**
 * 把适配器状态映射到协议结果状态。
 *
 * 注意 `blocked_*` 与 `retryable` 的区分：前者需要用户介入
 * （`disposition: "blocked"`），后者由协调器重派而不计返修次数。
 * 若把限流误映射为 `repair_pending`，就会白白消耗返修次数。
 */
export function mapAdapterStatus(adapter: OpenCodeAdapterResult): {
  status: ResultStatus;
  error_code: ErrorCode | null;
} {
  switch (adapter.status) {
    case "completed":
      // 先给乐观值，最终由 evidence + diff 决定是否降级
      return { status: "ready_for_integration", error_code: null };
    case "blocked_auth":
      return { status: "blocked_auth", error_code: adapter.error_code ?? "AUTH_EXPIRED" };
    case "blocked_quota":
      return { status: "blocked_quota", error_code: adapter.error_code ?? "QUOTA_EXHAUSTED" };
    case "retryable":
      // 可重试类（限流）不属于「失败返修」，协议无 retryable 状态，
      // 用 repair_pending 承载但保留精确 error_code 供协调器判断是否计返修。
      return { status: "repair_pending", error_code: adapter.error_code ?? "RATE_LIMITED" };
    case "failed":
      return { status: "repair_pending", error_code: adapter.error_code ?? "INTERNAL_ERROR" };
  }
}

/**
 * 生成结果报告。
 *
 * 这是一个**纯函数**：不读时钟、不发网络请求、不访问文件系统。
 * 时间由 `reported_at` 注入，使测试完全确定。
 */
export function normalizeResult(input: NormalizeInput): ResultReport {
  const { lease, adapter, diff, evidence } = input;
  const mapped = mapAdapterStatus(adapter);

  let status = mapped.status;
  let errorCode = mapped.error_code;

  // —— 降级判定：只有在 adapter 自称完成时才需要复核 ——
  if (status === "ready_for_integration") {
    if (sensitiveTouchesPresent(input.sensitive_touches)) {
      status = "blocked_approval";
      errorCode = "SENSITIVE_FILE_DETECTED";
    } else if (!diff.ok) {
      status = "repair_pending";
      errorCode = "DIFF_OUT_OF_SCOPE";
    } else if (!evidence) {
      // 没跑测试就宣称完成——这正是第 8 节要防的「自报完成」
      status = "repair_pending";
      errorCode = "TESTS_FAILED";
    } else if (evidence.exit_code !== 0) {
      status = "repair_pending";
      errorCode = "TESTS_FAILED";
    } else if (evidence.summary.failed > 0) {
      status = "repair_pending";
      errorCode = "TESTS_FAILED";
    } else if (input.head_sha === input.base_sha) {
      // 没有任何提交，不可能有成果
      status = "repair_pending";
      errorCode = "INTERNAL_ERROR";
    }
  }

  const report: ResultReport = {
    protocol_version: "1",
    task_id: lease.task_id,
    attempt_id: lease.attempt_id,
    executor_id: lease.executor_id,
    lease_epoch: lease.lease_epoch,
    agent_kind: lease.agent_kind,
    base_sha: input.base_sha,
    head_sha: input.head_sha,
    rules_sha: lease.binding.rules_sha,
    contract_sha: lease.binding.contract_sha,
    acceptance_sha: lease.binding.acceptance_sha,
    status,
    evidence_id: evidence?.evidence_id ?? null,
    changed_files: [...diff.changed_files],
    evidence,
    error_code: errorCode,
    commit_shas: [...(input.commit_shas ?? [])],
    note: buildNote(input, status),
    reported_at: input.reported_at,
  };

  return report;
}

function sensitiveTouchesPresent(touches: readonly string[] | undefined): boolean {
  return Array.isArray(touches) && touches.length > 0;
}

/**
 * 组装备注。**不得包含敏感信息**（schema 限制 2000 字符）。
 * 越界与敏感触碰要在此列出具体路径，否则云端无法复核。
 */
function buildNote(input: NormalizeInput, status: ResultStatus): string | null {
  const parts: string[] = [];

  if (!input.diff.ok) {
    parts.push(`越界文件：${input.diff.violations.join(", ")}`);
  }
  if (input.sensitive_touches && input.sensitive_touches.length > 0) {
    parts.push(`触碰敏感文件：${input.sensitive_touches.join(", ")}`);
  }
  if (input.adapter.request_url) {
    // 诊断线索：出错时请求打向哪个地址（用于发现走错 provider）
    parts.push(`请求地址：${input.adapter.request_url}`);
  }
  if (input.adapter.timed_out) {
    parts.push("agent 超时被终止");
  }
  if (input.note) {
    parts.push(input.note);
  }
  if (parts.length === 0) return null;

  const combined = parts.join("；");
  // schema 上限 2000
  return combined.length > 2000 ? `${combined.slice(0, 1997)}...` : combined;
}

/**
 * 该结果是否应计入返修次数。
 *
 * 直接用协议的错误策略判定，**不在执行器里另写一套规则**——
 * 两端对「什么算代码失败」的理解必须来自同一张表（验收 V10）。
 */
export function countsAsRepair(report: ResultReport): boolean {
  if (!report.error_code) return false;
  return ERROR_POLICY[report.error_code].disposition === "repairable";
}

/** 该结果是否阻塞并需要用户介入。 */
export function requiresUserIntervention(report: ResultReport): boolean {
  if (!report.error_code) return false;
  return ERROR_POLICY[report.error_code].disposition === "blocked";
}

/**
 * 结果是否可信地表示「可以进入整合」。
 * 与协议 schema 的 superRefine 保持同义，但可独立调用以便执行器提前自检。
 */
export function isReadyForIntegration(report: ResultReport): boolean {
  return (
    report.status === "ready_for_integration" &&
    report.evidence !== null &&
    report.evidence.exit_code === 0 &&
    report.evidence.summary.failed === 0 &&
    report.evidence_id !== null &&
    report.head_sha !== report.base_sha
  );
}
