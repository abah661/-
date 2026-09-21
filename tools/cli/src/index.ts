import { readFile } from "node:fs/promises";
import process from "node:process";
import {
  analyzeGraph,
  ResultReportSchema,
  TaskGraphSchema,
  validateTimingConfig,
  DEFAULT_TIMING,
} from "@dac/protocol";

function usage(): void {
  console.error(`用法：
  npm exec --workspace @dac/cli -- dac validate-result <json>
  npm exec --workspace @dac/cli -- dac validate-graph <json>
  npm exec --workspace @dac/cli -- dac validate-timing`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const [command, file] = process.argv.slice(2);
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
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
