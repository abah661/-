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
import type { ControlledProcessState } from "./proc-tree.js";
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
 * 目前认识两类格式：
 * 1. vitest / jest 的 `Tests` 行（见 `parseTestsLineSummary`）
 * 2. TAP 汇总块（`node --test` 的默认输出，见 `parseTapSummary`）
 *
 * B13（A 端 P3 首轮真实运行裁定）：此前只认第 1 类，而 P3 目标仓库用的是
 * Node 内置测试运行器（TAP），于是真实全绿的一次运行被解析成 `passed: 0`，
 * 上报被协调器以 `RESULT_SCHEMA_INVALID` 正确拒绝。**不能靠退出码 0
 * 或普通文本反推「测试通过」**，只能扩展解析器认识真实格式。
 *
 * B16（A 端 B15 复核）：B13 的 fail-closed 不完整 —— 只强制 `tests/pass/fail`，
 * 缺字段按 0 补、不校验版本头与终止标记，于是**不完整/被截断**的 TAP 片段
 * 也能报出通过数。现收紧为「只认结构完整的 TAP v13 输出」，详见 `parseTapSummary`。
 */
export function parseTestSummary(output: string): TestEvidence["summary"] | null {
  // 先试 vitest/jest（顺序保持原样，避免改变既有行为），再试 TAP。
  return parseTestsLineSummary(output) ?? parseTapSummary(output);
}

/**
 * vitest / jest 的 `Tests` 行。
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
function parseTestsLineSummary(output: string): TestEvidence["summary"] | null {
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

/**
 * Node 22 内置运行器 TAP 输出的**版本头**。
 *
 * 实测（Node v22.22.2，`node --test` 默认 reporter）：完整跑完的输出里
 * 这一行恰好出现一次、不缩进。但它只能证明「这是 TAP 输出」，**不能**证明
 * 输出完整 —— 完整性由「全部汇总字段 + 终止标记」共同证明。
 *
 * 为什么**不**要求它是「第一行非空内容」：真实执行路径上，测试命令是
 * 直接以数组形式拉起 `node --test` 的（stdout 第一行就是它），但也存在
 * 经 `npm test` 之类包装后再采集的可能 —— 那时 stdout 前面会有 npm 的
 * `> pkg@x test` 两行横幅。把版本头钉死在第一行会让这种**真实且完整**的
 * 输出被判成「无法判定」，正好是本模块要避免的假阴性。所以这里只要求：
 * 版本头**恰好一处**，且出现在汇总块**之前**。
 */
const TAP_VERSION_PATTERN = /^TAP version 13[ \t]*$/;

/**
 * TAP 汇总块的**计数字段**。`suites` 只统计套件数，不参与用例数自洽校验，
 * 但它是真实输出的固定组成部分，B16 起同样**必须存在**。
 *
 * 真实采集于 Node v22.22.2、`node --test`（默认 reporter 就是 TAP），
 * 原始样本见 `tests/executor/windows-integration.test.ts` 的 `REAL_TAP_*` 常量
 * 与 `docs/reports/B13-*.md`：
 * ```text
 * TAP version 13
 * # Subtest: alpha
 * ok 1 - alpha
 * ...
 * 1..2
 * # tests 2
 * # suites 0
 * # pass 2
 * # fail 0
 * # cancelled 0
 * # skipped 0
 * # todo 0
 * # duration_ms 288.5386      ← 终止标记（最后一行）
 * ```
 *
 * 已实测确认（**不要凭记忆改**）：
 * - 汇总块在整份输出里**只有一处**，且**不缩进**；即使跑多个测试文件或
 *   含嵌套 describe 子测试，也只输出一个聚合汇总。
 * - `duration_ms` 的 YAML 形式（`  duration_ms: 1.0889`，缩进 + 冒号）
 *   与被解析的汇总行（`# duration_ms 1.0889`）形态不同，不会互相污染。
 */
const TAP_COUNT_FIELDS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/** 汇总块的终止标记字段名。 */
const TAP_TERMINATOR_FIELD = "duration_ms";

/** 某个 TAP 汇总字段的一次出现（取值 + 所在行号）。 */
interface TapFieldOccurrence {
  value: number;
  lineIndex: number;
}

/**
 * 收集某个 TAP 汇总字段在输出里出现的全部位置（按出现顺序）。
 *
 * 行首可有空白，但整行只允许 `# <字段> <数字>`，避免把正文里的
 * `# pass` 之类偶然文本也算进来。数字允许小数是给 `duration_ms` 用的；
 * 计数字段另做整数校验（`# tests 2.5` 属畸形，判不了）。
 */
function collectTapFieldOccurrences(lines: readonly string[], field: string): TapFieldOccurrence[] {
  const pattern = new RegExp(`^[ \\t]*#\\s*${field}\\s+(\\d+(?:\\.\\d+)?)[ \\t]*$`);
  const occurrences: TapFieldOccurrence[] = [];
  lines.forEach((line, lineIndex) => {
    const match = pattern.exec(line);
    if (match) occurrences.push({ value: Number(match[1]), lineIndex });
  });
  return occurrences;
}

/** 找出所有版本头行的行号（用于校验「恰好一处」且「在汇总之前」）。 */
function findTapVersionLines(lines: readonly string[]): number[] {
  const hits: number[] = [];
  lines.forEach((line, lineIndex) => {
    if (TAP_VERSION_PATTERN.test(line)) hits.push(lineIndex);
  });
  return hits;
}

/**
 * TAP 汇总块解析（B13；B16 收紧为「只认完整输出」）。
 *
 * B16 背景（A 端 B15 复核）：B13 只强制要求 `tests/pass/fail` 三项，缺
 * `suites/cancelled/skipped/todo` 时按 0 补，也不要求版本头与终止标记。
 * 于是下面两份**不完整**的输入都会报出通过数：
 * ```text
 * parseTestSummary("# tests 1\n# pass 1\n# fail 0")
 *   → { passed: 1, failed: 0, skipped: 0 }
 * parseTestSummary("TAP version 13\n# tests 2\n# pass 2\n# fail 0")
 *   → { passed: 2, failed: 0, skipped: 0 }
 * ```
 * 前者连「像 TAP」都不成立；后者看着像，但真跑完的 Node 输出不可能只有
 * 三行汇总。**按缺失字段补 0 就等于替真实运行「补结论」**，这是本模块
 * 最不能出的错，故 B16 改为：只有识别到**结构完整**的 TAP v13 输出才返回摘要。
 *
 * fail closed 原则：下面任何一种情况都返回 `null`（由调用方按「无法判定」处理），
 * 而不是猜一个看起来合理的数字：
 * - **缺版本头** `TAP version 13`（整行、不缩进）：不是 Node TAP 输出；
 *   版本头出现**不止一次**也拒绝（两次输出被拼在一起）；
 * - `tests/suites/pass/fail/cancelled/skipped/todo` 或终止标记 `duration_ms`
 *   有**任何一个缺失**；
 * - 汇总块出现在版本头**之前**（顺序不对 = 输出被拼接/改写）；
 * - 任一汇总字段出现**不止一次**（真实输出只有一个汇总块；重复说明输出被
 *   拼接或污染，此时「取其中一个」没有依据。**数值一致也一律拒绝**）；
 * - 计数字段不是整数；
 * - `duration_ms` **不是汇总块的最后一个字段**（其后又冒出计数行 = 汇总块之后
 *   还有第二次汇总，终止标记不算终止）；
 * - `# tests` 为 0（没有任何用例 = 没有测试结果）；
 * - 汇总不自洽：`pass + fail + cancelled + skipped + todo !== tests`
 *   （唯一实测反例是 `pass 0 / fail 0 / cancelled 1 / tests 1`，
 *   即用例被取消 —— 不把 `cancelled` 计入就会与实测对不上）。
 *
 * `cancelled` 计入 `failed`：被取消的用例既不是通过也不是失败，但绝不能
 * 让它落进「passed>0 且 failed=0」的假绿组合里。这样 `summary` 也**不会**
 * 退化成与「解析失败」默认值 `0/0/0` 完全相同的形状，便于事后区分。
 */
function parseTapSummary(output: string): TestEvidence["summary"] | null {
  const lines = output.split(/\r?\n/);

  // ① 版本头：整份输出里**恰好一处**（见 TAP_VERSION_PATTERN 的说明）
  const versionLines = findTapVersionLines(lines);
  if (versionLines.length !== 1) return null;
  const versionLineIndex = versionLines[0]!;

  // ② 每个字段必须**恰好出现一次**：缺失、重复（含数值一致的重复）都判不了；
  //    且汇总块必须在版本头**之后**
  const counts = new Map<string, TapFieldOccurrence>();
  let terminator: TapFieldOccurrence | null = null;
  for (const field of [...TAP_COUNT_FIELDS, TAP_TERMINATOR_FIELD]) {
    const occurrences = collectTapFieldOccurrences(lines, field);
    if (occurrences.length !== 1) return null;
    const only = occurrences[0]!;
    if (only.lineIndex < versionLineIndex) return null;
    if (field === TAP_TERMINATOR_FIELD) {
      terminator = only;
    } else {
      if (!Number.isInteger(only.value)) return null;
      counts.set(field, only);
    }
  }

  // ③ 终止标记必须是汇总块的**最后一行**：其后不得再出现任何计数字段
  const terminatorLine = terminator!.lineIndex;
  for (const occurrence of counts.values()) {
    if (occurrence.lineIndex > terminatorLine) return null;
  }

  const tests = counts.get("tests")!.value;
  const pass = counts.get("pass")!.value;
  const fail = counts.get("fail")!.value;
  const cancelled = counts.get("cancelled")!.value;
  const skipped = counts.get("skipped")!.value;
  const todo = counts.get("todo")!.value;

  // 没有任何用例：不能算作「测试通过」
  if (tests < 1) return null;
  if (pass + fail + cancelled + skipped + todo !== tests) return null;

  return { passed: pass, failed: fail + cancelled, skipped };
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
  /**
   * 进程终止过程的异常说明（B7）。正常为 `null`。
   *
   * 覆盖 killer 调用失败/超时、强杀后进程仍未退出、stdio 未在窗口内关闭。
   * 之所以要一路带出来：`exit_code` 为 null 时上层只看到「测试没通过」，
   * 却看不出是**进程根本杀不掉**（需要人工介入），还是测试真的失败了。
   */
  termination_detail: string | null;
  /**
   * 是否**未能终止**测试进程（连强杀都不生效，B8）。
   *
   * 与 `termination_detail` 的区别：后者是给人看的说明，本字段是给
   * 常驻入口做**停机判定**用的信号——为 true 时可能有残留进程仍在占用
   * worktree 与文件锁，继续领取新任务只会制造更多冲突（A 端 B7-1）。
   */
  kill_failed: boolean;
  /**
   * 测试进程的**进程状态**（B12，A 端 B11 复验 P2）。
   *
   * 为什么要和 `kill_failed` 并存：`kill_failed` 只说明「没等到退出」，
   * 而「没等到退出」不等于「进程还活着」。原实现直接把它当成「已确认残留」
   * （`residual`），把「不知道」说成了「确认活着」。
   *
   * 现在由存活探测回答：**确认仍存活**才是 `residual`，探不到或只缺关闭
   * 证据一律 `unknown`。两者都要停机，但日志与持久化状态必须分别如实表达。
   */
  process_state: ControlledProcessState;
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
    termination_detail: result.kill_detail,
    kill_failed: result.kill_failed,
    process_state: result.process_state,
  };
}
