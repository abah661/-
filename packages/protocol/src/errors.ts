/**
 * 错误分类（第 8 节 / 验收 V10）。
 *
 * 关键规则：登录过期与配额不足必须分别标记，
 * **不得**按代码失败反复返修。因此错误码按"是否可自动重试"分为三类。
 */

export const ERROR_CODES = [
  // —— agent 与工程类：可作为代码失败进入返修 ——
  "AGENT_NONZERO_EXIT",
  "AGENT_INVALID_OUTPUT",
  "AGENT_TIMEOUT",
  "TESTS_FAILED",
  "DIFF_OUT_OF_SCOPE",
  "RESULT_SCHEMA_INVALID",
  "CONTRACT_MISMATCH",
  "GIT_MERGE_CONFLICT",
  "PUSH_REJECTED",
  "WORKTREE_DIRTY",

  // —— 凭据与配额类：阻塞并请求介入，不进入返修计数 ——
  "AUTH_EXPIRED",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",

  // —— 协调类：租约与幂等 ——
  "LEASE_EXPIRED",
  "LEASE_EPOCH_STALE",
  "NOT_LEASE_HOLDER",
  "IDEMPOTENT_REPLAY",
  "CAPABILITY_UNSUPPORTED",

  // —— 授权与规则类：需要用户明确批准 ——
  "UNAUTHORIZED_OPERATION",
  "SENSITIVE_FILE_DETECTED",
  "ACCEPTANCE_TAMPERED",

  // —— 未知 ——
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 错误处置策略。决定返修计数器是否递增。 */
export type ErrorDisposition =
  /** 计入返修次数，自动派发返修任务 */
  | "repairable"
  /** 阻塞当前任务，等待用户或授权介入；不计入返修次数 */
  | "blocked"
  /** 执行器侧直接放弃本次尝试，由协调器重新派发，不计入返修次数 */
  | "retryable"
  /** 终态失败，需人工判断 */
  | "fatal";

export const ERROR_POLICY: Readonly<
  Record<ErrorCode, { disposition: ErrorDisposition; blockedStatus?: string; retryable: boolean }>
> = {
  AGENT_NONZERO_EXIT: { disposition: "repairable", retryable: true },
  AGENT_INVALID_OUTPUT: { disposition: "repairable", retryable: true },
  AGENT_TIMEOUT: { disposition: "repairable", retryable: true },
  TESTS_FAILED: { disposition: "repairable", retryable: true },
  DIFF_OUT_OF_SCOPE: { disposition: "repairable", retryable: false },
  RESULT_SCHEMA_INVALID: { disposition: "repairable", retryable: false },
  CONTRACT_MISMATCH: { disposition: "repairable", retryable: false },
  GIT_MERGE_CONFLICT: { disposition: "repairable", retryable: false },
  PUSH_REJECTED: { disposition: "retryable", retryable: true },
  WORKTREE_DIRTY: { disposition: "blocked", blockedStatus: "needs_input", retryable: false },

  // 登录与配额：分类阻塞，无无限重试
  AUTH_EXPIRED: { disposition: "blocked", blockedStatus: "blocked_auth", retryable: false },
  QUOTA_EXHAUSTED: { disposition: "blocked", blockedStatus: "blocked_quota", retryable: false },
  RATE_LIMITED: { disposition: "retryable", retryable: true },

  LEASE_EXPIRED: { disposition: "retryable", retryable: true },
  LEASE_EPOCH_STALE: { disposition: "retryable", retryable: false },
  NOT_LEASE_HOLDER: { disposition: "retryable", retryable: false },
  IDEMPOTENT_REPLAY: { disposition: "retryable", retryable: false },
  CAPABILITY_UNSUPPORTED: { disposition: "blocked", blockedStatus: "needs_input", retryable: false },

  UNAUTHORIZED_OPERATION: { disposition: "blocked", blockedStatus: "blocked_approval", retryable: false },
  SENSITIVE_FILE_DETECTED: {
    disposition: "blocked",
    blockedStatus: "blocked_approval",
    retryable: false,
  },
  ACCEPTANCE_TAMPERED: { disposition: "fatal", retryable: false },

  INTERNAL_ERROR: { disposition: "fatal", retryable: false },
};

/**
 * 判断某错误码是否计入返修次数。
 * 执行器与协调器都必须用此函数决定是否递增 attempt 的返修计数。
 */
export function isRepairable(code: ErrorCode): boolean {
  return ERROR_POLICY[code].disposition === "repairable";
}

/** 取得该错误码应对应的阻塞状态，无则为 null。 */
export function blockedStatusFor(code: ErrorCode): string | null {
  const policy = ERROR_POLICY[code];
  return policy.disposition === "blocked" ? (policy.blockedStatus ?? "needs_input") : null;
}

/** 判断该错误码是否值得自动重试（同一任务内、不换代码）。 */
export function isRetryable(code: ErrorCode): boolean {
  return ERROR_POLICY[code].retryable;
}
