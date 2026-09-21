#!/usr/bin/env node
/**
 * validate-protocol CLI。
 *
 * 用法：
 *   npm run validate:protocol                   校验协议元数据与全部样例（正向必须通过、反向必须拒绝）
 *   npm run validate:protocol -- <file.json>    校验指定文件（按文件名/内容自动识别类型）
 *   npm run validate:protocol -- --samples      仅校验样例夹具
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTaskGraph,
  validateResultReport,
  validateExecutorRegistration,
  validateIntegrationBatch,
  validateEventEnvelope,
  validateProtocolMeta,
  type ValidationOutcome,
} from "./validate.js";
import { PROTOCOL_VERSION } from "@dac/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const SAMPLES_DIR = join(REPO_ROOT, "packages", "protocol", "samples");

type Kind = "graph" | "result" | "registration" | "batch" | "event";

/** 按内容特征推断文档类型，避免依赖文件名约定。 */
function inferKind(doc: Record<string, unknown>): Kind {
  if (Array.isArray(doc["tasks"])) return "graph";
  if (doc["event_type"] !== undefined) return "event";
  if (doc["batch_id"] !== undefined) return "batch";
  if (doc["capabilities"] !== undefined) return "registration";
  if (doc["attempt_id"] !== undefined) return "result";
  throw new Error("无法识别文档类型：缺少可辨识字段");
}

function validateByKind(kind: Kind, doc: unknown): ValidationOutcome {
  switch (kind) {
    case "graph":
      return validateTaskGraph(doc);
    case "result":
      return validateResultReport(doc);
    case "registration":
      return validateExecutorRegistration(doc);
    case "batch":
      return validateIntegrationBatch(doc);
    case "event":
      return validateEventEnvelope(doc);
  }
}

/** 文件名含 .invalid- 的样例期望被拒绝（验收 V03 / V06 / V10 的反向保障）。 */
function expectsRejection(filename: string): boolean {
  return /\.invalid(-|\.)/.test(filename);
}

function report(name: string, outcome: ValidationOutcome, indent = "  "): void {
  if (outcome.ok) {
    console.log(`${indent}PASS  ${name}`);
    return;
  }
  console.log(`${indent}FAIL  ${name}`);
  for (const issue of outcome.issues) {
    console.log(`${indent}      · ${issue.path}: ${issue.message}`);
  }
}

function runSamples(): number {
  let failures = 0;
  const filenames = readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`样例夹具校验（${filenames.length} 个文件，目录 packages/protocol/samples）`);

  for (const filename of filenames) {
    const raw = readFileSync(join(SAMPLES_DIR, filename), "utf8");
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      console.log(`  FAIL  ${filename}  JSON 解析失败：${(error as Error).message}`);
      failures += 1;
      continue;
    }

    const shouldReject = expectsRejection(filename);
    let outcome: ValidationOutcome;
    try {
      outcome = validateByKind(inferKind(doc), doc);
    } catch (error) {
      // 无法识别类型：对反向样例而言这正是期望结果
      outcome = { ok: false, issues: [{ path: "(root)", message: (error as Error).message }] };
    }

    if (shouldReject) {
      if (outcome.ok) {
        console.log(`  FAIL  ${filename}  期望被拒绝，但校验通过了（协议被放宽！）`);
        failures += 1;
      } else {
        console.log(`  PASS  ${filename}  已按预期拒绝：${outcome.issues[0]?.message ?? "无原因"}`);
      }
    } else {
      if (outcome.ok) {
        console.log(`  PASS  ${filename}`);
      } else {
        failures += 1;
        report(filename, outcome);
      }
    }
  }

  return failures;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  console.log(`协议版本：v${PROTOCOL_VERSION}`);

  const metaOutcome = validateProtocolMeta();
  console.log("协议元数据自检");
  report("PROTOCOL_META", metaOutcome);

  let failures = metaOutcome.ok ? 0 : 1;

  const fileArg = args.find((a) => !a.startsWith("--"));
  if (fileArg) {
    const target = resolve(process.cwd(), fileArg);
    const doc = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
    const outcome = validateByKind(inferKind(doc), doc);
    console.log(`单文件校验：${target}`);
    report(fileArg, outcome);
    if (!outcome.ok) failures += 1;
  } else {
    failures += runSamples();
  }

  console.log(failures === 0 ? "\n全部校验通过。" : `\n校验未通过：${failures} 处问题。`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
