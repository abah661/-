import type { TaskGraph, TaskNode } from "./schemas.js";

/**
 * 任务图分析。第 6 节要求协调器检查无环依赖、字段完整与验收覆盖。
 * 这些函数被 tools/validate-protocol 与协调器共用，保证同一套判定逻辑。
 */

export class CycleError extends Error {
  constructor(public readonly cycle: readonly string[]) {
    super(`任务图存在环依赖：${cycle.join(" → ")}`);
    this.name = "CycleError";
  }
}

/**
 * 拓扑排序。使用 Kahn 算法，同时能检测出环并给出环上的具体节点，
 * 便于把不合法规划退回给规划执行器修正（第 6 节）。
 */
export function topologicalOrder(graph: Pick<TaskGraph, "tasks">): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of graph.tasks) {
    indegree.set(task.task_id, 0);
    dependents.set(task.task_id, []);
  }
  for (const task of graph.tasks) {
    for (const dep of task.depends_on) {
      if (!indegree.has(dep)) {
        throw new Error(`依赖了不存在的任务：${dep}`);
      }
      indegree.set(task.task_id, (indegree.get(task.task_id) ?? 0) + 1);
      dependents.get(dep)?.push(task.task_id);
    }
  }

  // 稳定输出：按任务 ID 排序，保证相同输入得到相同批次顺序
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        // 插入时保持排序，确保顺序确定
        const at = queue.findIndex((q) => q > next);
        if (at === -1) queue.push(next);
        else queue.splice(at, 0, next);
      }
    }
  }

  if (order.length !== graph.tasks.length) {
    throw new CycleError(findCycle(graph.tasks));
  }
  return order;
}

/** 找出一个具体的环，用于错误提示。 */
export function findCycle(tasks: readonly TaskNode[]): string[] {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const state = color.get(id) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GRAY) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.task_id);
    if (found) return found;
  }
  return [];
}

/**
 * 依赖闭合性检查：给定一批候选任务 ID，返回其全部传递依赖。
 * 第 9 节步骤 1 要求"等待一个依赖闭合的任务集合交付"，
 * 也用于判断两个任务能否并行——写入范围不冲突且互不依赖。
 */
export function closureOf(tasks: readonly TaskNode[], seeds: readonly string[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const result = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (result.has(id)) continue;
    result.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) stack.push(dep);
  }
  return result;
}

/**
 * 判断两批任务是否可以真正并行（验收 V01）。
 *
 * 第 6 节："影响同一文件的任务先串行处理"。
 * 这里做保守判定：只要写入范围可能重叠，就判定为不可并行。
 * 采用前缀式目录/文件推断，glob 复杂情形返回"不确定"，
 * 由协调器交给规划阶段重新拆分。
 */
export function canRunInParallel(a: TaskNode, b: TaskNode): boolean {
  // 直接依赖关系必须先串行
  const closureA = closureOf([a, b], [a.task_id]);
  if (closureA.has(b.task_id)) return false;
  const closureB = closureOf([a, b], [b.task_id]);
  if (closureB.has(a.task_id)) return false;

  return !writeScopesMayOverlap(a, b);
}

/** 判断两个写入范围是否可能触及同一路径。保守实现：可能重叠即返回 true。 */
export function writeScopesMayOverlap(a: TaskNode, b: TaskNode): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "");

  for (const pa of a.write_scope.allow) {
    for (const pb of b.write_scope.allow) {
      if (globsMayOverlap(norm(pa), norm(pb))) return true;
    }
  }
  return false;
}

/**
 * 把 glob 规约为「静态目录前缀 + 该前缀是否被通配符截断」。
 *
 * 关键点：通配符只能影响它所在的那一层及其下，不会跨越到兄弟层级。
 * 因此先取通配符之前的静态目录前缀，再判断前缀间的包含关系。
 *
 * 例：
 *   src/provider/**  → prefix "src/provider"，prefixedByWildcard=false
 *   src/a/*.ts       → prefix "src/a"，       prefixedByWildcard=true（通配在最后一层）
 *   src/a/*.tsx      → prefix "src/a"，       prefixedByWildcard=true
 *   **\/*.ts         → prefix ""，            prefixedByWildcard=true（通配在最顶层）
 */
function reduceGlob(g: string): {
  /** 通配符之前的静态路径前缀（不含尾随斜杠） */
  prefix: string;
  /** 通配符是否出现在最后一层（即该层本身被通配） */
  wildcardAtLeaf: boolean;
  /** 是否含通配符 */
  wildcard: boolean;
} {
  const wildcard = /[*?[\]{}]/.test(g);

  // 截掉尾随的 / 与 /** /* 形式，统一为目录路径
  let s = g;
  if (s.endsWith("/**")) s = s.slice(0, -3);
  else if (s.endsWith("/*")) s = s.slice(0, -2);
  else if (s.endsWith("/")) s = s.slice(0, -1);

  const segments = s.split("/").filter((seg) => seg.length > 0);

  // 找到第一个含通配符的段
  const wildcardIndex = segments.findIndex((seg) => /[*?[\]{}]/.test(seg));
  if (wildcardIndex === -1) {
    return { prefix: segments.join("/"), wildcardAtLeaf: false, wildcard };
  }

  const staticSegments = segments.slice(0, wildcardIndex);
  return {
    prefix: staticSegments.join("/"),
    wildcardAtLeaf: wildcardIndex === segments.length - 1,
    wildcard,
  };
}

/**
 * 判断两个 glob 是否可能触及同一路径。
 *
 * 判定规则：
 *   1. 完全相同 → 重叠
 *   2. 静态前缀完全一致 → 同一层级，重叠
 *   3. 静态前缀构成祖先/后代关系：
 *      - 祖先侧的通配符能向下延伸覆盖后代目录 → 重叠
 *      - 否则（如 src/a/** 与 src/a/b.ts 之外的兄弟情况）按实际情况判断
 *   4. 静态前缀无包含关系且都非空 → 不同目录子树，不重叠
 *   5. 某一侧是全局通配（前缀为空）→ 无法静态判定，保守返回重叠
 */
export function globsMayOverlap(ga: string, gb: string): boolean {
  if (ga === gb) return true;

  const a = reduceGlob(ga);
  const b = reduceGlob(gb);

  // 前缀为空表示从仓库根开始通配，无法静态判定 → 保守重叠
  if (a.wildcard && a.prefix === "") return true;
  if (b.wildcard && b.prefix === "") return true;

  // 前缀一致：同一目录层级，视为重叠（含 src/a/*.ts 与 src/a/*.tsx 的情形）
  if (a.prefix === b.prefix) return true;

  const isAncestor = (parent: string, child: string) =>
    parent !== "" && child.startsWith(`${parent}/`);

  // a 是 b 的祖先（或反之）：祖先目录被通配覆盖时重叠
  if (isAncestor(a.prefix, b.prefix) || isAncestor(b.prefix, a.prefix)) {
    // 祖先侧带通配符则可向下覆盖，判定为重叠；
    // 两侧都无通配符时为精确路径，祖先与后代是不同路径 → 不重叠
    return a.wildcard || b.wildcard;
  }

  // 静态前缀无包含关系 → 作用在不同目录子树，不重叠
  return false;
}

/** 图的完整校验，返回问题列表。供 CLI 与协调器复用。 */
export function analyzeGraph(graph: Pick<TaskGraph, "tasks">): {
  order: string[];
  problems: string[];
} {
  const problems: string[] = [];

  // 字段完整性：验收条件与写入范围
  for (const task of graph.tasks) {
    if (task.acceptance_criteria.length === 0) {
      problems.push(`${task.task_id}：缺少验收条件`);
    }
    if (task.write_scope.allow.length === 0) {
      problems.push(`${task.task_id}：缺少写入范围 allow`);
    }
    if (task.requires.length === 0) {
      problems.push(`${task.task_id}：未声明所需能力`);
    }
    for (const pattern of task.write_scope.deny) {
      if (task.write_scope.allow.includes(pattern)) {
        problems.push(`${task.task_id}：路径 ${pattern} 同时出现在 allow 与 deny 中`);
      }
    }
  }

  let order: string[] = [];
  try {
    order = topologicalOrder(graph);
  } catch (error) {
    if (error instanceof CycleError) problems.push(error.message);
    else throw error;
  }

  return { order, problems };
}
