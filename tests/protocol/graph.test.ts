/**
 * 任务图分析测试。对应第 6 节（无环依赖、并行判定）与验收 V01、V03。
 */
import { describe, expect, it } from "vitest";
import {
  analyzeGraph,
  canRunInParallel,
  closureOf,
  findCycle,
  globsMayOverlap,
  topologicalOrder,
  CycleError,
  type TaskNode,
} from "@dac/protocol";

function task(partial: Partial<TaskNode> & { task_id: string; depends_on?: string[] }): TaskNode {
  return {
    kind: "implement",
    title: partial.task_id,
    acceptance_criteria: ["通过单测"],
    depends_on: [],
    write_scope: { allow: [`src/${partial.task_id}/**`], deny: [] },
    contracts: [],
    requires: ["code"],
    expected_interfaces: [],
    status: "draft",
    assigned_executor: null,
    attempts_used: 0,
    ...partial,
  } as TaskNode;
}

describe("拓扑排序", () => {
  it("无依赖任务按 ID 稳定排序", () => {
    const graph = { tasks: [task({ task_id: "TASK-0003" }), task({ task_id: "TASK-0001" })] };
    expect(topologicalOrder(graph)).toEqual(["TASK-0001", "TASK-0003"]);
  });

  it("依赖任务排在其依赖之后", () => {
    const graph = {
      tasks: [
        task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
        task({ task_id: "TASK-0001" }),
      ],
    };
    const order = topologicalOrder(graph);
    expect(order.indexOf("TASK-0001")).toBeLessThan(order.indexOf("TASK-0002"));
  });

  it("相同输入得到相同顺序（确定性）", () => {
    const build = () => ({
      tasks: [
        task({ task_id: "TASK-0004", depends_on: ["TASK-0001"] }),
        task({ task_id: "TASK-0002" }),
        task({ task_id: "TASK-0001" }),
        task({ task_id: "TASK-0003" }),
      ],
    });
    expect(topologicalOrder(build())).toEqual(topologicalOrder(build()));
  });

  it("存在环时抛出 CycleError 并给出环上节点（验收 V03）", () => {
    const graph = {
      tasks: [
        task({ task_id: "TASK-0001", depends_on: ["TASK-0002"] }),
        task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
      ],
    };
    expect(() => topologicalOrder(graph)).toThrowError(CycleError);
    try {
      topologicalOrder(graph);
    } catch (error) {
      const cycle = (error as CycleError).cycle;
      expect(cycle).toContain("TASK-0001");
      expect(cycle).toContain("TASK-0002");
    }
  });

  it("依赖了图中不存在的任务时直接报错", () => {
    const graph = { tasks: [task({ task_id: "TASK-0001", depends_on: ["TASK-9999"] })] };
    expect(() => topologicalOrder(graph)).toThrowError(/不存在的任务/);
  });
});

describe("环检测", () => {
  it("无环返回空数组", () => {
    expect(findCycle([task({ task_id: "TASK-0001" })])).toEqual([]);
  });

  it("三节点环能被识别", () => {
    const cycle = findCycle([
      task({ task_id: "TASK-0001", depends_on: ["TASK-0003"] }),
      task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
      task({ task_id: "TASK-0003", depends_on: ["TASK-0002"] }),
    ]);
    expect(cycle.length).toBeGreaterThanOrEqual(3);
  });
});

describe("依赖闭合（第 9 节步骤 1）", () => {
  it("返回全部传递依赖", () => {
    const tasks = [
      task({ task_id: "TASK-0001" }),
      task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
      task({ task_id: "TASK-0003", depends_on: ["TASK-0002"] }),
      task({ task_id: "TASK-0004" }),
    ];
    const closure = closureOf(tasks, ["TASK-0003"]);
    expect([...closure].sort()).toEqual(["TASK-0001", "TASK-0002", "TASK-0003"]);
    expect(closure.has("TASK-0004")).toBe(false);
  });
});

describe("并行判定（验收 V01）", () => {
  it("写入范围互不重叠且无依赖的任务可并行", () => {
    const a = task({ task_id: "TASK-0001", write_scope: { allow: ["src/provider/**"], deny: [] } });
    const b = task({ task_id: "TASK-0002", write_scope: { allow: ["src/display/**"], deny: [] } });
    expect(canRunInParallel(a, b)).toBe(true);
  });

  it("有直接依赖的任务不可并行", () => {
    const a = task({ task_id: "TASK-0001" });
    const b = task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] });
    expect(canRunInParallel(a, b)).toBe(false);
  });

  it("写入范围重叠的任务必须串行（第 6 节）", () => {
    const a = task({ task_id: "TASK-0001", write_scope: { allow: ["src/shared/**"], deny: [] } });
    const b = task({ task_id: "TASK-0002", write_scope: { allow: ["src/shared/**"], deny: [] } });
    expect(canRunInParallel(a, b)).toBe(false);
  });

  it("父目录与子目录视为重叠（保守判定）", () => {
    const a = task({ task_id: "TASK-0001", write_scope: { allow: ["src/**"], deny: [] } });
    const b = task({ task_id: "TASK-0002", write_scope: { allow: ["src/mod/**"], deny: [] } });
    expect(canRunInParallel(a, b)).toBe(false);
  });

  it("不同目录子树下的通配范围判定为不重叠", () => {
    expect(globsMayOverlap("src/a/**", "src/b/**")).toBe(false);
    expect(globsMayOverlap("src/provider/**", "src/display/**")).toBe(false);
  });

  it("同一静态前缀下的通配范围判定为重叠", () => {
    expect(globsMayOverlap("src/a/*.ts", "src/a/*.tsx")).toBe(true);
    expect(globsMayOverlap("src/a/*/x.ts", "src/a/*/y.ts")).toBe(true);
  });

  it("从仓库根通配的形式保守返回重叠", () => {
    expect(globsMayOverlap("**/*.ts", "src/a/**")).toBe(true);
    expect(globsMayOverlap("*.json", "src/a/**")).toBe(true);
  });

  it("祖先目录无通配、后代为精确路径时判定为不重叠", () => {
    expect(globsMayOverlap("src/a", "src/b/c.ts")).toBe(false);
  });

  it("完全相同的静态路径判定为重叠", () => {
    expect(globsMayOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(globsMayOverlap("src/a.ts", "src/b.ts")).toBe(false);
  });
});

describe("图完整性问题汇总", () => {
  it("缺少验收条件的任务被标记", () => {
    const { problems } = analyzeGraph({
      tasks: [task({ task_id: "TASK-0001", acceptance_criteria: [] })],
    });
    expect(problems.join("\n")).toMatch(/缺少验收条件/);
  });

  it("缺少写入范围的任务被标记", () => {
    const { problems } = analyzeGraph({
      tasks: [task({ task_id: "TASK-0001", write_scope: { allow: [], deny: [] } })],
    });
    expect(problems.join("\n")).toMatch(/缺少写入范围/);
  });

  it("allow 与 deny 冲突被标记", () => {
    const { problems } = analyzeGraph({
      tasks: [
        task({
          task_id: "TASK-0001",
          write_scope: { allow: ["src/a/**", ".github/**"], deny: [".github/**"] },
        }),
      ],
    });
    expect(problems.join("\n")).toMatch(/同时出现在 allow 与 deny/);
  });

  it("环依赖出现在问题列表中而不抛异常", () => {
    const { problems, order } = analyzeGraph({
      tasks: [
        task({ task_id: "TASK-0001", depends_on: ["TASK-0002"] }),
        task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
      ],
    });
    expect(problems.join("\n")).toMatch(/环依赖/);
    expect(order).toEqual([]);
  });

  it("合法图无问题", () => {
    const { problems } = analyzeGraph({
      tasks: [
        task({ task_id: "TASK-0001" }),
        task({ task_id: "TASK-0002", depends_on: ["TASK-0001"] }),
      ],
    });
    expect(problems).toEqual([]);
  });
});
