/**
 * 受控审计记录（P2，B18 实施）。
 *
 * ## 它解决什么、不解决什么
 * 裁决 2(c) 认定的「在途记录不承载阶段轨迹」——`completed_phases` 恒为 `[]`，
 * 而真正的阶段轨迹只在 `AttemptTrace.phases` 里**纯内存**存在，进程一退就没了。
 *
 * **本模块不去填 `completed_phases`。** 那个字段的语义是**恢复断点**
 * （读者只有 `decideRecovery`），而本机不具备断点续跑能力，所以它从来
 * 不需要被填。审计记录是另一件东西：**可追加的过程事实**。
 * 两者的语义必须保持分开——混用会让后续改动以为「填了审计记录就等于
 * 支持续跑」。
 *
 * ## 三类硬约束（方案 §4）
 * 1. **文件级**：一个 attempt 只写自己的 `<attempt_id>.jsonl`，绝不跨 attempt 写。
 * 2. **操作级**：只有 `append`。模块内除了显式 {@link clearAuditJournal}
 *    （常驻入口从不调用）之外，**不存在**任何重写/截断/删除路径。
 * 3. **内容级**：`detail` 一律禁止自由文本。`setPhase(phase, detail)` 的
 *    `detail` 在编排层是自由字符串，原样落盘就会变成**测试输出/Agent 输出
 *    的泄漏通道**——与「不落盘原始测试输出」的红线直接冲突。因此这里做
 *    白名单校验，校验不过就写 `null` 并记一行降级日志，**绝不截断后照写**。
 *
 * 读取方遇到不可解析的行必须**丢弃并明示**，不得猜值（fail-closed，
 * 与 B16 的 TAP 解析器同一纪律）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ResultStatus } from "@dac/protocol";

import type { ExecutorPhase } from "./heartbeat.js";
import type { InFlightState } from "./recovery.js";

/* ------------------------------------------------------------------ *
 * 事件（**封闭集合**，新增须改提案）
 * ------------------------------------------------------------------ */

export type AuditEventKind = "phase" | "commit" | "report" | "terminal";

/** `phase` 事件的八值枚举（与 `heartbeat.ts` 的 `ExecutorPhase` 同源）。 */
export const AUDIT_PHASES: readonly ExecutorPhase[] = [
  "preparing_worktree",
  "loading_context",
  "running_agent",
  "checking_diff",
  "running_tests",
  "committing",
  "pushing",
  "reporting",
];

/** `terminal` 事件的合法终态集合（与 `recovery.ts` 的 `InFlightState` 同源）。 */
export const AUDIT_TERMINAL_STATES: readonly InFlightState[] = [
  "in_flight",
  "reported",
  "skipped_aborted",
  "skipped_lease_lost",
  "failed_to_report",
  "failed_orchestration",
  "refused_binding_incomplete",
  "abandoned_expired",
  "abandoned_reassigned",
  "abandoned_unknown",
  "halted_still_mine",
  "halted_residual_process",
  "halted_process_unknown",
];

/** 事件体。字段刻意扁平，与方案 §3 的样例一致。 */
export type AuditEventBody =
  | {
      event: "phase";
      phase: ExecutorPhase;
      /**
       * 阶段结果的**有界短标识**（如 `exit_0` / `diff_ok`）。
       * 自由文本一律被拒 → 落盘为 `null`。**绝不是** `setPhase` 的原始 detail。
       */
      outcome?: string | null;
    }
  | { event: "commit"; sha: string }
  | {
      event: "report";
      http_status: number | null;
      accepted: boolean | null;
      result_status: ResultStatus;
    }
  | { event: "terminal"; state: InFlightState };

/** 记录标识三元组。 */
export interface AuditBase {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
}

/** 落盘的一行。 */
export interface AuditRecord extends AuditBase {
  schema: "executor-audit/1";
  seq: number;
  at: string;
  event: AuditEventKind;
  /** 事件附带字段（按 `event` 取子集）。 */
  phase?: ExecutorPhase;
  outcome?: string | null;
  sha?: string;
  http_status?: number | null;
  accepted?: boolean | null;
  result_status?: ResultStatus | null;
  state?: InFlightState;
}

export const AUDIT_SCHEMA = "executor-audit/1" as const;

/* ------------------------------------------------------------------ *
 * 内容级护栏
 * ------------------------------------------------------------------ */

/**
 * 有界短标识：**小写字母、数字、下划线**，长度上限 32。
 *
 * 刻意比收据侧更严（只允许小写 snake_case）：审计的 `outcome` 是**枚举式**
 * 结论（`exit_0` / `diff_ok` / `scope_denied`），没有任何理由需要大写、
 * 连字符或冒号 —— 而放宽这些字符集恰好会给「短凭据/短标识」留出通道。
 * 判不准就落 null，不截断、不改写。
 */
function boundedOutcome(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 32) return null;
  return /^[a-z0-9_]+$/.test(value) ? value : null;
}

function shaLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-fA-F]{7,64}$/.test(value) ? value.toLowerCase() : null;
}

function nonNegativeIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

/** 审计目录（`.local/` 已 gitignore，不进仓库）。 */
export function auditDir(repoRoot: string): string {
  return join(repoRoot, ".local", "executor-audit");
}

/** 单个 attempt 的 JSONL 路径。 */
export function auditJournalPath(repoRoot: string, attemptId: string): string {
  return join(auditDir(repoRoot), `${encodeURIComponent(attemptId)}.jsonl`);
}

/* ------------------------------------------------------------------ *
 * 读取（fail-closed）
 * ------------------------------------------------------------------ */

export interface AuditReadResult {
  records: AuditRecord[];
  /** 尾行不可解析（进程被杀导致截断）；读取方**不得**为它补值 */
  tail_parse_error: boolean;
  /** 非尾行损坏、或文件读取失败；非 null 表示记录不可信 */
  error: string | null;
}

/** 单行是否为可识别的审计记录。 */
function parseAuditLine(line: string): AuditRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Partial<AuditRecord>;
  if (record.schema !== AUDIT_SCHEMA) return null;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq)) return null;
  if (typeof record.task_id !== "string" || typeof record.attempt_id !== "string") return null;
  if (typeof record.at !== "string") return null;
  if (
    record.event !== "phase" &&
    record.event !== "commit" &&
    record.event !== "report" &&
    record.event !== "terminal"
  ) {
    return null;
  }
  return record as AuditRecord;
}

/**
 * 读一个 attempt 的审计日志。
 *
 * 语义（fail-closed）：**尾行不可解析**单独用 `tail_parse_error` 表达
 * （崩溃截断是预期内的），其余任何不可解析的行都算 `error` ——
 * 中间出现坏行说明文件被改动过，此时的记录不可信，读取方必须拒绝
 * 而不是「跳过坏行继续」。
 */
export function readAuditJournal(repoRoot: string, attemptId: string): AuditReadResult {
  const path = auditJournalPath(repoRoot, attemptId);
  if (!existsSync(path)) return { records: [], tail_parse_error: false, error: null };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      records: [],
      tail_parse_error: false,
      error: `无法读取审计日志：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const lines = raw.split(/\r?\n/);
  // 末尾换行会切出一个空串；它不是一行内容。
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  const records: AuditRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "") continue;
    const record = parseAuditLine(line);
    if (record === null) {
      if (index === lines.length - 1) {
        return { records, tail_parse_error: true, error: null };
      }
      return {
        records,
        tail_parse_error: false,
        error: `第 ${index + 1} 行不可解析（不是尾行）——审计日志被改动过，拒绝采信`,
      };
    }
    records.push(record);
  }
  return { records, tail_parse_error: false, error: null };
}

/* ------------------------------------------------------------------ *
 * 写入（只追加）
 * ------------------------------------------------------------------ */

export interface AuditJournal {
  /** 该 attempt 的日志文件路径 */
  readonly path: string;
  /** 追加一个事件。**永不抛出**：写不进去只走降级日志。 */
  append(event: AuditEventBody): void;
}

export interface AuditJournalOptions {
  now?: () => number;
  /** 降级日志出口；默认丢弃 */
  on_error?: (message: string) => void;
}

/**
 * 打开（或续写）一个 attempt 的审计日志。
 *
 * `seq` 从**已存在且可解析**的行数续号，这样进程重启后继续追加不会
 * 出现重复序号；被截断的尾行不计入（它本来就要被丢弃）。
 */
export function openAuditJournal(
  repoRoot: string,
  base: AuditBase,
  options: AuditJournalOptions = {},
): AuditJournal {
  const path = auditJournalPath(repoRoot, base.attempt_id);
  const now = options.now ?? Date.now;
  const onError = options.on_error ?? ((): void => {});

  const existing = readAuditJournal(repoRoot, base.attempt_id);
  let seq = existing.records.length + 1;

  return {
    path,
    append(event: AuditEventBody): void {
      const at = new Date(now()).toISOString();
      const record = buildRecord(base, seq, at, event, onError);
      // 事件体不合法（枚举越界 / 哈希形态不对）→ 不写，避免把无法解释的
      // 行塞进事实日志。
      if (record === null) {
        onError(`[audit] 事件未通过白名单校验（event=${event.event}）：丢弃该行`);
        return;
      }
      try {
        mkdirSync(dirname(path), { recursive: true });
        // 只追加：一行一条，绝不重写既有内容。
        appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
        seq += 1;
      } catch (error) {
        onError(
          `[audit] 追加失败（event=${event.event}）：继续，不影响本次结果（${
            error instanceof Error ? error.message : String(error)
          }）`,
        );
      }
    },
  };
}

/**
 * 构造一行记录。返回 null 表示事件体非法 → 调用方丢弃。
 *
 * `outcome` 与 `sha` 走白名单；`outcome` 不合格时降级为 `null`
 * （而不是丢掉整行）——阶段轨迹本身仍然有价值，只是不带结论标记。
 */
function buildRecord(
  base: AuditBase,
  seq: number,
  at: string,
  event: AuditEventBody,
  onError: (message: string) => void,
): AuditRecord | null {
  const common = {
    schema: AUDIT_SCHEMA,
    seq,
    at,
    task_id: base.task_id,
    attempt_id: base.attempt_id,
    lease_epoch: base.lease_epoch,
  };

  switch (event.event) {
    case "phase": {
      if (!AUDIT_PHASES.includes(event.phase)) return null;
      let outcome = boundedOutcome(event.outcome ?? null);
      if (event.outcome != null && outcome === null) {
        onError("[audit] 阶段结论不是有界短标识：按 null 记录（禁止自由文本落盘）");
        outcome = null;
      }
      return { ...common, event: "phase", phase: event.phase, outcome };
    }
    case "commit": {
      const sha = shaLike(event.sha);
      if (sha === null) return null;
      return { ...common, event: "commit", sha };
    }
    case "report": {
      return {
        ...common,
        event: "report",
        http_status: nonNegativeIntOrNull(event.http_status),
        accepted: event.accepted === null ? null : event.accepted === true,
        result_status: event.result_status,
      };
    }
    case "terminal": {
      if (!AUDIT_TERMINAL_STATES.includes(event.state)) return null;
      return { ...common, event: "terminal", state: event.state };
    }
  }
}

/**
 * 显式清理**单个** attempt 的审计日志。
 *
 * 与 `clearReportReceipt` 同规格：**不是常驻入口的自动路径**，
 * 保留至 A 在 V01–V14 之后明确授权清理。模块内没有任何其他删除入口。
 */
export function clearAuditJournal(
  repoRoot: string,
  attemptId: string,
): { removed: boolean; path: string } {
  const path = auditJournalPath(repoRoot, attemptId);
  if (!existsSync(path)) return { removed: false, path };
  rmSync(path, { force: true });
  return { removed: true, path };
}
