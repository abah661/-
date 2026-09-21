/**
 * 任务生命周期状态机（第 7 节）。
 *
 * 正常路径：
 *   draft → planning → ready → leased → running → validating
 *         → ready_for_integration → integrating → passed → merged
 *
 * 异常状态（终止或可回流）：repair_pending / blocked_auth / blocked_quota /
 *   blocked_approval / needs_input / cancelled
 *
 * 该表是由两端共享的唯一定义。执行器与协调器都不得自行扩展转移，
 * 新增转移必须走协议变更提案（见 docs/protocol-changes.md）。
 */

export const TASK_STATUSES = [
  // 正常路径
  "draft",
  "planning",
  "ready",
  "leased",
  "running",
  "validating",
  "ready_for_integration",
  "integrating",
  "passed",
  "merged",
  // 异常路径
  "repair_pending",
  "blocked_auth",
  "blocked_quota",
  "blocked_approval",
  "needs_input",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 满足"终态"语义的状态：不会再自动产生后继状态。 */
export const TERMINAL_STATUSES = ["merged", "cancelled"] as const satisfies readonly TaskStatus[];

/** 需要用户介入才能继续的状态。第 11 节授权表与第 15 节暂停流程对应。 */
export const BLOCKED_STATUSES = [
  "blocked_auth",
  "blocked_quota",
  "blocked_approval",
  "needs_input",
] as const satisfies readonly TaskStatus[];

/**
 * 合法转移表。键为当前状态，值为允许到达的下一个状态集合。
 *
 * 设计约束：
 * - `leased → running` 只能由持有当前 lease_epoch 的执行器推进。
 * - `running → validating` 表示执行器已本地自检，进入独立校验。
 * - `validating → passed` 只表示"单任务自身契约通过"，
 *   完整功能仍必须由组合测试验收（第 P5 节）。
 * - 任意非终态都可以在授权下进入 `cancelled`。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  draft: ["planning", "cancelled"],

  planning: ["ready", "needs_input", "cancelled"],

  // 计划就绪，等待执行器领取
  ready: ["leased", "needs_input", "cancelled"],

  // 已分配租约，等待执行器确认开工
  leased: ["running", "ready", "blocked_auth", "blocked_quota", "cancelled"],

  // 执行中
  running: [
    "validating",
    "repair_pending",
    "blocked_auth",
    "blocked_quota",
    "needs_input",
    "cancelled",
  ],

  // 独立校验本地结果
  validating: [
    "ready_for_integration",
    "repair_pending",
    "blocked_approval",
    "needs_input",
    "cancelled",
  ],

  // 单任务通过，等待批次整合
  ready_for_integration: ["integrating", "repair_pending", "cancelled"],

  // 组合构建与测试进行中
  integrating: ["passed", "repair_pending", "cancelled"],

  // 组合测试通过，等待授权合并
  passed: ["merged", "blocked_approval", "repair_pending", "cancelled"],

  merged: [],

  // 诊断/返修。第 7 节：代码返修最多两次（可调）。
  repair_pending: [
    "ready",
    "planning",
    "needs_input",
    "blocked_quota",
    "blocked_auth",
    "cancelled",
  ],

  blocked_auth: ["ready", "cancelled"],
  blocked_quota: ["ready", "cancelled"],
  blocked_approval: ["passed", "needs_input", "cancelled"],
  needs_input: ["ready", "planning", "cancelled"],

  cancelled: [],
};

/** 判断一次状态转移是否合法。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  const allowed = TASK_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** 断言一次状态转移合法，否则抛出带上下文的错误。 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `非法状态转移：${from} → ${to}。` +
        `允许的目标状态为 [${TASK_TRANSITIONS[from].join(", ") || "（无，终态）"}]。`,
    );
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

export function isBlocked(status: TaskStatus): boolean {
  return (BLOCKED_STATUSES as readonly TaskStatus[]).includes(status);
}
