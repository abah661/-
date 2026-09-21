import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  analyzeGraph,
  ResultReportSchema,
  TaskGraphSchema,
  validateTimingConfig,
  DEFAULT_TIMING,
} from "@dac/protocol";
import { buildFixedIntegrationPlan, parsePendingIntegrationBatch, verifyIntegrationEvidence } from "@dac/integration";

function usage(): void {
  console.error(`用法：
  npm exec --workspace @dac/cli -- dac validate-result <json>
  npm exec --workspace @dac/cli -- dac validate-graph <json>
  npm exec --workspace @dac/cli -- dac plan-integration <batch-json>
  npm exec --workspace @dac/cli -- dac verify-integration <batch-json> <evidence-json>
  npm exec --workspace @dac/cli -- dac validate-timing`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const [command, file, secondFile] = process.argv.slice(2);
try {
  if (command === "validate-result" && file) {
    const parsed = ResultReportSchema.safeParse(await readJson(file));
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
      process.exitCode = 1;
    } else {
      console.log(`结果报告有效：${parsed.data.task_id}`);
    }
  } else if (command === "validate-graph" && file) {
    const parsed = TaskGraphSchema.safeParse(await readJson(file));
    if (!parsed.success) {
      console.error(JSON.stringify(parsed.error.issues, null, 2));
      process.exitCode = 1;
    } else {
      const result = analyzeGraph(parsed.data);
      if (result.problems.length > 0) {
        console.error(result.problems.join("\n"));
        process.exitCode = 1;
      } else {
        console.log(`任务图有效，拓扑顺序：${result.order.join(" → ")}`);
      }
    }
  } else if (command === "validate-timing") {
    const problems = validateTimingConfig(DEFAULT_TIMING);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("默认时序参数有效");
    }
  } else if (command === "plan-integration" && file) {
    const batch = parsePendingIntegrationBatch(await readJson(file));
    console.log(JSON.stringify({ batch, commands: buildFixedIntegrationPlan(batch, ".local/integration-worktree") }, null, 2));
  } else if (command === "verify-integration" && file && secondFile) {
    const batch = parsePendingIntegrationBatch(await readJson(file));
    const verification = verifyIntegrationEvidence(batch, (await readJson(secondFile)) as Parameters<typeof verifyIntegrationEvidence>[1]);
    if (!verification.valid) {
      console.error(verification.problems.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`整合验收通过：${batch.batch_id}`);
    }
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
