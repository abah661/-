/**
 * 受控进程树的探测与状态判定（B12，A 端 B11 复验 §三 P1 / P2）。
 *
 * ## 这一层要锁住什么
 * A 端用真实父子进程复现的缺口是：**「观察到 close」≠「整棵树已停止」**。
 * 父进程（agent）正常关闭后，它拉起的后代仍可以继续写同一个 worktree，
 * 而 B11 已经把状态判成了 `stopped`。
 *
 * 因此本文件把两件事分开钉住：
 * - `determineProcessState` 的**组合语义**：close 之后必须再问一次树，
 *   只有「close + 树 gone」才允许判 `stopped`；
 * - `SystemTreeProbe` 的**平台分支**：Windows 用后代枚举，且命令失败/超时
 *   一律答 `unknown`（既不冒称存活，也不冒称已停止）。
 *
 * Windows 分支在这里用**注入的命令运行器**驱动 —— 否则它在 Linux CI 上
 * 永远不会被执行，而真实 `taskkill`/`powershell` 卡住又是最难在生产上
 * 复现的一类故障。
 */

import { describe, expect, it } from "vitest";

import {
  SystemTreeProbe,
  TREE_CLOCK_SLACK_MS,
  determineProcessState,
  parseDescendantList,
  probeProcessAlive,
  treeCreationWindow,
} from "../../apps/executor/src/core/proc-tree.js";
import type { DescendantCommandHandle, DescendantCommandRunner } from "../../apps/executor/src/core/proc-tree.js";

/* ------------------------------------------------------------------ *
 * 单体探测
 * ------------------------------------------------------------------ */

describe("B12 单体存活探测 probeProcessAlive", () => {
  it("本进程必然活着；非法 pid 一律「不知道」而不是「已退出」", () => {
    expect(probeProcessAlive(process.pid)).toBe("alive");
    // 非法输入不能冒充「已退出」——那会让门禁以为现场是干净的
    expect(probeProcessAlive(-1)).toBe("unknown");
    expect(probeProcessAlive(0)).toBe("unknown");
    expect(probeProcessAlive(Number.NaN)).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ *
 * 状态判定
 * ------------------------------------------------------------------ */

describe("B12 determineProcessState：close 之后必须再问一次树", () => {
  it("spawn 失败优先：连进程都没有 → spawn_failed（可安全继续）", async () => {
    expect(
      await determineProcessState({ spawn_failed: true, close_observed: true }),
    ).toBe("spawn_failed");
    expect(
      await determineProcessState({ spawn_failed: true, close_observed: false }),
    ).toBe("spawn_failed");
  });

  it("观察到关闭 **且树也 gone** → stopped（唯一允许判「已停止」的组合）", async () => {
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: true,
        probe_tree: async () => "gone",
      }),
    ).toBe("stopped");
  });

  it("**观察到关闭但后代仍存活 → residual**（A 端 B11 复验 P1 的核心）", async () => {
    // 旧实现（B11）在这个输入上返回 `stopped`：close 一到就直接判「已停止」，
    // 于是「后代还在写同一个 worktree」被说成了「现场已干净」。
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: true,
        probe_tree: async () => "alive",
      }),
    ).toBe("residual");
  });

  it("观察到关闭但树探测答不出来 → unknown（不把「问不到」当成「已停止」）", async () => {
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: true,
        probe_tree: async () => "unknown",
      }),
    ).toBe("unknown");
  });

  it("未观察到关闭：确认存活才 residual；探测答 gone 也只记 unknown（不冒称已停止）", async () => {
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: false,
        probe_tree: async () => "alive",
      }),
    ).toBe("residual");
    // A 端裁定：这条路径按「未观察到关闭」处理，**不**因为探测显示已不存在
    // 就升级成 `stopped` —— 宁可人工确认一次，也不凭空补一个「已停止」。
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: false,
        probe_tree: async () => "gone",
      }),
    ).toBe("unknown");
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: false,
        probe_tree: async () => "unknown",
      }),
    ).toBe("unknown");
  });

  it("树探测抛异常 → unknown（绝不冒称已停止）", async () => {
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: true,
        probe_tree: async () => {
          throw new Error("枚举命令不可用");
        },
      }),
    ).toBe("unknown");
  });

  it("没有树通道时退化为直接子进程语义（注入式 runner 的兼容路径）", async () => {
    // 出厂 runner 永远提供树通道；这里锁住的是「缺省时不会抛错、
    // 也不会把 `unknown` 当成 `stopped`」的退化行为。
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: true,
        probe: () => "alive",
      }),
    ).toBe("stopped");
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: false,
        probe: () => "alive",
      }),
    ).toBe("residual");
    expect(
      await determineProcessState({
        spawn_failed: false,
        close_observed: false,
        probe: () => "unknown",
      }),
    ).toBe("unknown");
    // 连探测都没有 → 「不知道」，不是「已停止」
    expect(
      await determineProcessState({ spawn_failed: false, close_observed: false }),
    ).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ *
 * SystemTreeProbe：Windows 后代枚举
 * ------------------------------------------------------------------ */

interface FakeCommand {
  runner: DescendantCommandRunner;
  calls: Array<{ executable: string; args: readonly string[] }>;
  aborted: boolean;
}

function fakeCommand(options: {
  stdout?: string;
  code?: number | null;
  error?: Error | null;
  hang?: boolean;
}): FakeCommand {
  const calls: FakeCommand["calls"] = [];
  const state = { aborted: false };
  const runner: DescendantCommandRunner = (executable, args) => {
    calls.push({ executable, args });
    const handle: DescendantCommandHandle = {
      done: options.hang
        ? new Promise(() => undefined)
        : Promise.resolve({
            code: options.code ?? 0,
            error: options.error ?? null,
            stdout: options.stdout ?? "",
          }),
      abort: () => {
        state.aborted = true;
      },
    };
    return handle;
  };
  return {
    runner,
    calls,
    get aborted() {
      return state.aborted;
    },
  };
}

describe("B12 SystemTreeProbe：Windows 用后代枚举，失败一律 unknown", () => {
  const win = (command: FakeCommand, extra: { single_probe?: () => "alive" | "gone" | "unknown" } = {}) =>
    new SystemTreeProbe({
      platform: "win32",
      runner: command.runner,
      timeout_ms: 100,
      ...(extra.single_probe ? { single_probe: extra.single_probe } : {}),
    });

  /** 一条合法后代记录（pid|name|创建时刻 epoch ms），后跟收尾标记。 */
  const descendant = (pid: number, createdMs: number, name = "node.exe"): string =>
    `${pid}|${name}|${createdMs}\nEND\n`;

  it("枚举出后代 → alive；命令形状是「不过 shell、非交互、带那个整数 pid」", async () => {
    const command = fakeCommand({ stdout: descendant(4444, 1_000_000) });
    expect(await win(command, { single_probe: () => "gone" }).probeTree(4242)).toBe("alive");
    expect(command.calls).toHaveLength(1);
    expect(command.calls[0]!.executable).toBe("powershell.exe");
    expect(command.calls[0]!.args).toContain("-NoProfile");
    expect(command.calls[0]!.args).toContain("-NonInteractive");
    expect(command.calls[0]!.args.join(" ")).toContain("4242");
    // 脚本必须把**创建时刻**一起带回来 —— 时间窗口过滤全靠它
    expect(command.calls[0]!.args.join(" ")).toContain("CreationDate");
  });

  it("没有后代（只有收尾标记）→ gone", async () => {
    const command = fakeCommand({ stdout: "END\n" });
    expect(await win(command, { single_probe: () => "gone" }).probeTree(4242)).toBe("gone");
  });

  it("命令非零退出 / 启动失败 / 输出不可解析 / 缺收尾标记 → 一律 unknown", async () => {
    for (const options of [
      { stdout: "END\n", code: 1 },
      { stdout: "END\n", error: new Error("EPERM") },
      { stdout: "无法识别的输出\n" },
      // 少了创建时刻字段
      { stdout: "4444|node.exe\nEND\n" },
      // pid 不是数字
      { stdout: "abc|node.exe|111\nEND\n" },
      // 收尾标记缺失 = 输出被截断：**不能**当成「没有后代」
      { stdout: "4444|node.exe|111\n" },
      { stdout: "" },
    ]) {
      const command = fakeCommand(options);
      expect(await win(command, { single_probe: () => "gone" }).probeTree(4242)).toBe("unknown");
    }
  });

  it("命令卡住 → 有界放弃并中断命令，返回 unknown（不允许挂死执行器）", async () => {
    const command = fakeCommand({ hang: true });
    const probe = new SystemTreeProbe({
      platform: "win32",
      runner: command.runner,
      timeout_ms: 50,
      single_probe: () => "gone",
    });
    expect(await probe.probeTree(4242)).toBe("unknown");
    expect(command.aborted).toBe(true);
  });

  it("根进程自己就活着 → 直接 alive，不再多打一次枚举命令", async () => {
    const command = fakeCommand({ stdout: "END\n" });
    expect(await win(command, { single_probe: () => "alive" }).probeTree(4242)).toBe("alive");
    expect(command.calls).toHaveLength(0);
  });

  it("include_root=false（已观察到 close）→ 跳过根进程探测，只看后代", async () => {
    // 此刻 pid 可能已被操作系统复用，再探根会把**无关进程**算成 agent 的后代
    const command = fakeCommand({ stdout: "END\n" });
    const probe = win(command, { single_probe: () => "alive" });
    expect(await probe.probeTree(4242, { include_root: false })).toBe("gone");
    expect(command.calls).toHaveLength(1);
  });

  it("非法 pid → unknown，且不起任何外部命令", async () => {
    const command = fakeCommand({ stdout: "END\n" });
    expect(await win(command).probeTree(0)).toBe("unknown");
    expect(await win(command).probeTree(-1)).toBe("unknown");
    expect(command.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * B12：创建时间窗口 —— 把「可证明无关」的进程剔出后代集合
 *
 * 「按 ParentProcessId 枚举」在有 pid 回收时并不充分：全量并行测试里，
 * **更早的树**留下的孤儿会让本用例的 root pid 凭空多出后代，把一次正常
 * 收尾误判成 `residual`。窗口的两条边界都是可证明的，因此只删无关进程、
 * 永不误杀真实后代。
 * ------------------------------------------------------------------ */

describe("B12 SystemTreeProbe：后代创建时间窗口（pid 回收的误报必须被剔掉）", () => {
  const win = (stdout: string, single: () => "alive" | "gone" | "unknown" = () => "gone") =>
    new SystemTreeProbe({
      platform: "win32",
      runner: fakeCommand({ stdout }).runner,
      timeout_ms: 100,
      single_probe: single,
    });

  it("后代比 root 还早出现 → 一定是别人的孤儿，不计入 → gone", async () => {
    // root 在 ms=5000 创建；这条记录创建于 ms=1000，**不可能**是它的后代
    const probe = win("777|node.exe|1000\nEND\n");
    expect(
      await probe.probeTree(4242, { include_root: false, created_after_ms: 5_000 }),
    ).toBe("gone");
  });

  it("后代在 root 退出之后才出现 → 是 pid 复用者新拉起的，不计入 → gone", async () => {
    // root 在 ms=5000 被观察到关闭；这条记录创建于 ms=9000
    const probe = win("778|node.exe|9000\nEND\n");
    expect(
      await probe.probeTree(4242, {
        include_root: false,
        created_after_ms: 1_000,
        created_before_ms: 5_000,
      }),
    ).toBe("gone");
  });

  it("窗口**内**的真实后代仍然判 alive（过滤不误杀）", async () => {
    const probe = win("779|node.exe|3000\nEND\n");
    expect(
      await probe.probeTree(4242, {
        include_root: false,
        created_after_ms: 1_000,
        created_before_ms: 5_000,
      }),
    ).toBe("alive");
  });

  it("窗口只剔掉无关项：一条无关 + 一条在窗内 → 仍 alive", async () => {
    const probe = win("780|node.exe|100\n781|node.exe|3000\nEND\n");
    expect(
      await probe.probeTree(4242, {
        include_root: false,
        created_after_ms: 1_000,
        created_before_ms: 5_000,
      }),
    ).toBe("alive");
  });

  it("创建时刻拿不到（0）→ 保守计入，不据此排除", async () => {
    // 宁可多停一次，也不能因为「读不到时间」就把可能仍在写 worktree 的进程放过去
    const probe = win("782|node.exe|0\nEND\n");
    expect(
      await probe.probeTree(4242, {
        include_root: false,
        created_after_ms: 1_000,
        created_before_ms: 5_000,
      }),
    ).toBe("alive");
  });
});

describe("B12 parseDescendantList / treeCreationWindow：格式与边界的单点锁定", () => {
  it("合法输出解析出 pid 与创建时刻；收尾标记缺失一律 null", () => {
    expect(parseDescendantList("11|a.exe|111\n22|b.exe|222\nEND\n")).toEqual([
      { pid: 11, created_ms: 111 },
      { pid: 22, created_ms: 222 },
    ]);
    expect(parseDescendantList("END\n")).toEqual([]);
    expect(parseDescendantList("11|a.exe|111\n")).toBeNull(); // 截断
    expect(parseDescendantList("")).toBeNull();
    expect(parseDescendantList("11|a.exe\nEND\n")).toBeNull();
  });

  it("创建时刻非正数记为「拿不到」而不是 0", () => {
    expect(parseDescendantList("11|a.exe|0\nEND\n")).toEqual([{ pid: 11, created_ms: null }]);
  });

  it("未观察到关闭 → 只给下界；观察到关闭 → 上界为关闭时刻 + 时钟余量", () => {
    expect(treeCreationWindow({ spawn_at_ms: 100, closed_at_ms: null })).toEqual({
      created_after_ms: 100,
    });
    expect(treeCreationWindow({ spawn_at_ms: 100, closed_at_ms: 900 })).toEqual({
      created_after_ms: 100,
      created_before_ms: 900 + TREE_CLOCK_SLACK_MS,
    });
  });
});

describe("B12 SystemTreeProbe：POSIX 进程组分支", () => {
  it("组不存在时退回单体探测（如实回答，而不是把「没有组」说成「没有进程」）", async () => {
    const probe = new SystemTreeProbe({
      platform: "linux",
      single_probe: () => "gone",
    });
    // 一个几乎不可能存在的 pid：组探测必然 ESRCH，于是走单体回退
    expect(await probe.probeTree(2_147_483_646)).toBe("gone");
  });

  it("单体探测答不出时保持 unknown（三态不塌缩）", async () => {
    const probe = new SystemTreeProbe({
      platform: "darwin",
      single_probe: () => "unknown",
    });
    expect(await probe.probeTree(2_147_483_646)).toBe("unknown");
  });
});
