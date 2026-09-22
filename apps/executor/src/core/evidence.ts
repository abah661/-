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
 *
 * 真实输出样本（vitest 3.x，由 tests/executor/windows-integration.test.ts
 * 用真实运行采集，**不要凭记忆改这些正则**）：
 * - 全绿：  `      Tests  16 passed (16)`
 * - 有失败：`      Tests  1 failed | 1 passed (2)`      ← 分隔符是**竖线**
 * - 有跳过：`      Tests  1 failed | 13 passed | 2 skipped (16)`
 * - jest：  `Tests:       1 failed, 79 passed, 2 skipped, 80 total`
 *
 * 注意竖线格式曾漏掉，导致**真实失败**的运行被判为「无法判定」——
 * 这正是最不能出错的分支，故此处按分段解析而非单条大正则。
 */
export function parseTestSummary(output: string): TestEvidence["summary"] | null {
  /**
   * 在「Tests」行内逐段统计。
   *
   * 之所以不用单条可选组的大正则：vitest 用 `|` 分隔，
   * 各段顺序不固定（失败段可缺省），可选组无法可靠区分
   * `1 failed | 15 passed` 与 `15 passed | 1 failed`。
   */
  const testsLine = /^[ \t]*Tests[: ]\s*(.+)$/im.exec(output);
  if (!testsLine) return null;

  const body = testsLine[1]!;
  const pick = (keyword: string): number => {
    // 段间可能是 | 或 , 或空白；数字与关键词之间也可能有空格
    const m = new RegExp(`(\\d+)\\s*${keyword}`, "i").exec(body);
    return m ? Number(m[1]) : 0;
  };

  const passed = pick("passed");
  const failed = pick("failed");
  const skipped = pick("skipped");
  const todo = pick("todo");

  // 一段都没认出 = 格式不认识，交回调用方按「无法判定」处理
  if (passed + failed + skipped + todo === 0) return null;
  return { passed, failed, skipped };
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
