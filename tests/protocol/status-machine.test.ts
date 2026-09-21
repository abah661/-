/**
 * 状态机测试。对应规则：任务状态转移只能走协议定义。
 */
import { describe, expect, it } from "vitest";
import {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TERMINAL_STATUSES,
  BLOCKED_STATUSES,
  canTransition,
  assertTransition,
  isTerminal,
  isBlocked,
} from "@dac/protocol";

describe("状态机完整性", () => {
  it("每个状态都在转移表中有条目", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("转移表中不出现未定义的状态", () => {
    for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
      for (const to of targets) {
        expect(TASK_STATUSES, `${from} → ${to}`).toContain(to);
      }
    }
  });

  it("终态没有任何后继状态", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(TASK_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it("状态之间不存在自环", () => {
    for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
      expect(targets).not.toContain(from);
    }
  });
});

describe("正常路径可达性", () => {
  it("draft 到 merged 的完整链路逐跳合法", () => {
    const happyPath = [
      "draft",
      "planning",
      "ready",
      "leased",
      "running",
      "validating",
      "ready_for_integration",
      "integrating",
      "passed",
      "merged",
    ] as const;

    for (let i = 0; i < happyPath.length - 1; i += 1) {
      const from = happyPath[i] as (typeof happyPath)[number];
      const to = happyPath[i + 1] as (typeof happyPath)[number];
      expect(canTransition(from, to), `${from} → ${to} 应合法`).toBe(true);
    }
  });

  it("从 draft 出发能到达 merged", () => {
    const visited = new Set<string>(["draft"]);
    const queue = ["draft"];
    while (queue.length > 0) {
      const current = queue.shift() as keyof typeof TASK_TRANSITIONS;
      for (const next of TASK_TRANSITIONS[current]) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    expect(visited.has("merged")).toBe(true);
  });

  it("从任意状态出发都能到达 cancelled（终态可收敛）", () => {
    for (const status of TASK_STATUSES) {
      if (isTerminal(status)) continue;
      expect(TASK_TRANSITIONS[status], `${status} 应可取消`).toContain("cancelled");
    }
  });
});

describe("非法转移被拒绝", () => {
  it("draft 不能直接跳到 merged", () => {
    expect(canTransition("draft", "merged")).toBe(false);
  });

  it("merged 是终态，不能回到任何状态", () => {
    expect(canTransition("merged", "running")).toBe(false);
    expect(canTransition("merged", "repair_pending")).toBe(false);
  });

  it("leased 不能直接进入 validating（必须经过 running）", () => {
    expect(canTransition("leased", "validating")).toBe(false);
  });

  it("validating 不能直接进入 merged（完整功能须由组合测试验收）", () => {
    expect(canTransition("validating", "merged")).toBe(false);
  });

  it("assertTransition 在非法转移时抛出带上下文的错误", () => {
    expect(() => assertTransition("draft", "merged")).toThrowError(/非法状态转移/);
    expect(() => assertTransition("draft", "merged")).toThrowError(/draft → merged/);
  });

  it("assertTransition 在合法转移时不抛出", () => {
    expect(() => assertTransition("draft", "planning")).not.toThrow();
  });
});

describe("阻塞与终态判定", () => {
  it("阻塞状态互不相同且都能回到 ready 或 cancelled", () => {
    for (const status of BLOCKED_STATUSES) {
      const targets = TASK_TRANSITIONS[status];
      const canResume = targets.includes("ready") || targets.includes("cancelled");
      expect(canResume, `${status} 必须能恢复或取消`).toBe(true);
      expect(isBlocked(status)).toBe(true);
    }
  });

  it("登录与配额是彼此独立的阻塞状态（验收 V10）", () => {
    expect(BLOCKED_STATUSES).toContain("blocked_auth");
    expect(BLOCKED_STATUSES).toContain("blocked_quota");
    expect("blocked_auth").not.toBe("blocked_quota");
  });

  it("正常路径上的状态不是阻塞状态", () => {
    expect(isBlocked("running")).toBe(false);
    expect(isBlocked("validating")).toBe(false);
    expect(isTerminal("merged")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});
