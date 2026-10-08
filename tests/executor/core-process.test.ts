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
  SystemTreeKiller,
  assertSafeArgv,
  collectStream,
  runProcess,
} from "../../apps/executor/src/core/process.js";
import type {
  ChildProcessHandle,
  KillCommandHandle,
  KillCommandRunner,
  KillOutcome,
  ProcessRunner,
  TreeKiller,
} from "../../apps/executor/src/core/process.js";
import { collectEvidence } from "../../apps/executor/src/core/evidence.js";
import { countsAsRepair, normalizeResult } from "../../apps/executor/src/result/normalize.js";
import {
  droppedEnvNames,
  isSensitiveEnvName,
  scrubbedChildEnv,
} from "../../apps/executor/src/core/child-env.js";
import type { OpenCodeAdapterResult } from "../../apps/executor/src/adapters/opencode.js";
import type { DiffCheckResult } from "../../apps/executor/src/core/diff-check.js";
import type { Lease } from "@dac/protocol";
import {
  checkDiffScope,
  findSensitiveTouches,
  globToRegExp,
  isPathAllowed,
  parseNameStatusZ,
} from "../../apps/executor/src/core/diff-check.js";
import { isInside } from "../../apps/executor/src/core/worktree.js";

/* ------------------------------------------------------------------ *
 * 有界返回断言工具（B7）
 *
 * 「函数一定会返回」是 P0 修复的核心承诺，所以断言不能是「等它返回」——
 * 那在缺陷复现时会直接把测试挂死到 vitest 超时。这里给出硬上限：
 * 到期未返回即抛错，失败信息直指「缺少有界返回」。
 * ------------------------------------------------------------------ */

async function withDeadline<T>(promise: Promise<T>, ms: number, label = "操作"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}未在 ${ms}ms 内返回（缺少有界返回）`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 永不结束的流：证明「不能等流关闭」不是理论问题。 */
function neverEndingStream(first: string): AsyncIterable<string> {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (!sent) {
            sent = true;
            return Promise.resolve({ value: first, done: false });
          }
          return new Promise<IteratorResult<string>>(() => {
            /* 永不结算 */
          });
        },
      };
    },
  };
}

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
    /**
     * true 表示 stdout **永不关闭**（B7）：即使进程退出，句柄也可能被
     * 子进程继承而一直开着。读流会永远收不到 done。
     */
    streamHangs?: boolean;
  }) {
    this.pid = options.pid ?? 4321;
    this.stdout = options.streamHangs
      ? neverEndingStream(options.out ?? "PARTIAL")
      : (async function* () {
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
  /** 本次停止动作的返回值（B7：killer 也要能报告自己的失败） */
  outcome: KillOutcome = { ok: true, detail: null };
  async killTree(pid: number, force: boolean): Promise<KillOutcome> {
    this.calls.push({ pid, force });
    if (this.stubborn) return this.outcome;
    if (force) this.child?.simulateKilled();
    return this.outcome;
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
        return { ok: true, detail: null };
      },
    };
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
    // B7：失败原因必须可观察，不能只留一个布尔值
    expect(result.kill_detail).toMatch(/强杀后进程仍未退出/);
  }, 10_000);

  it("进程树停止使用 taskkill /T 于 Windows（真实 killer）", async () => {
    // 只验证契约：调用有界返回，且返回**可判定**的结果对象。
    // 具体失败分类由注入 runner 的用例确定性覆盖（不依赖机器上真实进程表）。
    const { systemTreeKiller } = await import("../../apps/executor/src/core/process.js");
    const outcome = await withDeadline(systemTreeKiller.killTree(2 ** 22, false), 15_000, "killTree");
    expect(typeof outcome.ok).toBe("boolean");
    expect(outcome.ok === true || typeof outcome.detail === "string").toBe(true);
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

/* ------------------------------------------------------------------ *
 * B7：终止链必须有界（A 端 B6 评审 P0）
 *
 * A 端最小复现：注入不结束的退出承诺与输出流、一个不生效的 TreeKiller，
 * `timeout_ms=20`、`grace_ms=20`，等待 512ms 仍未返回。
 * 这里把同一场景固化成确定性回归，并**断言一定有界返回**。
 * ------------------------------------------------------------------ */

describe("runProcess 有界返回（B7）", () => {
  it("永不退出的进程 + 不生效的 killer + 永不关闭的流 → 有界返回并如实分类", async () => {
    const killer = new RecordingKiller();
    killer.stubborn = true; // killer 成功返回，但进程根本没死
    const child = new FakeChild({ pid: 8888, hang: true, streamHangs: true, out: "PARTIAL-OUT" });

    const result = await withDeadline(
      runProcess(
        { executable: "x", args: [], cwd: "." },
        {
          timeout_ms: 20,
          grace_ms: 20,
          drain_ms: 20,
          kill_timeout_ms: 20,
          runner: new FakeRunner(child),
          killer,
        },
      ),
      1_500,
      "runProcess",
    );

    expect(result.timed_out).toBe(true);
    expect(result.kill_failed).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.signal).toBeNull();
    // 已收到的部分输出不能丢：失败证据仍要能落盘
    expect(result.stdout).toBe("PARTIAL-OUT");
    expect(result.kill_detail).toMatch(/强杀后进程仍未退出/);
  });

  it("killer 调用自身挂住 → 仍然返回，原因写进 kill_detail", async () => {
    const hangingKiller: TreeKiller = {
      killTree: () =>
        new Promise<KillOutcome>(() => {
          /* 永不结算 */
        }),
    };
    const child = new FakeChild({ pid: 6666, hang: true, streamHangs: true });

    const result = await withDeadline(
      runProcess(
        { executable: "x", args: [], cwd: "." },
        {
          timeout_ms: 20,
          grace_ms: 20,
          drain_ms: 20,
          kill_timeout_ms: 30,
          runner: new FakeRunner(child),
          killer: hangingKiller,
        },
      ),
      2_000,
      "runProcess",
    );

    expect(result.timed_out).toBe(true);
    expect(result.kill_failed).toBe(true);
    expect(result.kill_detail).toMatch(/killer 未在 30ms 内返回/);
    expect(result.kill_detail).toMatch(/强杀后进程仍未退出/);
  });

  it("killer 报告自身失败（taskkill 非零退出）→ 失败原因可观察", async () => {
    const killer = new RecordingKiller();
    killer.stubborn = true;
    killer.outcome = { ok: false, detail: "taskkill 退出码 1：ERROR: Access is denied." };
    const child = new FakeChild({ pid: 5555, hang: true, streamHangs: true });

    const result = await withDeadline(
      runProcess(
        { executable: "x", args: [], cwd: "." },
        {
          timeout_ms: 20,
          grace_ms: 20,
          drain_ms: 20,
          kill_timeout_ms: 20,
          runner: new FakeRunner(child),
          killer,
        },
      ),
      1_500,
      "runProcess",
    );

    expect(result.kill_detail).toMatch(/taskkill 退出码 1/);
  });

  it("killer 抛异常 → 不掩盖超时分类", async () => {
    const killer: TreeKiller = {
      killTree: () => Promise.reject(new Error("boom")),
    };
    const child = new FakeChild({ pid: 4444, hang: true, streamHangs: true });

    const result = await withDeadline(
      runProcess(
        { executable: "x", args: [], cwd: "." },
        {
          timeout_ms: 20,
          grace_ms: 20,
          drain_ms: 20,
          kill_timeout_ms: 20,
          runner: new FakeRunner(child),
          killer,
        },
      ),
      1_500,
      "runProcess",
    );

    expect(result.timed_out).toBe(true);
    expect(result.kill_detail).toMatch(/killer 抛出异常：boom/);
  });

  it("进程已退出但 stdout 永不关闭 → 不等待流，有界返回且保留输出", async () => {
    const child = new FakeChild({ code: 0, out: "L1\nL2\n", streamHangs: true });

    const result = await withDeadline(
      runProcess(
        { executable: "x", args: [], cwd: "." },
        { timeout_ms: 1_000, grace_ms: 50, drain_ms: 50, runner: new FakeRunner(child) },
      ),
      1_500,
      "runProcess",
    );

    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.stdout).toBe("L1\nL2\n");
    expect(result.kill_detail).toMatch(/stdio 未在 50ms 内关闭/);
  });
});

describe("SystemTreeKiller 有界与可观察（B7）", () => {
  // 注入平台与 runner：让 Windows 分支（失败模式最集中的地方）在 Linux CI 上也能被验证
  const windows = { platform: "win32" as NodeJS.Platform, timeoutMs: 30 };

  it("taskkill 卡住 → 有界返回 ok:false，并中断该命令本身", async () => {
    let aborted = 0;
    const runner: KillCommandRunner = (): KillCommandHandle => ({
      done: new Promise(() => {
        /* 永不结算 */
      }),
      output: () => "",
      abort: () => {
        aborted += 1;
      },
    });
    const killer = new SystemTreeKiller({ ...windows, runner });

    const outcome = await withDeadline(killer.killTree(4242, true), 1_000, "killTree");

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/未在 30ms 内返回/);
    expect(aborted).toBe(1);
  });

  it("taskkill 非零退出 → ok:false，附退出码与输出摘要", async () => {
    const runner: KillCommandRunner = () => ({
      done: Promise.resolve({ code: 1, error: null }),
      output: () => "ERROR: Access is denied.",
      abort: () => undefined,
    });
    const outcome = await new SystemTreeKiller({ ...windows, runner }).killTree(1, true);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/退出码 1/);
    expect(outcome.detail).toMatch(/Access is denied/);
  });

  it("taskkill 报「进程不存在」→ 视为已结束，不算失败", async () => {
    const runner: KillCommandRunner = () => ({
      done: Promise.resolve({ code: 128, error: null }),
      output: () => 'ERROR: The process "1" not found.',
      abort: () => undefined,
    });
    const outcome = await new SystemTreeKiller({ ...windows, runner }).killTree(1, true);
    expect(outcome).toEqual({ ok: true, detail: null });
  });

  it("taskkill 未能启动 → ok:false，附启动错误", async () => {
    const runner: KillCommandRunner = () => ({
      done: Promise.resolve({ code: null, error: new Error("spawn taskkill ENOENT") }),
      output: () => "",
      abort: () => undefined,
    });
    const outcome = await new SystemTreeKiller({ ...windows, runner }).killTree(1, false);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/未能启动/);
  });

  it("taskkill 正常结束 → ok:true", async () => {
    const runner: KillCommandRunner = () => ({
      done: Promise.resolve({ code: 0, error: null }),
      output: () => "",
      abort: () => undefined,
    });
    const outcome = await new SystemTreeKiller({ ...windows, runner }).killTree(1, true);
    expect(outcome).toEqual({ ok: true, detail: null });
  });
});

/* ------------------------------------------------------------------ *
 * B7 端到端：超时不得产生 ready_for_integration
 * ------------------------------------------------------------------ */

const B7_LEASE: Lease = {
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-DESKTOP",
  lease_epoch: 3,
  expires_at: "2026-09-21T12:00:00.000Z",
  binding: {
    base_sha: "a577d66",
    rules_sha: "a577d66",
    contract_sha: "a577d66",
    acceptance_sha: "a577d66",
  },
  agent_kind: "opencode",
};

function b7Adapter(): OpenCodeAdapterResult {
  return {
    status: "completed",
    error_code: null,
    exit_code: 0,
    timed_out: false,
    session_id: "ses_x",
    final_message: "done",
    event_counts: { step_start: 1, text: 1, step_finish: 1 },
    tokens: { total: 100, input: 80, output: 20, reasoning: 0 },
    cost: 0,
    stdout_sha256: "a".repeat(64),
    stderr_sha256: "b".repeat(64),
    invalid_json_lines: 0,
    request_url: null,
  };
}

const B7_DIFF: DiffCheckResult = {
  changed_files: ["apps/executor/src/a.ts"],
  violations: [],
  ok: true,
  has_uncommitted: false,
  // B8：显式 null = 核对成功
  error: null,
};

describe("超时进程不得产生 ready_for_integration（B7 端到端）", () => {
  it("测试进程永不退出 → 证据按失败处理，归一化降级为 repair_pending", async () => {
    const child = new FakeChild({
      pid: 3210,
      hang: true,
      streamHangs: true,
      out: "   Tests  0 passed (0)\n",
    });
    // 优雅停止即生效，但**拿不到退出码**：进程被杀，输出流仍开着
    const killer: TreeKiller = {
      killTree: () => {
        child.simulateKilled();
        return Promise.resolve({ ok: true, detail: null });
      },
    };

    const collected = await withDeadline(
      collectEvidence(
        { command: ["npm", "test"], cwd: ".", timeout_ms: 20, evidence_id: "EVID-TASK-0001-A1-1" },
        { runner: new FakeRunner(child), killer },
      ),
      3_000,
      "collectEvidence",
    );

    // 未取得退出码 → 不得按成功记账，汇总也认不出（0/0/0 且标记未解析）
    expect(collected.evidence.exit_code).not.toBe(0);
    expect(collected.summary_parsed).toBe(false);
    // 终止异常必须一路带出来：否则云端只看到 exit_code=1，看不出是进程杀不掉
    expect(collected.termination_detail).toMatch(/stdio 未在 1000ms 内关闭/);

    const report = normalizeResult({
      lease: B7_LEASE,
      adapter: b7Adapter(),
      diff: B7_DIFF,
      evidence: collected.evidence,
      base_sha: "a577d66",
      head_sha: "327d311",
      sensitive_touches: [],
      commit_shas: ["327d311"],
      note: `测试进程终止异常：${collected.termination_detail}`,
      reported_at: "2026-09-21T12:00:00.000Z",
    });

    expect(report.status).toBe("repair_pending");
    expect(report.error_code).toBe("TESTS_FAILED");
    expect(report.status).not.toBe("ready_for_integration");
    // 上报备注里必须能看到终止异常，否则人工无从判断要不要介入
    expect(report.note).toMatch(/测试进程终止异常/);
    expect(report.note).toMatch(/stdio 未在 1000ms 内关闭/);
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

/* ------------------------------------------------------------------ *
 * B8 · B7-3 子进程不得继承协调器凭据
 *
 * 缺陷：`process.ts` 原样把 `process.env` 交给子进程，于是测试子进程
 * 与 agent 拉起的任何进程都能读到 COORDINATOR_API_TOKEN。
 * 判据（A 端要求）：用**假 Token** 证明子进程与输出里都读不到它。
 * ------------------------------------------------------------------ */

describe("子进程环境过滤（B8 · B7-3）", () => {
  it("只挡凭据，不动必需变量与业务变量", () => {
    // 必须挡
    for (const name of [
      "COORDINATOR_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_PAT",
      "GITHUB_ENTERPRISE_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AZURE_CLIENT_SECRET",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]) {
      expect(isSensitiveEnvName(name), name).toBe(true);
    }
    // 必须留：系统与工具链必需项
    for (const name of [
      "PATH",
      "Path",
      "SystemRoot",
      "TEMP",
      "HOME",
      "APPDATA",
      "OPENCODE_MODEL",
      "EXECUTOR_ID",
      "COORDINATOR_BASE_URL",
    ]) {
      expect(isSensitiveEnvName(name), name).toBe(false);
    }
    // 刻意**不**做全量屏蔽：agent 自己连模型服务要用的变量不能删，
    // 否则就是「用新故障换旧漏洞」。
    expect(isSensitiveEnvName("MY_PROVIDER_API_KEY")).toBe(false);
    expect(isSensitiveEnvName("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("scrubbedChildEnv 同时过滤『继承』与『显式注入』两路", () => {
    const env = scrubbedChildEnv(
      {
        PATH: "/usr/bin",
        COORDINATOR_API_TOKEN: "must-not-pass",
        GH_TOKEN: "must-not-pass",
      },
      {
        CUSTOM_FLAG: "ok",
        CLOUDFLARE_API_TOKEN: "must-not-pass-either",
      },
    );
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["CUSTOM_FLAG"]).toBe("ok");
    expect(env["COORDINATOR_API_TOKEN"]).toBeUndefined();
    expect(env["GH_TOKEN"]).toBeUndefined();
    // 显式注入不是旁路
    expect(env["CLOUDFLARE_API_TOKEN"]).toBeUndefined();
  });

  it("droppedEnvNames 只报名字，不报值", () => {
    const dropped = droppedEnvNames({
      PATH: "/usr/bin",
      COORDINATOR_API_TOKEN: "super-secret-value",
      GITHUB_TOKEN: "another-secret",
    });
    expect(dropped).toEqual(["COORDINATOR_API_TOKEN", "GITHUB_TOKEN"]);
    expect(dropped.join(",")).not.toContain("super-secret-value");
  });

  it("**真实子进程**读不到假 Token，输出的任何位置都不出现它", async () => {
    const FAKE = "fake-coordinator-token-b8-never-leak";
    const FAKE_GH = "fake-gh-token-b8-never-leak";
    const savedToken = process.env["COORDINATOR_API_TOKEN"];
    const savedGh = process.env["GH_TOKEN"];
    process.env["COORDINATOR_API_TOKEN"] = FAKE;
    process.env["GH_TOKEN"] = FAKE_GH;

    try {
      const result = await runProcess(
        {
          executable: process.execPath,
          args: [
            "-e",
            [
              'process.stdout.write("token=" + String(process.env.COORDINATOR_API_TOKEN));',
              'process.stderr.write("gh=" + String(process.env.GH_TOKEN));',
            ].join(""),
          ],
          cwd: process.cwd(),
        },
        { timeout_ms: 20_000 },
      );

      expect(result.exit_code).toBe(0);
      // 子进程读到的必须是 undefined
      expect(result.stdout).toContain("token=undefined");
      expect(result.stderr).toContain("gh=undefined");
      // 假 Token 不得出现在任何输出里（这正是「进入 artifact 与上报」的入口）
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toContain(FAKE);
      expect(combined).not.toContain(FAKE_GH);
    } finally {
      if (savedToken === undefined) delete process.env["COORDINATOR_API_TOKEN"];
      else process.env["COORDINATOR_API_TOKEN"] = savedToken;
      if (savedGh === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = savedGh;
    }
  }, 60_000);

  it("过滤没有把必需变量一起删掉（真实子进程仍能跑起来读到 PATH）", async () => {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: ["-e", 'process.stdout.write(process.env.PATH || process.env.Path ? "PATH_OK" : "PATH_MISSING")'],
        cwd: process.cwd(),
      },
      { timeout_ms: 20_000 },
    );
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("PATH_OK");
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * B8 · B7-3 敏感文件边界（A 端给的四个样例必须全部命中）
 * ------------------------------------------------------------------ */

describe("敏感文件边界（B8 · B7-3）", () => {
  it("A 端复现的四个样例全部命中（原先只有 .env 命中）", () => {
    const cases = [
      "apps/executor/.env",
      "apps/executor/.ENV",
      "B-token-public.cer",
      "apps/executor/.codex/config.toml",
    ];
    const hits = findSensitiveTouches(cases);
    // 逐个断言，失败时能看出是哪一个漏了
    expect(hits).toContain("apps/executor/.env");
    expect(hits).toContain("apps/executor/.ENV");
    expect(hits).toContain("B-token-public.cer");
    expect(hits).toContain("apps/executor/.codex/config.toml");
    expect(hits).toHaveLength(cases.length);
  });

  it("大小写变体与非 ASCII 路径同样命中", () => {
    expect(findSensitiveTouches(["AUTH.JSON"])).toContain("AUTH.JSON");
    expect(findSensitiveTouches(["keys/Server.KEY"])).toContain("keys/Server.KEY");
    expect(findSensitiveTouches(["凭据/B-token-public.CER"])).toContain("凭据/B-token-public.CER");
  });

  it("凭据容器与本地凭据目录全部命中", () => {
    for (const path of [
      "x/B-executor-token.p7m",
      "x/client.pfx",
      "x/cert.p12",
      "x/store.jks",
      ".ssh/id_ed25519",
      ".aws/credentials",
      ".npmrc",
      ".netrc",
      "conf/secrets.json",
    ]) {
      expect(findSensitiveTouches([path]), path).toContain(path);
    }
  });

  it("正常源文件不被误判（避免把正常任务卡住）", () => {
    expect(
      findSensitiveTouches([
        "apps/executor/src/child-env.ts",
        "tests/executor/redact-secret.test.ts",
        "docs/reports/B8-B-executor-hardening.md",
      ]),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * B8 · B7-2 变更列表解析（NUL 分隔、重命名两侧）
 * ------------------------------------------------------------------ */

describe("parseNameStatusZ（B8 · B7-2）", () => {
  it("普通变更与重命名都解析出路径", () => {
    expect(parseNameStatusZ("M\0a.ts\0")).toEqual(["a.ts"]);
    expect(parseNameStatusZ("A\0new.ts\0")).toEqual(["new.ts"]);
    // 重命名：**源与目标都要**
    expect(parseNameStatusZ("R100\0old.ts\0new.ts\0")).toEqual(["old.ts", "new.ts"]);
    expect(parseNameStatusZ("C075\0src.ts\0copy.ts\0")).toEqual(["src.ts", "copy.ts"]);
  });

  it("多条记录连续解析互不串位", () => {
    expect(parseNameStatusZ("M\0a.ts\0R100\0b.ts\0c.ts\0D\0d.ts\0")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
    ]);
  });

  it("含空格与非 ASCII 的路径不被拆开（这正是 -z 的目的）", () => {
    expect(parseNameStatusZ("M\0双端 连接/a.ts\0")).toEqual(["双端 连接/a.ts"]);
    expect(parseNameStatusZ("R100\0旧 目录/a.ts\0新 目录/a.ts\0")).toEqual([
      "旧 目录/a.ts",
      "新 目录/a.ts",
    ]);
  });

  it("空输出返回空数组", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * B8 · B7-2 核对失败必须 fail-closed
 *
 * A 端复现：在不存在的仓库路径调用 `checkDiffScope()` 得到
 * `ok: true` + 空违规列表 —— 那不是「通过」，而是「根本没检查」。
 * ------------------------------------------------------------------ */

type FakeGitScript = (
  args: readonly string[],
) => { exit_code: number; stdout: string; stderr: string } | null;

const SCOPE_B8 = { allow: ["apps/executor/**"], deny: [] } as const;
const WORKTREE_B8 = "C:/repo";

/**
 * 构造一个假 Git：未命中的命令默认「成功且无输出」，
 * 但 `rev-parse --show-toplevel` 必须如实回答 —— 否则会先被
 * 「工作区根校验」拦下，测不到后面那些分支。
 */
function fakeGit(script: FakeGitScript) {
  return (_repoPath: string, args: readonly string[]) => {
    const custom = script(args);
    if (custom !== null) return custom;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { exit_code: 0, stdout: `${WORKTREE_B8}\n`, stderr: "" };
    }
    return { exit_code: 0, stdout: "", stderr: "" };
  };
}

describe("checkDiffScope fail-closed（B8 · B7-2）", () => {
  it("仓库路径无效 → ok:false 且带 error（原先返回 ok:true）", () => {
    const result = checkDiffScope(
      { worktree_path: "C:/does/not/exist", base_sha: "a".repeat(40), scope: SCOPE_B8 },
      fakeGit(() => ({
        exit_code: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a git repository");
    // 不能把「没检查成」伪装成「没有变更」
    expect(result.changed_files).toEqual([]);
    expect(result.violations).toEqual([]);
  });

  it("worktree 不是自己的工作区根（被父仓库顶替）→ ok:false", () => {
    const result = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: "a".repeat(40), scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "rev-parse" && args[1] === "--show-toplevel"
          ? { exit_code: 0, stdout: "C:/parent-repo\n", stderr: "" }
          : null,
      ),
    );
    expect(result.ok).toBe(false);
    // 这种「错的对象给出了看似合理的结论」比直接失败更危险，必须拦住
    expect(result.error).toContain("不一致");
  });

  it("基线不存在 → ok:false + error", () => {
    const base = "0".repeat(40);
    const result = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: base, scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "diff" && args.includes(`${base}..HEAD`)
          ? { exit_code: 128, stdout: "", stderr: `fatal: bad object ${base}` }
          : null,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bad object");
  });

  it("仅 git status 失败也必须 fail-closed（不得当成工作区干净）", () => {
    const result = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: "a".repeat(40), scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "status"
          ? { exit_code: 128, stdout: "", stderr: "fatal: index file corrupt" }
          : null,
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("git status");
    expect(result.has_uncommitted).toBe(false);
  });

  it("全部成功且无越界 → ok:true、error:null", () => {
    const base = "a".repeat(40);
    const result = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: base, scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "diff" && args.includes(`${base}..HEAD`)
          ? { exit_code: 0, stdout: "M\0apps/executor/src/a.ts\0", stderr: "" }
          : null,
      ),
    );
    expect(result.changed_files).toEqual(["apps/executor/src/a.ts"]);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
  });

  it("跨范围重命名被判越界（源路径也要查）", () => {
    const base = "a".repeat(40);
    const result = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: base, scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "diff" && args.includes(`${base}..HEAD`)
          ? {
              exit_code: 0,
              stdout: "R100\0apps/coordinator/src/x.ts\0apps/executor/src/x.ts\0",
              stderr: "",
            }
          : null,
      ),
    );
    expect(result.changed_files).toEqual([
      "apps/coordinator/src/x.ts",
      "apps/executor/src/x.ts",
    ]);
    expect(result.violations).toContain("apps/coordinator/src/x.ts");
    expect(result.ok).toBe(false);
    // 这次核对本身是成功的：越界是结论，不是核对失败
    expect(result.error).toBeNull();
  });

  it("未跟踪文件也计入变更（ls-files 失败同样 fail-closed）", () => {
    const base = "a".repeat(40);
    const withUntracked = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: base, scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "ls-files"
          ? { exit_code: 0, stdout: "apps/coordinator/src/sneaky.ts\0", stderr: "" }
          : null,
      ),
    );
    expect(withUntracked.changed_files).toContain("apps/coordinator/src/sneaky.ts");
    expect(withUntracked.violations).toContain("apps/coordinator/src/sneaky.ts");

    const lsFails = checkDiffScope(
      { worktree_path: WORKTREE_B8, base_sha: base, scope: SCOPE_B8 },
      fakeGit((args) =>
        args[0] === "ls-files"
          ? { exit_code: 1, stdout: "", stderr: "fatal: ls-files exploded" }
          : null,
      ),
    );
    expect(lsFails.ok).toBe(false);
    expect(lsFails.error).toContain("ls-files");
  });
});

/* ------------------------------------------------------------------ *
 * B8 · B7-2 归一化层：核对失败不得声称可整合
 * ------------------------------------------------------------------ */

describe("归一化层对 Git 核对失败的处置（B8 · B7-2）", () => {
  const LEASE_B8: Lease = {
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    executor_id: "EXE-B-OPENCODE",
    lease_epoch: 1,
    expires_at: "2030-01-01T00:00:00.000Z",
    binding: {
      base_sha: "a".repeat(40),
      rules_sha: "b".repeat(40),
      contract_sha: "c".repeat(40),
      acceptance_sha: "d".repeat(40),
    },
    agent_kind: "opencode",
  };

  it("diff.error 非空 → failed + INTERNAL_ERROR（不进入返修计数）", () => {
    const report = normalizeResult({
      lease: LEASE_B8,
      adapter: b7Adapter(),
      diff: {
        changed_files: [],
        violations: [],
        ok: false,
        has_uncommitted: false,
        error: "fatal: not a git repository",
      },
      evidence: null,
      base_sha: LEASE_B8.binding.base_sha,
      head_sha: "e".repeat(40),
      sensitive_touches: [],
      commit_shas: ["e".repeat(40)],
      note: null,
      reported_at: "2026-09-28T00:00:00.000Z",
    });
    expect(report.status).toBe("failed");
    expect(report.error_code).toBe("INTERNAL_ERROR");
    // 备注要说明「为什么无法核对」，否则云端只看到一个泛化的错误码
    expect(report.note).toContain("Git 核对失败");
    // INTERNAL_ERROR 是 fatal：不得计为代码返修
    expect(countsAsRepair(report)).toBe(false);
  });
});
