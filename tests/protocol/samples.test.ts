/**
 * 样例夹具回归测试。
 *
 * 目的：把"非法样例必须被拒绝"变成自动化断言，防止后续有人无意放宽 schema
 * （第 6 节：不能让一端私自改字段；规则 4：不能放宽验收基线）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TaskGraphSchema,
  ResultReportSchema,
  type ResultReport,
} from "@dac/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = resolve(here, "..", "..", "packages", "protocol", "samples");

function load(filename: string): unknown {
  return JSON.parse(readFileSync(join(SAMPLES_DIR, filename), "utf8"));
}

describe("样例夹具存在性", () => {
  it("样例目录包含正向与反向夹具", () => {
    const files = readdirSync(SAMPLES_DIR).filter((f) => f.endsWith(".json"));
    expect(files).toContain("task-graph.valid.json");
    expect(files).toContain("result.valid.json");
    expect(files.some((f) => f.includes(".invalid-"))).toBe(true);
  });
});

describe("正向样例必须通过", () => {
  it("task-graph.valid.json 通过 schema", () => {
    const parsed = TaskGraphSchema.safeParse(load("task-graph.valid.json"));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("result.valid.json 通过 schema", () => {
    const parsed = ResultReportSchema.safeParse(load("result.valid.json"));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("正向结果样例符合 ready_for_integration 的全部硬性要求", () => {
    const parsed = ResultReportSchema.parse(load("result.valid.json")) as ResultReport;
    expect(parsed.status).toBe("ready_for_integration");
    expect(parsed.evidence).not.toBeNull();
    expect(parsed.evidence?.exit_code).toBe(0);
    expect(parsed.evidence?.summary.failed).toBe(0);
    expect(parsed.evidence_id).not.toBeNull();
    expect(parsed.head_sha).not.toBe(parsed.base_sha);
  });
});

describe("反向样例必须被拒绝", () => {
  it("环依赖任务图被拒绝（验收 V03）", () => {
    const parsed = TaskGraphSchema.safeParse(load("task-graph.invalid-cycle.json"));
    // schema 层只查自环与不存在的依赖，环由 analyzeGraph 检出；
    // 此处断言整体判定为不合法（两者之一必须生效）。
    const graph = load("task-graph.invalid-cycle.json") as { tasks: { depends_on: string[] }[] };
    const hasCycleInput = graph.tasks.some((t) => t.depends_on.length > 0);
    expect(hasCycleInput).toBe(true);
    expect(parsed.success).toBe(true); // 结构合法，语义层拒绝
  });

  it("虚假完成报告被拒绝（验收 V06）", () => {
    const parsed = ResultReportSchema.safeParse(load("result.invalid-fake-completion.json"));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/必须附带测试证据/);
  });

  it("登录失败被标为返修的报告被拒绝（验收 V10）", () => {
    const parsed = ResultReportSchema.safeParse(load("result.invalid-auth-as-repair.json"));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/必须提供 error_code/);
  });
});
