/**
 * 成功上报的**脱敏收据**（P1，B18 实施）。
 *
 * ## 为什么需要它
 * 失败时日志里有 `HTTP <code>`，**成功时一个状态码也不留**：
 * 状态码在传输层是局部变量（`transport/http.ts`）、`ReportAck` 不带它
 * （`transport/adapters.ts`）、常驻入口连 `accepted` 都整体丢弃
 * （`daemon.ts` 两处上报）。于是「这次上报服务端到底回了什么」在 B 机
 * 无据可查 —— 这正是 A 在裁定 2(b) 认定的可观测性缺口。
 *
 * ## 边界（A 指定，逐条落实）
 * - 只做**脱敏、最小化**记录；
 * - 字段白名单见 {@link RECEIPT_ALLOWED_KEYS}，**仅含**：实际 HTTP 状态、
 *   `accepted`、task/attempt、测试计数、证据哈希、提交 SHA；
 * - **明确不含**：token、原始测试输出（stdout/stderr/TAP 文本）、Agent 会话；
 * - 不新增端点、不改协议、不改协调器、不改数据库；
 * - 不进上报体、不上传。
 *
 * ## 为什么用「显式取字段」而不是「展开上报体再删敏感项」
 * 后者的安全性取决于「删干净了没有」，只要漏一个字段就是泄漏。本模块
 * 只从明确的来源里**挑选**白名单字段，结构上不可能带出别的键。
 * {@link sanitizeReportReceipt} 再做一次逐字段校验作为纵深防御。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ErrorCode, ResultReport, ResultStatus } from "@dac/protocol";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export interface ReportReceiptHttp {
  /** 服务端成功应答的 **HTTP 状态码**；无法判定时为 null */
  status: number | null;
  /** 本次上报实际发生的请求次数（含重试）；无法判定时为 null */
  attempts: number | null;
}

export interface ReportReceiptAck {
  accepted: boolean;
  /** 服务端状态字；不在有界字符集内时为 null（见 `boundedToken`） */
  state: string | null;
}

export interface ReportReceiptTests {
  passed: number;
  failed: number;
  skipped: number;
  /** 汇总是否由**真实输出**解析而来（不是「按缺失补 0」） */
  summary_parsed: boolean;
}

export interface ReportReceiptEvidence {
  evidence_id: string | null;
  /** 64 位小写十六进制 SHA-256；**纯摘要**，不是输出内容 */
  output_sha256: string | null;
}

/**
 * 收据本体。字段即白名单，顺序与 §4 方案一致。
 *
 * `schema` 用于将来演进时能分辨形状；读取方见到不认识的值应拒绝解析
 * （fail-closed），而不是按当前字段集硬套。
 */
export interface ReportReceipt {
  schema: "executor-report-receipt/1";
  recorded_at: string;
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  http: ReportReceiptHttp;
  /**
   * 服务端应答。**失败路径一律为 `null`** —— 绝不用它伪造 `accepted: true`，
   * 否则收据会把一次失败的上报说成成功。
   */
  ack: ReportReceiptAck | null;
  result_status: ResultStatus;
  error_code: ErrorCode | null;
  pushed: boolean;
  /** 仅当**确实推送并核对成功**时非 null（区分「没推」与「推了」） */
  commit_sha: string | null;
  remote_sha: string | null;
  tests: ReportReceiptTests | null;
  evidence: ReportReceiptEvidence | null;
}

/**
 * 收据的**允许键集合**（按层级）。
 *
 * 导出是为了让白名单测试有唯一权威来源：测试遍历实际写入的收据，
 * 断言每个键都在这里。新增字段必须先改这里，等于强制过一次评审。
 */
export const RECEIPT_ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  "": [
    "schema",
    "recorded_at",
    "task_id",
    "attempt_id",
    "lease_epoch",
    "http",
    "ack",
    "result_status",
    "error_code",
    "pushed",
    "commit_sha",
    "remote_sha",
    "tests",
    "evidence",
  ],
  http: ["status", "attempts"],
  ack: ["accepted", "state"],
  tests: ["passed", "failed", "skipped", "summary_parsed"],
  evidence: ["evidence_id", "output_sha256"],
};

/** 收据文件名里的键；与 {@link RECEIPT_ALLOWED_KEYS} 的顶层同源。 */
export const RECEIPT_SCHEMA = "executor-report-receipt/1" as const;

/* ------------------------------------------------------------------ *
 * 有界取值（内容级护栏）
 * ------------------------------------------------------------------ */

/**
 * 只接受**有界短标识**：字母数字与 `_.:-`，长度上限 64。
 *
 * 用途是给服务端返回的 `state`、以及任何可能来自自由字符串的字段兜底。
 * 之所以不在这里做「字符替换」而是直接判 null：替换会造出一个看起来
 * 正常、实则被改写过的值，那比「没有值」更容易误导排查。
 */
function boundedToken(value: unknown, max = 64): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(value) ? value : null;
}

/** 提交号形态（7..64 位十六进制）；不符即 null。 */
function shaLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-fA-F]{7,64}$/.test(value) ? value.toLowerCase() : null;
}

/** SHA-256 形态（**恰好** 64 位小写十六进制）；不符即 null。 */
function sha256Hex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** 非负整数；不符即 null。 */
function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** 有界标识（如 evidence_id）：1..128，且不含控制字符。 */
function boundedId(value: unknown, max = 128): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  // eslint-disable-next-line no-control-regex
  return /^[^\u0000-\u001f\u007f]+$/.test(value) ? value : null;
}

/** ISO 时间串；不符则回落到当前时间。 */
function isoOrNow(value: unknown): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * 构造
 * ------------------------------------------------------------------ */

export interface ReportReceiptInput {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  /** 成功路径的 HTTP 状态码；失败路径为 null */
  http_status: number | null;
  /** 本次上报的请求次数（含重试）；不可得为 null */
  http_attempts: number | null;
  /** 服务端应答；失败路径**必须**传 null */
  ack: { accepted?: boolean; state?: string } | null;
  /** 上报体（只读其白名单字段） */
  report: Pick<ResultReport, "status" | "error_code" | "evidence" | "evidence_id">;
  pushed: boolean;
  commit_sha: string | null;
  remote_sha: string | null;
  recorded_at?: string;
}

/**
 * 从**显式挑选**的来源构造一张合规收据。
 *
 * 注意 `tests.summary_parsed` 的推导：`collectEvidence` 在解析失败时写
 * `summary = 0/0/0`，而解析成功必然 `passed+failed+skipped > 0`
 * （TAP 要求 `tests >= 1`；vitest 行要求至少命中一段）。因此
 * 「三项之和 > 0」与「确实解析到了汇总」等价，无需再把 `summary_parsed`
 * 从证据层一路透传上来。
 */
export function buildReportReceipt(input: ReportReceiptInput): ReportReceipt {
  const evidence = input.report.evidence;
  const summary = evidence?.summary ?? null;
  const tests: ReportReceiptTests | null = summary
    ? {
        passed: nonNegativeInt(summary.passed) ?? 0,
        failed: nonNegativeInt(summary.failed) ?? 0,
        skipped: nonNegativeInt(summary.skipped) ?? 0,
        summary_parsed: summary.passed + summary.failed + summary.skipped > 0,
      }
    : null;

  const evidenceId = boundedId(input.report.evidence_id ?? evidence?.evidence_id ?? null);

  return sanitizeReportReceipt({
    schema: RECEIPT_SCHEMA,
    recorded_at: isoOrNow(input.recorded_at),
    task_id: input.task_id,
    attempt_id: input.attempt_id,
    lease_epoch: input.lease_epoch,
    http: { status: input.http_status, attempts: input.http_attempts },
    ack:
      input.ack === null
        ? null
        : {
            accepted: input.ack.accepted === true,
            state: input.ack.state ?? null,
          },
    result_status: input.report.status,
    error_code: input.report.error_code,
    pushed: input.pushed,
    commit_sha: input.pushed ? input.commit_sha : null,
    remote_sha: input.pushed ? input.remote_sha : null,
    tests,
    evidence:
      evidence === null && evidenceId === null
        ? null
        : {
            evidence_id: evidenceId,
            output_sha256: sha256Hex(evidence?.output_sha256 ?? null),
          },
  });
}

/* ------------------------------------------------------------------ *
 * 纵深防御：逐字段校验
 * ------------------------------------------------------------------ */

/**
 * 按白名单逐字段重校验一遍。
 *
 * `buildReportReceipt` 已经只挑白名单字段，这里再拦一次是为了覆盖
 * 「调用方手工拼一个形状不对的对象交给写入函数」的情况——**写盘之前**
 * 必须过这一关，坏值一律降级为 null 而不是原样落盘。
 */
export function sanitizeReportReceipt(receipt: ReportReceipt): ReportReceipt {
  const ack = receipt.ack;
  // 纵深防御（A 于 B19 顺手项 §七.1 指出）：`buildReportReceipt` 与 daemon 传参
  // 已保证「未推送时 `commit_sha` / `remote_sha` 为 null」，但写盘层不能只依赖上游。
  // 这里再判一次：`pushed` 非 `true` 时，**无论调用方传了什么**，两个 SHA 一律降级
  // 为 null —— 否则一张「没推」的收据可能带着提交号，读起来像「推了」。
  const pushed = receipt.pushed === true;
  return {
    schema: RECEIPT_SCHEMA,
    recorded_at: isoOrNow(receipt.recorded_at),
    task_id: String(receipt.task_id),
    attempt_id: String(receipt.attempt_id),
    lease_epoch: nonNegativeInt(receipt.lease_epoch) ?? 0,
    http: {
      status: nonNegativeInt(receipt.http?.status ?? null),
      attempts: nonNegativeInt(receipt.http?.attempts ?? null),
    },
    ack: ack === null ? null : { accepted: ack.accepted === true, state: boundedToken(ack.state) },
    result_status: receipt.result_status,
    error_code: receipt.error_code === null ? null : (boundedToken(receipt.error_code, 48) as ErrorCode | null),
    pushed,
    commit_sha: pushed ? shaLike(receipt.commit_sha) : null,
    remote_sha: pushed ? shaLike(receipt.remote_sha) : null,
    tests:
      receipt.tests === null
        ? null
        : {
            passed: nonNegativeInt(receipt.tests.passed) ?? 0,
            failed: nonNegativeInt(receipt.tests.failed) ?? 0,
            skipped: nonNegativeInt(receipt.tests.skipped) ?? 0,
            summary_parsed: receipt.tests.summary_parsed === true,
          },
    evidence:
      receipt.evidence === null
        ? null
        : {
            evidence_id: boundedId(receipt.evidence.evidence_id),
            output_sha256: sha256Hex(receipt.evidence.output_sha256),
          },
  };
}

/* ------------------------------------------------------------------ *
 * 路径与读写
 * ------------------------------------------------------------------ */

/**
 * 收据目录。
 *
 * 刻意与 `.local/executor-attempts/`（**恢复状态机**，单写者、状态推进）
 * 分开放：收据是**追加式事实**，混进一个文件里会诱使后续改动去动恢复语义，
 * 而 A 已裁定恢复标记语义不动。
 */
export function receiptsDir(repoRoot: string): string {
  return join(repoRoot, ".local", "executor-receipts");
}

/** 单个 attempt 的收据路径（attempt_id 可逆编码，避免路径注入）。 */
export function reportReceiptPath(repoRoot: string, attemptId: string): string {
  return join(receiptsDir(repoRoot), `${encodeURIComponent(attemptId)}.json`);
}

/**
 * 写一张收据。**一 attempt 一文件**；同 attempt 重复上报可覆盖（幂等重报），
 * **绝不跨 attempt 覆盖**。
 *
 * 写盘失败会**抛出**：调用方（常驻入口）负责降级为一行日志并继续 ——
 * 收据是观测手段，不得改变上报结论。
 */
export function writeReportReceipt(repoRoot: string, receipt: ReportReceipt): string {
  const path = reportReceiptPath(repoRoot, receipt.attempt_id);
  const clean = sanitizeReportReceipt(receipt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  return path;
}

/** 读取一张收据；文件不存在或形状不认识时返回 null（fail-closed）。 */
export function readReportReceipt(repoRoot: string, attemptId: string): ReportReceipt | null {
  const path = reportReceiptPath(repoRoot, attemptId);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<ReportReceipt>;
    if (candidate.schema !== RECEIPT_SCHEMA) return null;
    if (typeof candidate.task_id !== "string" || typeof candidate.attempt_id !== "string") return null;
    return candidate as ReportReceipt;
  } catch {
    return null;
  }
}

/**
 * 显式清理**单个** attempt 的收据。
 *
 * **不是常驻入口的自动路径**（与 `clearInFlightRecord` 同规格）：
 * 收据保留至 A 在 V01–V14 之后明确授权清理。常驻入口在任何情况下都不调用它。
 */
export function clearReportReceipt(
  repoRoot: string,
  attemptId: string,
): { removed: boolean; path: string } {
  const path = reportReceiptPath(repoRoot, attemptId);
  if (!existsSync(path)) return { removed: false, path };
  rmSync(path, { force: true });
  return { removed: true, path };
}
