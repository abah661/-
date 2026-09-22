/**
 * 公共内核测试：进程控制、diff 范围核对（规则 3）。
 *
 * 覆盖 README 点名的 Windows 重点项：
 * - 中文路径与空格路径
 * - 进程树停止（不能只杀父进程）
 * - 超时控制
 *
 * 进程相关用例统一用**假运行器 + 假 killer**，既确定又不真的拉起进程；
 * 真实进程行为另由 tests/executor/windows-integration.test.ts 覆盖。
 */

import { describe, expect, it, vi } from "vitest";
import {
  assertSafeArgv,
  collectStream,
  runProcess,
} from "../../apps/executor/src/core/process.js";
import type { ChildProcessHandle, ProcessRunner, TreeKiller } from "../../apps/executor/src/core/process.js";
import {
  globToRegExp,
  isPathAllowed,
  findSensitiveTouches,
} from "../../apps/executor/src/core/diff-check.js";
import { isInside } from "../../apps/executor/src/core/worktree.js";

/* ------------------------------------------------------------------ *
 * 进程控制
 * ------------------------------------------------------------------ */

class FakeChild implements ChildProcessHandle {
  pid: number | null;
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exit_code: Promise<number | null>;
  readonly signal: Promise<NodeJS.Signals | null>;
  /** 供测试在「被杀死」时手动结算 exit_code */
  resolveExit: ((code: number | null) => void) | null = null;

  constructor(options: {
    pid?: number | null;
    out?: string;
    err?: string;
    code?: number | null;
    /** true 表示不自行退出，需等 kill 才结算（模拟真实长驻进程） */
    hang?: boolean;
  }) {
    this.pid = options.pid ?? 4321;
    this.stdout = (async function* () {
      if (options.out) yield options.out;
    })();
    this.stderr = (async function* () {
      if (options.err) yield options.err;
    })();
    this.exit_code = options.hang
      ? new Promise<number | null>((resolve) => {
          this.resolveExit = resolve;
        })
      : Promise.resolve(options.code ?? 0);
    this.signal = Promise.resolve(null);
  }

  /** 模拟进程树被 taskkill 后退出。 */
  simulateKilled(): void {
    this.resolveExit?.(null);
  }
}

class FakeRunner implements ProcessRunner {
  lastSpec: Parameters<ProcessRunner["start"]>[0] | null = null;
  constructor(private readonly child: ChildProcessHandle) {}
  start(spec: Parameters<ProcessRunner["start"]>[0]): ChildProcessHandle {
    this.lastSpec = spec;
    return this.child;
  }
}

class RecordingKiller implements TreeKiller {
  calls: Array<{ pid: number; force: boolean }> = [];
  /** 关联的假子进程；**仅强杀时**结算其 exit_code，以此验证升级链真的走到第 2 级 */
  child: FakeChild | null = null;
  /** 是否连强杀也不生效（模拟杀不掉的进程） */
  stubborn = false;
  async killTree(pid: number, force: boolean): Promise<void> {
    this.calls.push({ pid, force });
    if (this.stubborn) return;
    if (force) this.child?.simulateKilled();
  }
}

describe("runProcess", () => {
  it("以参数数组调用，不经 shell", async () => {
    const runner = new FakeRunner(new FakeChild({ out: "ok" }));
    const spec = {
      executable: "node",
      args: ["-e", "console.log(1)"],
      cwd: "C:/tmp",
    };
    await runProcess(spec, { timeout_ms: 1000, runner });
    expect(runner.lastSpec?.executable).toBe("node");
    expect(runner.lastSpec?.args).toEqual(["-e", "console.log(1)"]);
  });

  it("正常结束不触发任何终止", async () => {
    const killer = new RecordingKiller();
    const runner = new FakeRunner(new FakeChild({ out: "done", code: 0 }));
    const result = await runProcess(
      { executable: "x", args: [], cwd: "." },
      { timeout_ms: 1000, runner, killer, grace_ms: 10 },
    );
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(killer.calls).toHaveLength(0);
  });

  it("超时后先优雅终止整棵进程树，宽限期满再强杀", async () => {
    const killer = new RecordingKiller();
    const child = new FakeChild({ pid: 9999, hang: true });
    killer.child = child;
    const runner = new FakeRunner(child);
    const result = await runProcess(
      { executable: "x", args: [], cwd: "." },
      { timeout_ms: 20, runner, killer, grace_ms: 20 },
    );
    expect(result.timed_out).toBe(true);
    // 第 1 级：优雅停止整棵树（SIGTERM 语义，非 /F）
    expect(killer.calls[0]).toEqual({ pid: 9999, force: false });
    // 第 2 级：强杀（/F 语义）——必须真的发生，否则优雅停止无效时无人救场
    expect(killer.calls.some((c) => c.force)).toBe(true);
    // 强杀生效 → 进程确实被终止，不算「杀不掉」
    expect(result.escalated_to_force).toBe(true);
    expect(result.kill_failed).toBe(false);
  });

  it("优雅停止有效时不再升级到强杀", async () => {
    const killer = new RecordingKiller();
    const child = new FakeChild({ pid: 7777, hang: true });
    // 优雅停止即生效：让子进程在第一次 kill 时就退出
    const gracefulKiller: TreeKiller = {
      async killTree(pid, force) {
        killer.calls.push({ pid, force });
        child.simulateKilled();
      },
    } as unknown as TreeKiller;
    const runner = new FakeRunner(child);
    const result = await runProcess(
      { executable: "x", args: [], cwd: "." },
      { timeout_ms: 20, runner, killer: gracefulKiller, grace_ms: 50 },
    );
    expect(result.timed_out).toBe(true);
    expect(killer.calls).toHaveLength(1);
    expect(killer.calls[0]!.force).toBe(false);
    expect(result.kill_failed).toBe(false);
  });

  it("进程忽略终止信号时放弃等待并标记 kill_failed", async () => {
    const killer = new RecordingKiller();
    killer.stubborn = true; // 连强杀也不生效
    const child = new FakeChild({ pid: 8888, hang: true });
    const runner = new FakeRunner(child);
    const result = await runProcess(
      { executable: "x", args: [], cwd: "." },
      { timeout_ms: 20, runner, killer, grace_ms: 10 },
    );
    expect(result.timed_out).toBe(true);
    // 连强杀都无效 → 需要人工介入
    expect(result.kill_failed).toBe(true);
    expect(result.escalated_to_force).toBe(true);
    // 未取得退出码，但函数**确实返回了**（不卡死）
    expect(result.exit_code).toBeNull();
  }, 10_000);

  it("进程树停止使用 taskkill /T 于 Windows（真实 killer）", async () => {
    // 仅验证调用契约：pid 为数字且不抛错
    const { systemTreeKiller } = await import("../../apps/executor/src/core/process.js");
    await expect(systemTreeKiller.killTree(2 ** 22, false)).resolves.toBeUndefined();
  });

  it("收集 stdout 与 stderr 分别返回", async () => {
    const runner = new FakeRunner(new FakeChild({ out: "OUT", err: "ERR" }));
    const result = await runProcess(
      { executable: "x", args: [], cwd: "." },
      { timeout_ms: 1000, runner, grace_ms: 10 },
    );
    expect(result.stdout).toBe("OUT");
    expect(result.stderr).toBe("ERR");
  });
});

describe("collectStream", () => {
  it("拼接 Uint8Array 分片为 UTF-8 字符串", async () => {
    const stream = (async function* () {
      yield Buffer.from("中", "utf8");
      yield Buffer.from("文", "utf8");
    })();
    expect(await collectStream(stream)).toBe("中文");
  });
});

describe("assertSafeArgv", () => {
  it("接受正常参数", () => {
    expect(() => assertSafeArgv("git", ["status", "--porcelain"])).not.toThrow();
  });

  it("拒绝含 NUL 的参数", () => {
    expect(() => assertSafeArgv("git", ["bad\0arg"])).toThrow(/NUL/);
  });
});

/* ------------------------------------------------------------------ *
 * diff 范围核对（规则 3）
 * ------------------------------------------------------------------ */

describe("globToRegExp", () => {
  it("`*` 不跨越目录分隔符", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/sub/a.ts")).toBe(false);
  });

  it("`**/` 可匹配零层或多层", () => {
    const re = globToRegExp("apps/executor/**/*.ts");
    expect(re.test("apps/executor/a.ts")).toBe(true);
    expect(re.test("apps/executor/src/a.ts")).toBe(true);
    expect(re.test("apps/executor/src/deep/a.ts")).toBe(true);
  });

  it("`/**` 匹配目录下全部内容", () => {
    const re = globToRegExp("docs/**");
    expect(re.test("docs/a.md")).toBe(true);
    expect(re.test("docs/sub/b.md")).toBe(true);
    expect(re.test("docsx/b.md")).toBe(false);
  });

  it("转义正则元字符", () => {
    const re = globToRegExp("a.b/c.ts");
    expect(re.test("a.b/c.ts")).toBe(true);
    expect(re.test("axb/c.ts")).toBe(false);
  });
});

describe("isPathAllowed", () => {
  const scope = {
    allow: ["apps/executor/**"],
    deny: ["apps/executor/secrets/**"],
  };

  it("allow 命中即通过", () => {
    expect(isPathAllowed("apps/executor/src/a.ts", scope)).toBe(true);
  });

  it("deny 优先于 allow（硬边界）", () => {
    expect(isPathAllowed("apps/executor/secrets/key.pem", scope)).toBe(false);
  });

  it("范围外拒绝", () => {
    expect(isPathAllowed("apps/coordinator/src/api.ts", scope)).toBe(false);
  });

  it("Windows 反斜杠路径被规范化后判定", () => {
    expect(isPathAllowed("apps\\executor\\src\\a.ts", scope)).toBe(true);
  });

  it("前导 ./ 被忽略", () => {
    expect(isPathAllowed("./apps/executor/src/a.ts", scope)).toBe(true);
  });
});

describe("findSensitiveTouches", () => {
  it("识别 .env 与私钥", () => {
    const hits = findSensitiveTouches([
      "apps/executor/src/a.ts",
      "apps/executor/.env",
      "keys/id_rsa",
      "certs/server.pem",
    ]);
    expect(hits).toContain("apps/executor/.env");
    expect(hits).toContain("keys/id_rsa");
    expect(hits).toContain("certs/server.pem");
    expect(hits).not.toContain("apps/executor/src/a.ts");
  });

  it("干净列表返回空", () => {
    expect(findSensitiveTouches(["src/a.ts", "docs/b.md"])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 路径包含判定（本机踩过的坑）
 * ------------------------------------------------------------------ */

describe("isInside", () => {
  it("相同路径视为包含", () => {
    expect(isInside("C:/a/b", "C:/a/b")).toBe(true);
  });

  it("前缀相似但不含分隔符的目录**不**算包含", () => {
    // "双端连接-sync" 不应被当作 "双端连接" 的子目录
    expect(isInside("C:/x/双端连接", "C:/x/双端连接-sync")).toBe(false);
  });

  it("真正的子目录算包含", () => {
    expect(isInside("C:/x/双端连接", "C:/x/双端连接/sub")).toBe(true);
  });

  it("中文与空格路径正确判定", () => {
    expect(isInside("C:/我的 项目", "C:/我的 项目/wt/a1")).toBe(true);
  });
});
