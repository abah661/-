/**
 * 协议校验内核。
 *
 * 校验分三层（第 6 节"协调器检查无环依赖、字段完整、验收覆盖及授权范围"）：
 *   1. 结构层：zod schema 是否通过
 *   2. 语义层：任务图是否有环、验收条件是否覆盖、版本绑定是否齐全
 *   3. 反向层：非法样例必须被拒绝（防止 schema 被无意放宽）
 */

import { z } from "zod";
import {
  TaskGraphSchema,
  ResultReportSchema,
  ExecutorRegistrationSchema,
  IntegrationBatchSchema,
  EventEnvelopeSchema,
  analyzeGraph,
  PROTOCOL_META,
  PROTOCOL_VERSION,
} from "@dac/protocol";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationOutcome {
  ok: boolean;
  issues: ValidationIssue[];
}

function issuesFromZod(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/** 校验规划输出的任务图：结构 + 语义。 */
export function validateTaskGraph(input: unknown): ValidationOutcome {
  const parsed = TaskGraphSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: issuesFromZod(parsed.error) };
  }

  const issues: ValidationIssue[] = [];
  const graph = parsed.data;

  // 语义层：环检测、字段完整、验收覆盖
  const { problems } = analyzeGraph(graph);
  for (const problem of problems) {
    issues.push({ path: "(graph)", message: problem });
  }

  // 版本绑定必须齐全（规则 2：每次领取绑定基线 SHA、规则、契约和验收版本）
  const binding = graph.binding;
  if (!binding.base_sha || !binding.rules_sha || !binding.contract_sha || !binding.acceptance_sha) {
    issues.push({ path: "binding", message: "版本绑定不完整，任务不得开工" });
  }

  // 依赖不闭合：整图必须能拓扑排序（上面已检查），此处补充"孤立任务"提示
  const referenced = new Set(graph.tasks.flatMap((t) => t.depends_on));
  for (const task of graph.tasks) {
    const isSink = !graph.tasks.some((t) => t.depends_on.includes(task.task_id));
    if (!isSink && !referenced.has(task.task_id)) {
      issues.push({
        path: task.task_id,
        message: "该任务既无依赖也无被依赖关系，疑似规划遗漏",
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/** 校验执行器结果报告。 */
export function validateResultReport(input: unknown): ValidationOutcome {
  const parsed = ResultReportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: issuesFromZod(parsed.error) };
  }

  const issues: ValidationIssue[] = [];
  const report = parsed.data;

  // 协议版本必须与当前版本一致（第 6 节：双方按同一版本并行开发）
  if (report.protocol_version !== PROTOCOL_VERSION) {
    issues.push({
      path: "protocol_version",
      message: `协议版本不符：期望 ${PROTOCOL_VERSION}，实际 ${report.protocol_version}`,
    });
  }

  // 版本绑定不得为空（不允许"漂移"到未绑定的版本）
  for (const field of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
    if (!report[field]) {
      issues.push({ path: field, message: `${field} 缺失，结果不接受` });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateExecutorRegistration(input: unknown): ValidationOutcome {
  const parsed = ExecutorRegistrationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  return { ok: true, issues: [] };
}

export function validateIntegrationBatch(input: unknown): ValidationOutcome {
  const parsed = IntegrationBatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  return { ok: true, issues: [] };
}

export function validateEventEnvelope(input: unknown): ValidationOutcome {
  const parsed = EventEnvelopeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesFromZod(parsed.error) };
  return { ok: true, issues: [] };
}

/** 协议元数据自检：冻结信息必须完整。 */
export function validateProtocolMeta(): ValidationOutcome {
  const issues: ValidationIssue[] = [];
  if (PROTOCOL_META.version !== PROTOCOL_VERSION) {
    issues.push({ path: "PROTOCOL_META.version", message: "协议元数据版本与常量不一致" });
  }
  if (PROTOCOL_META.status === "frozen") {
    if (!PROTOCOL_META.frozenAt) {
      issues.push({
        path: "PROTOCOL_META.frozenAt",
        message: "已冻结状态必须记录冻结提交号",
      });
    } else if (!/^[0-9a-f]{40}$/.test(PROTOCOL_META.frozenAt)) {
      issues.push({
        path: "PROTOCOL_META.frozenAt",
        message: "冻结提交号必须是完整的 40 位 SHA",
      });
    }
    if (!PROTOCOL_META.frozenTreeSha) {
      issues.push({
        path: "PROTOCOL_META.frozenTreeSha",
        message: "已冻结状态必须记录树哈希，否则无法核对协议未被悄悄改动",
      });
    } else if (!/^[0-9a-f]{40}$/.test(PROTOCOL_META.frozenTreeSha)) {
      issues.push({
        path: "PROTOCOL_META.frozenTreeSha",
        message: "树哈希必须是完整的 40 位 SHA",
      });
    }
  }
  if (PROTOCOL_META.status === "superseded" && PROTOCOL_META.changeProposals.length === 0) {
    issues.push({
      path: "PROTOCOL_META.changeProposals",
      message: "被取代的协议必须记录导致取代的变更提案",
    });
  }
  return { ok: issues.length === 0, issues };
}
