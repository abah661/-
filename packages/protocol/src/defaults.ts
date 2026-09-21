/**
 * 协调参数默认值（第 7 节）。
 * 文档明确说明这些是"可调建议值"，因此集中在此处，
 * 任何调整都记录变更理由，不散落在实现里。
 */

export const DEFAULT_TIMING = {
  /** 空闲轮询间隔（毫秒），实际使用时应叠加随机延迟 */
  pollIntervalMs: 15_000,
  /** 轮询随机延迟上限（毫秒），避免两端同时领取 */
  pollJitterMs: 5_000,
  /** 心跳间隔（毫秒） */
  heartbeatIntervalMs: 30_000,
  /** 租约时长（毫秒）。心跳间隔必须显著小于它 */
  leaseTtlMs: 180_000,
  /** 单任务最长执行时间（毫秒） */
  taskTimeoutMs: 30 * 60_000,
} as const;

export const DEFAULT_LIMITS = {
  /** 每台机器同时最多运行一个任务子进程 */
  maxConcurrentTasksPerExecutor: 1,
  /** 代码返修最多两次 */
  maxRepairAttempts: 2,
  /** 规划输出格式不合法时最多退回修正两次 */
  maxPlanRejections: 2,
  /** 同一项目一次仅整合一个批次 */
  maxConcurrentBatchesPerProject: 1,
} as const;

/**
 * 一致性断言：心跳必须显著早于租约到期，否则会频繁误判失效。
 * 这里给出 1/3 的比例阈值。
 */
export function validateTimingConfig(t: typeof DEFAULT_TIMING): string[] {
  const problems: string[] = [];
  if (t.heartbeatIntervalMs * 3 > t.leaseTtlMs) {
    problems.push(
      `心跳间隔 ${t.heartbeatIntervalMs}ms 相对租约 ${t.leaseTtlMs}ms 过大，` +
        `要求 heartbeat * 3 <= leaseTtl`,
    );
  }
  if (t.pollJitterMs > t.pollIntervalMs) {
    problems.push("轮询随机延迟不应大于轮询间隔本身");
  }
  if (t.taskTimeoutMs <= t.leaseTtlMs) {
    problems.push("单任务超时应当大于租约时长，否则租约无法覆盖任务全程");
  }
  return problems;
}
