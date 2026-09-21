/**
 * 测试证据采集（第 8 节步骤 5、8；第 11 节 artifact 策略）。
 *
 * 设计依据：
 * - 「agent 说完成或退出码为 0 都不足以判定成功」→ 证据必须来自
 *   **执行器自己跑的测试命令**，不是 agent 的自述。
 * - 第 11 节：较大日志留在 artifacts，云端只保存**引用与摘要**。
 *   因此这里算 SHA-256、抽通过/失败汇总，而不是把整份日志塞进协议。
 */

import { createHash } from "node:crypto";
import { runProcess } from "./process.js";
import type { ProcessRunner, TreeKiller } from "./process.js";
import type { TestEvidence } from "@dac/protocol";

export interface RunEvidenceInput {
  /** 测试命令，**数组形式**（第 8 节：固定程序和参数数组） */
  command: readonly string[];
  cwd: string;
  timeout_ms: number;
  /** 证据标识，形如 EVID-<TASK_ID>-<ATTEMPT_ID>-<序号> */
  evidence_id: string;
  env?: Readonly<Record<string, string>>;
}

/**
 * 从测试输出中抽取通过/失败/跳过数量。
 *
 * 只认识主流测试框架的稳定输出格式，认不出时返回 null，
 * 由调用方决定按「无法判定」处理——**不要猜**，
 * 猜错的汇总数字会让 V06 的「测试必须全绿」变成假通过。
 */
export function parseTestSummary(output: string): TestEvidence["summary"] | null {
  // vitest / jest 风格：Tests  80 passed (80)  或  Tests:  1 failed, 79 passed, 2 skipped
  const patterns: RegExp[] = [
    /Tests\s+(?:(\d+)\s+failed[,\s]*)?(?:(\d+)\s+passed)?[,\s]*(?:(\d+)\s+skipped)?\s*\(/i,
    /Tests:\s*(?:(\d+)\s+failed[,\s]*)?(?:(\d+)\s+passed[,\s]*)?(?:(\d+)\s+skipped)?/i,
    /(\d+)\s+passed[,\s]+(\d+)\s+failed/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (!match) continue;
    const failed = Number(match[1] ?? 0);
    const passed = Number(match[2] ?? 0);
    const skipped = Number(match[3] ?? 0);
    if (passed + failed + skipped === 0) continue;
    return { passed, failed, skipped };
  }
  return null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface EvidenceResult {
  /** 归一化后的协议证据对象 */
  evidence: TestEvidence;
  /** 原始输出，供写入本地 artifact（不进协议） */
  raw_stdout: string;
  raw_stderr: string;
  /** 汇总是否成功解析；false 时 summary 记为 0/0/0 且调用方需警惕 */
  summary_parsed: boolean;
}

/**
 * 运行测试命令并采集证据。
 *
 * 注意 `exit_code !== 0` 时**并不**在这里抛出——失败的测试也是一种证据，
 * 由归一化层决定映射为 `repair_pending` + `TESTS_FAILED`。
 */
export async function collectEvidence(
  input: RunEvidenceInput,
  deps: { runner?: ProcessRunner; killer?: TreeKiller } = {},
): Promise<EvidenceResult> {
  const result = await runProcess(
    {
      executable: input.command[0]!,
      args: input.command.slice(1),
      cwd: input.cwd,
      ...(input.env ? { env: input.env } : {}),
    },
    {
      timeout_ms: input.timeout_ms,
      ...(deps.runner ? { runner: deps.runner } : {}),
      ...(deps.killer ? { killer: deps.killer } : {}),
    },
  );

  const combined = `${result.stdout}\n${result.stderr}`;
  const parsed = parseTestSummary(combined);

  const evidence: TestEvidence = {
    evidence_id: input.evidence_id,
    command: [...input.command],
    exit_code: result.exit_code ?? 1,
    summary: parsed ?? { passed: 0, failed: 0, skipped: 0 },
    log_artifact: null,
    output_sha256: sha256(combined),
  };

  return {
    evidence,
    raw_stdout: result.stdout,
    raw_stderr: result.stderr,
    summary_parsed: parsed !== null,
  };
}
