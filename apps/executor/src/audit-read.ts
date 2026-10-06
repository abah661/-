/**
 * 审计日志**只读入口**（P2，B18）。
 *
 * ## 定位
 * 读取一律走**本机文件系统**，且**必须点名 `attempt_id`**：
 * - **不新增任何 HTTP 端点**
 * - 不进上报体、不进协议、不上传
 * - **不提供**「整目录批量导出」——批量导出会天然扩大泄漏面
 *
 * 放在 `apps/executor/**` 以守住归属：**不碰** A 的 `tools/validate-protocol/**`。
 *
 * ## 用法
 * ```text
 * tsx apps/executor/src/audit-read.ts --attempt <attempt_id> [--repo <repo_root>]
 * tsx apps/executor/src/audit-read.ts --verify  <attempt_id> [--repo <repo_root>]
 * ```
 * `--repo` 缺省时依次回落 `EXECUTOR_REPO_ROOT` 环境变量、当前工作目录。
 *
 * ## 退出码（fail-closed）
 * - `0`：正常；
 * - `1`：用法错误 / 日志不可信（中间坏行）/ **尾行不可解析** /
 *   `--verify` 发现与收据不一致 / 文件读不到。
 *
 * 任何「读不出确定结论」的情形都走非零码 —— **不猜值**，
 * 与 B16 的 TAP 解析器同一纪律。
 */

import { pathToFileURL } from "node:url";

import { auditJournalPath, readAuditJournal } from "./core/audit.js";
import type { AuditRecord } from "./core/audit.js";
import { readReportReceipt, reportReceiptPath } from "./core/receipts.js";

const USAGE = [
  "用法：",
  "  audit-read.ts --attempt <attempt_id> [--repo <repo_root>]",
  "  audit-read.ts --verify  <attempt_id> [--repo <repo_root>]",
].join("\n");

interface ParsedArgs {
  mode: "attempt" | "verify";
  attempt_id: string;
  repo_root: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let mode: "attempt" | "verify" | null = null;
  let attemptId: string | null = null;
  let repoRoot: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--attempt" || arg === "--verify") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `${arg} 需要 attempt_id` };
      }
      mode = arg === "--attempt" ? "attempt" : "verify";
      attemptId = value;
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) return { error: "--repo 需要路径" };
      repoRoot = value;
      index += 1;
      continue;
    }
    return { error: `无法识别的参数：${arg}` };
  }

  if (mode === null || attemptId === null) return { error: "必须指定 --attempt 或 --verify" };
  return {
    mode,
    attempt_id: attemptId,
    repo_root: repoRoot ?? process.env["EXECUTOR_REPO_ROOT"] ?? process.cwd(),
  };
}

function printRecord(record: AuditRecord): void {
  const extras: string[] = [];
  if (record.phase !== undefined) extras.push(`phase=${record.phase}`);
  if (record.outcome !== undefined) extras.push(`outcome=${record.outcome ?? "null"}`);
  if (record.sha !== undefined) extras.push(`sha=${record.sha}`);
  if (record.http_status !== undefined) extras.push(`http_status=${record.http_status ?? "null"}`);
  if (record.accepted !== undefined) extras.push(`accepted=${record.accepted ?? "null"}`);
  if (record.result_status !== undefined) extras.push(`result_status=${record.result_status ?? "null"}`);
  if (record.state !== undefined) extras.push(`state=${record.state}`);
  process.stdout.write(
    `#${String(record.seq).padStart(3, "0")} ${record.at} ${record.event} ${extras.join(" ")}\n`,
  );
}

/**
 * `--verify`：与 P1 收据交叉核对。
 *
 * 核对三项：`http_status` / `accepted` / `result_status`。任一项对不上即
 * 报错退出非零 —— 这正是「灵敏度自证」：注入不一致必须能被抓到，否则
 * 这个入口等于没有校验能力。
 */
function verify(repoRoot: string, attemptId: string, records: readonly AuditRecord[]): number {
  const reportEvent = [...records].reverse().find((record) => record.event === "report");
  if (reportEvent === undefined) {
    process.stderr.write(`[verify] 审计日志里没有 report 事件：无法核对（${attemptId}）\n`);
    return 1;
  }

  const receipt = readReportReceipt(repoRoot, attemptId);
  if (receipt === null) {
    process.stderr.write(
      `[verify] 找不到收据（${reportReceiptPath(repoRoot, attemptId)}）：无法核对\n`,
    );
    return 1;
  }

  const mismatches: string[] = [];
  const auditStatus = reportEvent.http_status ?? null;
  const receiptStatus = receipt.http.status;
  if (auditStatus !== receiptStatus) {
    mismatches.push(`http_status 审计=${auditStatus ?? "null"} 收据=${receiptStatus ?? "null"}`);
  }
  const auditAccepted = reportEvent.accepted ?? null;
  const receiptAccepted = receipt.ack === null ? null : receipt.ack.accepted;
  if (auditAccepted !== receiptAccepted) {
    mismatches.push(`accepted 审计=${auditAccepted ?? "null"} 收据=${receiptAccepted ?? "null"}`);
  }
  if ((reportEvent.result_status ?? null) !== receipt.result_status) {
    mismatches.push(
      `result_status 审计=${reportEvent.result_status ?? "null"} 收据=${receipt.result_status}`,
    );
  }

  if (mismatches.length > 0) {
    process.stderr.write(`[verify] 审计与收据不一致：\n  ${mismatches.join("\n  ")}\n`);
    return 1;
  }
  process.stdout.write(`[verify] OK：审计 report 事件与收据一致（${attemptId}）\n`);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}\n`);
    return 1;
  }

  const { mode, attempt_id: attemptId, repo_root: repoRoot } = parsed;
  const journal = readAuditJournal(repoRoot, attemptId);

  if (journal.error !== null) {
    process.stderr.write(`[audit] 日志不可信：${journal.error}\n`);
    process.stderr.write(`  路径：${auditJournalPath(repoRoot, attemptId)}\n`);
    return 1;
  }

  journal.records.forEach(printRecord);

  if (journal.tail_parse_error) {
    // 崩溃截断是预期内的：明示「最后一行不可解析」，**不补造**值。
    process.stderr.write(
      `[audit] 最后一行不可解析（进程被杀导致的截断）：已丢弃，未补造。` +
        `共 ${journal.records.length} 条可解析记录\n`,
    );
    return 1;
  }

  if (mode === "verify") return verify(repoRoot, attemptId, journal.records);

  process.stdout.write(`[audit] 共 ${journal.records.length} 条记录（${attemptId}）\n`);
  return 0;
}

/** 直接执行本文件时才跑主流程；被 import 时保持无副作用。 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
