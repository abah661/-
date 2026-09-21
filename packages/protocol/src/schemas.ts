import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";
import { TASK_STATUSES } from "./status.js";
import { ERROR_CODES } from "./errors.js";

/* ------------------------------------------------------------------ *
 * 基础标量
 * ------------------------------------------------------------------ */

/** Git 提交号：完整或短 SHA，只允许十六进制。 */
export const ShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, "必须是 7–64 位小写十六进制 Git 提交号");

export const TaskIdSchema = z
  .string()
  .regex(/^TASK-[0-9]{4,}$/, "任务 ID 形如 TASK-0001");

export const AttemptIdSchema = z
  .string()
  .regex(/^TASK-[0-9]{4,}-A[0-9]{1,3}$/, "尝试 ID 形如 TASK-0001-A1");

export const ExecutorIdSchema = z
  .string()
  .regex(/^EXE-[A-Z]-[0-9A-Z-]{2,32}$/, "执行器 ID 形如 EXE-A-LENOVO 或 EXE-B-DESKTOP");

export const BatchIdSchema = z
  .string()
  .regex(/^BATCH-[0-9]{4,}$/, "批次 ID 形如 BATCH-0001");

export const ContractVersionSchema = z
  .string()
  .regex(/^v[0-9]+(\.[0-9]+)*$/, "契约版本形如 v1 或 v1.2");

export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: "必须是带时区的 ISO 8601 时间戳" });

/** 协议版本字段：当前只接受 "1"。 */
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/**
 * 任务能力标签。执行器注册时声明自己具备哪些能力，
 * 协调器据此避免把任务派给不具备能力的执行器（第 8 节 步骤 1）。
 */
export const CapabilitySchema = z.enum([
  "plan", // 具备规划能力，可承接 plan 任务
  "code", // 具备编码能力
  "test", // 具备运行测试能力
  "git_push", // 已被授权推送任务分支
  "dry_run", // 仅本地演练，不产生远程副作用
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/** agent 种类。第一版只有这两种。 */
export const AgentKindSchema = z.enum(["codex", "opencode", "mock"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/** 任务类型。 */
export const TaskKindSchema = z.enum([
  "plan", // 生成任务图与验收条件
  "implement", // 实现功能
  "diagnose", // 只诊断不修复（第 9 节 步骤 7：归因不明确先诊断）
  "repair", // 返修
  "integrate", // 组合验收
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

/* ------------------------------------------------------------------ *
 * 契约引用与版本绑定（第 6 节 / 规则 2）
 * ------------------------------------------------------------------ */

/**
 * 一次领取所绑定的版本集合。
 * 规则 2：每次领取绑定基线 SHA、规则、契约和验收版本。
 * 任何一项为空都不允许开工。
 */
export const VersionBindingSchema = z.object({
  base_sha: ShaSchema.describe("任务开工的 Git 基线提交号"),
  rules_sha: ShaSchema.describe("AGENTS.md 所在提交号"),
  contract_sha: ShaSchema.describe("接口契约所在提交号"),
  acceptance_sha: ShaSchema.describe("独立验收基线所在提交号"),
});
export type VersionBinding = z.infer<typeof VersionBindingSchema>;

/** 契约引用：指明某任务依据哪一份契约的哪个版本。 */
export const ContractRefSchema = z.object({
  /** 契约标识，例如 api.user-profile */
  contract_id: z.string().min(1).max(128),
  version: ContractVersionSchema,
  /** 契约文件在仓库中的相对路径 */
  path: z.string().min(1).max(512),
  sha: ShaSchema,
  /** 该任务在契约中的角色 */
  role: z.enum(["provider", "consumer", "both", "none"]),
});
export type ContractRef = z.infer<typeof ContractRefSchema>;

/* ------------------------------------------------------------------ *
 * 写入范围（规则 3）
 * ------------------------------------------------------------------ */

/**
 * 允许修改的路径范围。规则 3：agent 只能修改允许范围；
 * 实际 Git diff 必须再由执行器检查。这里只做声明，
 * 强制检查在执行器与 CI 中进行（AGENTS.md 第 120 行原则）。
 */
export const WriteScopeSchema = z.object({
  /** 允许写入的路径 glob 列表，至少一项 */
  allow: z.array(z.string().min(1)).min(1),
  /** 显式禁止的路径 glob 列表，优先级高于 allow */
  deny: z.array(z.string().min(1)).default([]),
});
export type WriteScope = z.infer<typeof WriteScopeSchema>;

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

export const TaskNodeSchema = z.object({
  task_id: TaskIdSchema,
  kind: TaskKindSchema,
  title: z.string().min(1).max(200),
  /** 该任务的验收条件，必须非空（第 6 节：验收覆盖检查） */
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  /** 依赖的任务 ID；协调器检查无环 */
  depends_on: z.array(TaskIdSchema).default([]),
  write_scope: WriteScopeSchema,
  contracts: z.array(ContractRefSchema).default([]),
  /** 所需能力 */
  requires: z.array(CapabilitySchema).min(1),
  /** 期望产出的接口描述，供规划输出检查 */
  expected_interfaces: z.array(z.string().min(1)).default([]),
  status: TaskStatusSchema,
  /** 由哪个执行器承接；未分配时为 null */
  assigned_executor: ExecutorIdSchema.nullable().default(null),
  attempts_used: z.number().int().min(0).default(0),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

/**
 * 规划输出（第 6 节）。
 * 协调器据此检查：无环依赖、字段完整、验收覆盖、授权范围。
 */
export const TaskGraphSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    project_id: z.string().min(1).max(64),
    /** 需求原文摘要，标明来源（第 11 节：摘要必须标明来源任务和版本） */
    requirement_ref: z.string().min(1),
    tasks: z.array(TaskNodeSchema).min(1),
    /** 规划所依据的版本绑定 */
    binding: VersionBindingSchema,
    /** 规划生成时间 */
    created_at: IsoDateTimeSchema,
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const [index, task] of graph.tasks.entries()) {
      if (ids.has(task.task_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "task_id"],
          message: `任务 ID 重复：${task.task_id}`,
        });
      }
      ids.add(task.task_id);
    }
    // 依赖必须指向图内存在的任务
    for (const [index, task] of graph.tasks.entries()) {
      for (const dep of task.depends_on) {
        if (!ids.has(dep)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on"],
            message: `依赖了不存在的任务：${dep}`,
          });
        }
        if (dep === task.task_id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", index, "depends_on"],
            message: `任务不能依赖自身：${task.task_id}`,
          });
        }
      }
    }
  });
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

/* ------------------------------------------------------------------ *
 * 租约（第 7 节）
 * ------------------------------------------------------------------ */

/**
 * 租约。领取时分配 attempt_id、递增的 lease_epoch 和服务端到期时间。
 * 重派后旧 epoch 的报告不能成为有效成果（验收 V08）。
 */
export const LeaseSchema = z.object({
  task_id: TaskIdSchema,
  attempt_id: AttemptIdSchema,
  executor_id: ExecutorIdSchema,
  lease_epoch: z.number().int().min(1),
  /** 服务端计算的到期时间 */
  expires_at: IsoDateTimeSchema,
  /** 领取时刻的决定性版本绑定 */
  binding: VersionBindingSchema,
  agent_kind: AgentKindSchema,
});
export type Lease = z.infer<typeof LeaseSchema>;

/* ------------------------------------------------------------------ *
 * 结果报告（第 7 节示例的直接实现）
 * ------------------------------------------------------------------ */

export const ResultStatusSchema = z.enum([
  "ready_for_integration",
  "repair_pending",
  "blocked_auth",
  "blocked_quota",
  "blocked_approval",
  "needs_input",
  "cancelled",
  "failed",
]);
export type ResultStatus = z.infer<typeof ResultStatusSchema>;

/** 测试证据引用。第 11 节：较大日志留在 artifacts，云端保存引用与摘要。 */
export const TestEvidenceSchema = z.object({
  evidence_id: z.string().min(1).max(128),
  /** 实际执行的命令，数组形式（第 8 节：固定程序和参数数组） */
  command: z.array(z.string().min(1)).min(1),
  exit_code: z.number().int(),
  /** 通过/失败汇总，供云端快速判定 */
  summary: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0).default(0),
  }),
  /** 日志 artifact 的引用，可为空 */
  log_artifact: z.string().max(512).nullable().default(null),
  /** 命令行输出的 SHA-256，用于核对未被篡改 */
  output_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "必须是 64 位小写十六进制 SHA-256")
    .nullable()
    .default(null),
});
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

/**
 * 结果报告。第 8 节步骤 8：
 * agent 说"完成"或退出码为 0 都不足以判定成功。
 * 因此 status 与 evidence 必须同时满足条件才进入 ready_for_integration。
 */
export const ResultReportSchema = z
  .object({
    protocol_version: ProtocolVersionSchema,
    task_id: TaskIdSchema,
    attempt_id: AttemptIdSchema,
    executor_id: ExecutorIdSchema,
    lease_epoch: z.number().int().min(1),
    agent_kind: AgentKindSchema,
    base_sha: ShaSchema,
    head_sha: ShaSchema,
    rules_sha: ShaSchema,
    contract_sha: ShaSchema,
    acceptance_sha: ShaSchema,
    status: ResultStatusSchema,
    evidence_id: z.string().min(1).max(128).nullable().default(null),
    /** 实际被修改的文件列表，由执行器从 git diff 得出（规则 3） */
    changed_files: z.array(z.string().min(1)).default([]),
    /** 结构化证据 */
    evidence: TestEvidenceSchema.nullable().default(null),
    /** 失败时的错误分类，成功时为 null */
    error_code: ErrorCodeSchema.nullable().default(null),
    /** 提交哈希，供协调器核对 */
    commit_shas: z.array(ShaSchema).default([]),
    /** 备注，不得包含敏感信息 */
    note: z.string().max(2000).nullable().default(null),
    reported_at: IsoDateTimeSchema,
  })
  .superRefine((report, ctx) => {
    // 声明 ready_for_integration 时，必须带证据且测试必须全绿
    // 验收 V06：退出 0 或完成文案不能绕过测试
    if (report.status === "ready_for_integration") {
      if (!report.evidence) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "ready_for_integration 必须附带测试证据，不能仅凭 agent 自报完成",
        });
      } else {
        if (report.evidence.exit_code !== 0) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence", "exit_code"],
            message: "ready_for_integration 要求测试退出码为 0",
          });
        }
        if (report.evidence.summary.failed > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["evidence", "summary", "failed"],
            message: "ready_for_integration 要求失败用例数为 0",
          });
        }
      }
      if (!report.evidence_id) {
        ctx.addIssue({
          code: "custom",
          path: ["evidence_id"],
          message: "ready_for_integration 必须提供 evidence_id",
        });
      }
      if (report.head_sha === report.base_sha) {
        ctx.addIssue({
          code: "custom",
          path: ["head_sha"],
          message: "ready_for_integration 必须包含至少一个提交，head_sha 不能等于 base_sha",
        });
      }
    }

    // 非成功状态必须带错误分类
    const failureStatuses: ReadonlySet<string> = new Set([
      "repair_pending",
      "blocked_auth",
      "blocked_quota",
      "blocked_approval",
      "needs_input",
      "failed",
    ]);
    if (failureStatuses.has(report.status) && !report.error_code) {
      ctx.addIssue({
        code: "custom",
        path: ["error_code"],
        message: `${report.status} 必须提供 error_code，以便区分登录、配额与代码失败`,
      });
    }
  });
export type ResultReport = z.infer<typeof ResultReportSchema>;

/* ------------------------------------------------------------------ *
 * 事件（第 7 节：接收 GitHub 事件、回报证据）
 * ------------------------------------------------------------------ */

export const EventTypeSchema = z.enum([
  "task.created",
  "task.leased",
  "task.renewed",
  "task.reported",
  "task.transitioned",
  "batch.created",
  "batch.failed",
  "batch.passed",
  "contract.proposed",
  "github.workflow_run",
  "github.pull_request",
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z.object({
  event_id: z.string().min(1).max(128),
  event_type: EventTypeSchema,
  protocol_version: ProtocolVersionSchema,
  project_id: z.string().min(1).max(64),
  occurred_at: IsoDateTimeSchema,
  /** 触发该事件的执行器；系统事件为 null */
  executor_id: ExecutorIdSchema.nullable().default(null),
  task_id: TaskIdSchema.nullable().default(null),
  batch_id: BatchIdSchema.nullable().default(null),
  /** 事件载荷；具体结构由 event_type 决定，云端按类型再校验 */
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/* ------------------------------------------------------------------ *
 * 执行器注册
 * ------------------------------------------------------------------ */

export const ExecutorRegistrationSchema = z.object({
  protocol_version: ProtocolVersionSchema,
  executor_id: ExecutorIdSchema,
  /** 主机标识，仅供运维辨识，不参与认证（第 11 节：身份由认证映射） */
  host_label: z.string().min(1).max(64),
  agent_kind: AgentKindSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  /** 工具版本矩阵条目（第 4.1 节） */
  tool_versions: z.record(z.string(), z.string()).default({}),
  /** 本项目根目录，用于核对工作目录（不参与认证） */
  project_root: z.string().min(1).max(512),
  registered_at: IsoDateTimeSchema,
});
export type ExecutorRegistration = z.infer<typeof ExecutorRegistrationSchema>;

/* ------------------------------------------------------------------ *
 * 幂等与整合批次
 * ------------------------------------------------------------------ */

export const IdempotencyKeySchema = z.object({
  scope: z.string().min(1).max(64),
  key: z.string().min(1).max(200),
});

/** 整合批次（第 9 节）。 */
export const IntegrationBatchSchema = z.object({
  batch_id: BatchIdSchema,
  project_id: z.string().min(1).max(64),
  /** 固定 main 基线 */
  base_sha: ShaSchema,
  /** 候选 head SHA 列表，与合并顺序一致 */
  candidate_heads: z.array(ShaSchema).min(1),
  rules_sha: ShaSchema,
  contract_sha: ShaSchema,
  acceptance_sha: ShaSchema,
  /** 受信任工作流引用，例如 .github/workflows/integration.yml@<sha> */
  trusted_workflow: z.string().min(1),
  created_at: IsoDateTimeSchema,
  /** 检查结论 */
  conclusion: z.enum(["pending", "passed", "failed", "superseded"]).default("pending"),
  /** GitHub Actions run ID，用于回查（第 9 节：不接受 agent 自报的 CI 成功） */
  ci_run_id: z.string().max(64).nullable().default(null),
  /** 组合提交与树哈希，用于证明实际合并对象 */
  merged_sha: ShaSchema.nullable().default(null),
  tree_sha: ShaSchema.nullable().default(null),
});
export type IntegrationBatch = z.infer<typeof IntegrationBatchSchema>;
