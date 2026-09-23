/**
 * 真实链路集成测试（B5）。
 *
 * ## 为什么必须有这一层
 * 评审单原文：「**仅增加 mock 顺序断言不够**」。
 * B4 的 `daemon.test.ts` 注入的是假 `attempt_runner` 与假 `push_branch`，
 * 它们从不访问真实目录，因此**看不见**三个真实缺陷：
 * - worktree 在 `git push` 之前就被删掉（P0-1）
 * - 没有任何提交被创建，推送只推回基线（P0-2）
 * - 推送只看退出码，不核对远端 SHA（P0-3）
 *
 * 本文件用**真实临时 Git 仓库 + 真实 worktree + 本地 bare remote**，
 * 让这些缺陷一旦回归就必然失败。
 *
 * ## 覆盖评审单「B5 必须增加的真实测试」
 * | # | 要求 | 用例 |
 * | --- | --- | --- |
 * | 1 | 真实仓库/工作树/bare remote；未提交改动 → 检查 → 提交 → 推送；远端 SHA 与本地 HEAD 完全一致；推送时 worktree 仍存在 | §1 |
 * | 2 | 远端 SHA 不一致或 `ls-remote` 失败时，结果不得是 `ready_for_integration` | §3 |
 * | 3 | `enable_push=false` 时不得上报 `ready_for_integration` | §4 |
 * | 4 | `still_mine` 恢复时不进入领取循环并保留记录 | `daemon.test.ts` §8（已覆盖，此处不重复） |
 * | 5 | 默认运行不删除 worktree 与在途记录 | §5 |
 * | 6 | 真实链路不得绕过 diff、敏感文件、租约与测试证据检查 | §2 |
 *
 * ## 本文件额外逼出的三个缺陷（评审单未列出）
 * | 缺陷 | 现象 | 修复 |
 * | --- | --- | --- |
 * | 1 | `runProcess` 无条件空等满超时 | `core/process.ts` 改为「退出/超时谁先到听谁的」 |
 * | 2 | 假 agent 只注入了 `runAttempt`，**没注入常驻入口** | `DaemonDeps.agent_runner` 透传 |
 * | 3 | `spawn` 失败（`ENOENT`）时句柄永不结束 → 执行器永久死等 | `adapters/opencode.ts` 与 `core/process.ts` 增加启动失败通道，§6 锁定 |
 *
 * ## 关于「假 agent」
 * 唯一被替换的是 **OpenCode 进程本身**（本机不调用真实模型，也不烧配额）。
 * Git、worktree、提交、推送、`ls-remote`、证据收集**全部是真的**。
 * 这正是评审单要求的口径：真实的是工程链路，不是模型调用。
 *
 * ## 与真实工作区的隔离
 * 全部在系统临时目录内建仓，不触碰 `C:\Users\lenovo\Desktop\双端连接`。
 * 每个用例结束时整棵临时树被删除，不留下 worktree 注册残留。
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { ResultReportSchema } from "@dac/protocol";
import type { Lease, ResultReport, TaskNode, WriteScope } from "@dac/protocol";

import { runAttempt } from "../../apps/executor/src/core/attempt.js";
import type { AttemptDeps, AttemptRunner } from "../../apps/executor/src/core/attempt.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { LeaseClock, LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { InFlightRecord, RecoveryTransport } from "../../apps/executor/src/core/recovery.js";
import { git, resolveGitExecutable } from "../../apps/executor/src/core/worktree.js";
import type { OpenCodeProcessRunner } from "../../apps/executor/src/adapters/opencode.js";
import { NodeOpenCodeProcessRunner, runOpenCodeTask } from "../../apps/executor/src/adapters/opencode.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationAck,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import { fileInFlightStore, gitPushBranch, inFlightPath, readRemoteBranchSha, runDaemon } from "../../apps/executor/src/daemon.js";
import type { DaemonDeps, DaemonOptions } from "../../apps/executor/src/daemon.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const TOKEN = "real-chain-secret-token";
const WORKTREE_ROOT_SEGMENTS = [".local", "worktrees"];

/** 产出的测试输出。必须是 `evidence.ts` 能解析的 vitest 形状。 */
const TEST_OUTPUT = "Tests  4 passed (4)";

/**
 * 真实临时仓库三件套：
 * - `root`：主仓库（执行器在这里开 worktree）
 * - `bare`：本地 bare remote（评审单要求，不接触真实网络）
 * - `base_sha`：任务基线
 */
interface RealRepo {
  root: string;
  bare: string;
  base_sha: string;
}

const created: string[] = [];

function track(dir: string): string {
  created.push(dir);
  return dir;
}

afterEach(() => {
  // 每个用例结束整棵临时树删除；worktree 注册随主仓库一起消失。
  while (created.length > 0) {
    const dir = created.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 在临时目录里 git init 并落一个基线提交。 */
function makeRealRepo(): RealRepo {
  const root = track(mkdtempSync(join(tmpdir(), "dac-real-")));
  const bare = track(mkdtempSync(join(tmpdir(), "dac-bare-")));

  must(root, ["init", "-q"]);
  must(root, ["config", "user.email", "b@example.invalid"]);
  must(root, ["config", "user.name", "B Real Chain"]);
  must(root, ["config", "commit.gpgsign", "false"]);
  // 关掉自动换行转换，避免 Windows 上 diff 因 CRLF 抖动
  must(root, ["config", "core.autocrlf", "false"]);

  writeFileSync(join(root, "README.md"), "# 真实链路测试仓库\n", "utf8");
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "index.ts"), "export const value = 1;\n", "utf8");
  must(root, ["add", "-A"]);
  must(root, ["commit", "-q", "-m", "init"]);

  execFileSync(resolveGitExecutable(), ["init", "--bare", "-q", bare], {
    windowsHide: true,
    stdio: "ignore",
  });
  must(root, ["remote", "add", "origin", bare]);

  return { root, bare, base_sha: must(root, ["rev-parse", "HEAD"]).trim() };
}

function must(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.exit_code !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败（退出码 ${result.exit_code}）：${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function show(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  return result.exit_code === 0 ? result.stdout.trim() : "";
}

/** 构造一个与真实仓库基线匹配的租约。 */
function makeLease(repo: RealRepo): Lease {
  return {
    task_id: "TASK-0001",
    attempt_id: "TASK-0001-A1",
    executor_id: "EXE-B-OPENCODE",
    lease_epoch: 1,
    // 远端时间足够远，测试期间不可能过期
    expires_at: "2030-01-01T00:00:00.000Z",
    binding: {
      base_sha: repo.base_sha,
      rules_sha: repo.base_sha,
      contract_sha: repo.base_sha,
      acceptance_sha: repo.base_sha,
    },
    agent_kind: "opencode",
  };
}

function makeTask(writeScope: WriteScope): TaskNode {
  return {
    task_id: "TASK-0001",
    kind: "implement",
    title: "真实链路：改动 apps/demo",
    acceptance_criteria: ["测试全绿"],
    depends_on: [],
    write_scope: writeScope,
    contracts: [],
    requires: ["code"],
    expected_interfaces: [],
    status: "leased",
    assigned_executor: "EXE-B-OPENCODE",
    attempts_used: 1,
  };
}

/**
 * 假 OpenCode 进程：只做一件事——**在真实 worktree 里写文件**。
 *
 * 这是「agent 产生了未提交改动」这一真实场景的最小复现；
 * 其余（检查/提交/推送/核对）全部由真实代码完成。
 */
function writingAgent(files: Readonly<Record<string, string>>): OpenCodeProcessRunner {
  return {
    start(_executable: string, _args: readonly string[], cwd: string) {
      for (const [relative, content] of Object.entries(files)) {
        const target = join(cwd, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      }
      return {
        stdout: (async function* empty() {})(),
        stderr: (async function* empty() {})(),
        exit_code: Promise.resolve(0),
        kill: () => undefined,
      };
    },
  };
}

/** 只会 sleep 很短时间的时钟：让续租/心跳循环不拖慢测试。 */
const fastClock: LeaseClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))),
};

function makeAttemptDeps(agent_runner: OpenCodeProcessRunner): AttemptDeps {
  return {
    lease_transport: {
      async renew(): Promise<RenewOutcome> {
        return { kind: "renewed", expires_at: "2030-01-01T00:00:00.000Z", lease_epoch: 1 };
      },
    },
    heartbeat_transport: {
      async send(_request: HeartbeatRequest): Promise<void> {
        /* 心跳不改变任务状态 */
      },
    },
    clock: fastClock,
    agent_runner,
  };
}

const TEST_COMMAND = {
  executable: process.execPath,
  args: ["-e", `console.log(${JSON.stringify(TEST_OUTPUT)})`],
};

/* ------------------------------------------------------------------ *
 * 常驻入口的真实装配
 * ------------------------------------------------------------------ */

type AcquireStep = LeaseAcquisition | { fail: unknown };

interface RealHarness {
  options: DaemonOptions;
  deps: DaemonDeps;
  reports: ResultReport[];
  pushes: Array<{ worktree_path: string; branch: string; remote: string }>;
  /** 每次推送发生时，worktree 目录是否仍然存在（P0-1 的核心证据） */
  worktreeExistedAtPush: boolean[];
  logs: string[];
  saved: InFlightRecord[];
  acquireCalls: () => number;
}

/**
 * 装配一个**除协调器传输外全部真实**的常驻入口。
 *
 * 真实的部分：`attempt_runner = runAttempt`（真 worktree/提交/证据）、
 * `push_branch = gitPushBranch`（真 push + 真 `ls-remote` 核对）、
 * `repo_root`/`worktree_root`（真目录）、在途记录（真文件）。
 * 假的只有协调器 HTTP 与 OpenCode 进程。
 */
function makeRealHarness(
  repo: RealRepo,
  script: AcquireStep[],
  files: Readonly<Record<string, string>>,
  overrides: Partial<DaemonOptions> = {},
  /**
   * agent 进程启动器。默认用一个**只写文件**的假 agent（本机不装
   * `opencode`，也不烧模型配额）。传 `null` 表示「不注入」，
   * 常驻入口会退回真实 `opencode` 可执行文件——这正是 §6 要测的场景。
   */
  agentRunner: OpenCodeProcessRunner | null = writingAgent(files),
): RealHarness {
  const reports: ResultReport[] = [];
  const pushes: RealHarness["pushes"] = [];
  const worktreeExistedAtPush: boolean[] = [];
  const logs: string[] = [];
  const saved: InFlightRecord[] = [];
  const steps = [...script];
  let acquireCount = 0;

  const acquirer: LeaseAcquirer = {
    async acquire(): Promise<LeaseAcquisition> {
      acquireCount += 1;
      const step = steps.shift();
      if (step === undefined) return { kind: "empty" };
      if (typeof step === "object" && step !== null && "fail" in step) throw step.fail;
      return step as LeaseAcquisition;
    },
  };

  const options: DaemonOptions = {
    config: {
      base_url: "https://coordinator.example.invalid",
      project_id: "PROJECT-REAL",
      executor_id: "EXE-B-OPENCODE",
      token: TOKEN,
    },
    registration: {
      host_label: "b-real-chain",
      agent_kind: "opencode",
      capabilities: ["code", "test", "git_push"],
    },
    repo_root: repo.root,
    worktree_root: join(repo.root, ...WORKTREE_ROOT_SEGMENTS),
    model: "myapi/test-model",
    test_command: TEST_COMMAND,
    heartbeat_interval_ms: 50,
    max_idle_polls: 1,
    remote: "origin",
    log: (line) => logs.push(line),
    ...overrides,
  };

  const store = fileInFlightStore(repo.root);

  const deps: DaemonDeps = {
    health: async () => ({ ok: true }),
    registration: {
      async register(): Promise<RegistrationAck> {
        return { executor_id: "EXE-B-OPENCODE", registered: true };
      },
    } satisfies RegistrationTransport,
    acquirer,
    lease_transport: {
      async renew(): Promise<RenewOutcome> {
        return { kind: "renewed", expires_at: "2030-01-01T00:00:00.000Z", lease_epoch: 1 };
      },
    },
    heartbeat_transport: {
      async send(): Promise<void> {
        /* 心跳不改变任务状态 */
      },
    },
    recovery_transport: {
      async queryOwnership() {
        return { kind: "unknown_task" } as Awaited<
          ReturnType<RecoveryTransport["queryOwnership"]>
        >;
      },
    } satisfies RecoveryTransport,
    result_reporter: {
      async report(report: ResultReport): Promise<ReportAck> {
        reports.push(report);
        return { accepted: true, task_id: report.task_id, status: report.status };
      },
    } satisfies ResultReporter,
    // —— 真实实现（这两行是本文件存在的意义）——
    attempt_runner: runAttempt as AttemptRunner,
    push_branch: (input) => {
      pushes.push(input);
      worktreeExistedAtPush.push(existsSync(input.worktree_path));
      return gitPushBranch(input);
    },
    // agent 进程必须**注入到常驻入口这一层**：`runAttempt` 的默认实现会退回
    // 真实 `opencode`。此前只注入到直接调用 `runAttempt` 的用例里，
    // 经常驻入口的用例事实上仍在 `spawn opencode`。
    ...(agentRunner !== null ? { agent_runner: agentRunner } : {}),
    clock: fastClock,
    load_in_flight: store.load_in_flight,
    save_in_flight: store.save_in_flight,
  };

  return {
    options,
    deps,
    reports,
    pushes,
    worktreeExistedAtPush,
    logs,
    saved,
    acquireCalls: () => acquireCount,
  };
}

/* ================================================================== *
 * §1 评审单测试 1：真实链路「未提交改动 → 检查 → 提交 → 推送 → 远端核对」
 * ================================================================== */

describe("B5 §1 真实链路：未提交改动 → 提交 → 推送 → 远端 SHA 核对", () => {
  it(
    "agent 只改文件不提交；执行器提交并推送，远端 SHA 与本地 HEAD 完全一致，且推送时 worktree 仍存在",
    async () => {
      const repo = makeRealRepo();
      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        { "apps/demo/feature.ts": "export const feature = 42;\n" },
        { enable_push: true },
      );

      const report = await runDaemon(h.options, h.deps);
      const worktreePath = join(h.options.worktree_root, "TASK-0001-A1");
      const branch = "task/TASK-0001/TASK-0001-A1";

      /* --- 推送真的发生了，而且推送**当时** worktree 还在（P0-1）--- */
      expect(h.pushes).toHaveLength(1);
      expect(h.pushes[0]!.worktree_path).toBe(worktreePath);
      expect(h.worktreeExistedAtPush[0]).toBe(true);

      /* --- 执行器**创建了提交**，而不是只推回基线（P0-2）--- */
      const localHead = show(worktreePath, ["rev-parse", "HEAD"]);
      expect(localHead).toHaveLength(40);
      expect(localHead).not.toBe(repo.base_sha);

      /* --- 远端任务分支 SHA 与本地 HEAD 完全一致（P0-3）--- */
      // ① 用被检代码读一次
      const remote = readRemoteBranchSha(repo.root, "origin", branch);
      expect(remote.error).toBeNull();
      expect(remote.sha).toBe(localHead);
      // ② 用**独立路径**再证一次：直接读 bare 仓库的 ref，绕过执行器的所有代码
      expect(show(repo.bare, ["rev-parse", `refs/heads/${branch}`])).toBe(localHead);

      /* --- 提交消息符合 `<TASK_ID>: <简述>`，正文记录 attempt 与冻结版本 --- */
      const subject = show(worktreePath, ["log", "-1", "--format=%s"]);
      expect(subject).toBe("TASK-0001: 真实链路：改动 apps/demo");
      const body = show(worktreePath, ["log", "-1", "--format=%b"]);
      expect(body).toContain("attempt: TASK-0001-A1");
      expect(body).toContain(repo.base_sha);

      /* --- 上报内容与真实事实一致，且是合法协议对象 --- */
      expect(h.reports).toHaveLength(1);
      const sent = h.reports[0]!;
      expect(sent.status).toBe("ready_for_integration");
      expect(sent.head_sha).toBe(localHead);
      expect(sent.commit_shas).toEqual([localHead]);
      expect(sent.base_sha).toBe(repo.base_sha);
      expect(sent.changed_files).toContain("apps/demo/feature.ts");
      // 协议层校验：整条链路产出的报告必须过 ResultReportSchema
      const parsed = ResultReportSchema.safeParse(sent);
      expect(parsed.success).toBe(true);

      /* --- 默认不清理 worktree，也不删除在途记录（P0-1 / P1-2，测试 5）--- */
      expect(existsSync(worktreePath)).toBe(true);
      const recordFile = inFlightPath(repo.root);
      expect(existsSync(recordFile)).toBe(true);
      const record = JSON.parse(readFileSync(recordFile, "utf8")) as InFlightRecord;
      expect(record.state).toBe("reported");

      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]!.pushed).toBe(true);
      expect(report.attempts[0]!.report_status).toBe("ready_for_integration");
    },
    120_000,
  );

  it(
    "cleanup_worktree=true 时，清理也只发生在推送与远端核对**之后**",
    async () => {
      const repo = makeRealRepo();
      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        { "apps/demo/feature.ts": "export const feature = 1;\n" },
        { enable_push: true, cleanup_worktree: true },
      );

      await runDaemon(h.options, h.deps);
      const worktreePath = join(h.options.worktree_root, "TASK-0001-A1");

      // 推送那一刻目录必须还在（这是 B4 出错的地方）
      expect(h.worktreeExistedAtPush[0]).toBe(true);
      // 远端确实拿到了提交，然后才轮到清理
      expect(show(repo.bare, ["rev-parse", "refs/heads/task/TASK-0001/TASK-0001-A1"])).toHaveLength(40);
      expect(existsSync(worktreePath)).toBe(false);
      expect(h.logs.some((line) => line.includes("清理点在推送与上报之后"))).toBe(true);
    },
    120_000,
  );
});

/* ================================================================== *
 * §2 评审单测试 6：真实链路不得绕过 diff / 敏感文件 / 证据检查
 * ================================================================== */

describe("B5 §2 真实链路不得绕过既有检查", () => {
  it(
    "越界文件 → **不创建提交**，报告降级 repair_pending / DIFF_OUT_OF_SCOPE",
    async () => {
      const repo = makeRealRepo();
      const lease = makeLease(repo);
      const outcome = await runAttempt(
        {
          lease,
          repo_root: repo.root,
          worktree_root: join(repo.root, ...WORKTREE_ROOT_SEGMENTS),
          prompt: "越界改动",
          model: "myapi/test-model",
          write_scope: { allow: ["apps/demo/**"], deny: [] },
          test_command: TEST_COMMAND,
          heartbeat_interval_ms: 50,
          commit_spec: { summary: "越界改动" },
        },
        makeAttemptDeps(writingAgent({ "apps/coordinator/sneaky.ts": "export const bad = 1;\n" })),
      );

      expect(outcome.commit).toBeNull();
      expect(outcome.trace.commit_skipped_reason).toContain("越界");
      expect(outcome.report.status).toBe("repair_pending");
      expect(outcome.report.error_code).toBe("DIFF_OUT_OF_SCOPE");
      // 关键：worktree 的 HEAD 仍停在基线 —— 越界内容**没有**进入任何提交
      expect(show(outcome.worktree_path, ["rev-parse", "HEAD"])).toBe(repo.base_sha);
      expect(outcome.local_commits).toEqual([]);
    },
    60_000,
  );

  it(
    "敏感文件（.env）→ **不创建提交**，报告降级 blocked_approval / SENSITIVE_FILE_DETECTED",
    async () => {
      const repo = makeRealRepo();
      const lease = makeLease(repo);
      const outcome = await runAttempt(
        {
          lease,
          repo_root: repo.root,
          worktree_root: join(repo.root, ...WORKTREE_ROOT_SEGMENTS),
          prompt: "触碰敏感文件",
          model: "myapi/test-model",
          // allow 覆盖全仓，确保拦截来自**敏感文件检查**而不是范围检查
          write_scope: { allow: ["**"], deny: [] },
          test_command: TEST_COMMAND,
          heartbeat_interval_ms: 50,
          commit_spec: { summary: "触碰敏感文件" },
        },
        makeAttemptDeps(writingAgent({ ".env": "TOKEN=leaked\n" })),
      );

      expect(outcome.commit).toBeNull();
      expect(outcome.trace.commit_skipped_reason).toContain("敏感");
      expect(outcome.report.status).toBe("blocked_approval");
      expect(outcome.report.error_code).toBe("SENSITIVE_FILE_DETECTED");
      expect(show(outcome.worktree_path, ["rev-parse", "HEAD"])).toBe(repo.base_sha);
      // 敏感内容必须**没有被提交**
      expect(show(outcome.worktree_path, ["log", "-1", "--format=%s"])).not.toContain("触碰敏感文件");
    },
    60_000,
  );

  it(
    "没有测试证据 → **不创建提交**，且绝不 ready_for_integration",
    async () => {
      const repo = makeRealRepo();
      const lease = makeLease(repo);
      const outcome = await runAttempt(
        {
          lease,
          repo_root: repo.root,
          worktree_root: join(repo.root, ...WORKTREE_ROOT_SEGMENTS),
          prompt: "没有测试证据",
          model: "myapi/test-model",
          write_scope: { allow: ["apps/demo/**"], deny: [] },
          // 刻意不传 test_command
          heartbeat_interval_ms: 50,
          commit_spec: { summary: "没有测试证据" },
        },
        makeAttemptDeps(writingAgent({ "apps/demo/x.ts": "export const x = 1;\n" })),
      );

      expect(outcome.commit).toBeNull();
      expect(outcome.trace.commit_skipped_reason).toContain("测试证据");
      expect(outcome.report.status).toBe("repair_pending");
      expect(outcome.report.error_code).toBe("TESTS_FAILED");
      expect(show(outcome.worktree_path, ["rev-parse", "HEAD"])).toBe(repo.base_sha);
    },
    60_000,
  );
});

/* ================================================================== *
 * §3 评审单测试 2：远端核对失败时不得 ready_for_integration
 * ================================================================== */

describe("B5 §3 远端 SHA 核对失败 → 不得 ready_for_integration", () => {
  it(
    "push 退出码为 0 但远端 SHA 与本地 HEAD 不一致 → PUSH_REJECTED，报告降级 failed",
    async () => {
      const repo = makeRealRepo();

      /*
       * 构造「推成功了，但远端其实不是我推的那个提交」。
       *
       * 手法：让 fetch 与 push 指向**不同的** bare 仓库。
       * - fetch（`ls-remote` 读它）→ `stale`，预置一个**旧**的任务分支
       * - push → `target`，真的会收到这次推送
       * 于是 `git push` 退出码为 0，而核对会看到不一致。
       *
       * 这正好模拟真实事故：推到了错误的远端/镜像未同步/钩子改写了 ref。
       */
      const stale = track(mkdtempSync(join(tmpdir(), "dac-stale-")));
      const target = track(mkdtempSync(join(tmpdir(), "dac-target-")));
      for (const dir of [stale, target]) {
        execFileSync(resolveGitExecutable(), ["init", "--bare", "-q", dir], {
          windowsHide: true,
          stdio: "ignore",
        });
      }

      must(repo.root, ["remote", "set-url", "origin", stale]);
      must(repo.root, ["remote", "set-url", "--push", "origin", target]);

      const branch = "taskbranch"; // 直连测试用无斜杠分支名，避免受环境差异影响
      const oldSha = repo.base_sha;

      // 把「旧」提交推到 stale，作为远端当前的错误状态
      must(repo.root, ["branch", branch, oldSha]);
      must(repo.root, ["push", "-q", stale, `refs/heads/${branch}:refs/heads/${branch}`]);

      // 本地前进一个新提交
      writeFileSync(join(repo.root, "apps", "demo", "index.ts"), "export const value = 2;\n", "utf8");
      must(repo.root, ["add", "-A"]);
      must(repo.root, ["commit", "-q", "-m", "advance"]);
      must(repo.root, ["branch", "-f", branch, "HEAD"]);
      const newSha = must(repo.root, ["rev-parse", "HEAD"]).trim();
      expect(newSha).not.toBe(oldSha);

      const result = gitPushBranch({ worktree_path: repo.root, branch, remote: "origin" });

      expect(result.pushed).toBe(false);
      expect(result.error_code).toBe("PUSH_REJECTED");
      expect(result.local_sha).toBe(newSha);
      expect(result.remote_sha).toBe(oldSha); // 核对到了真实的远端值
      expect(result.message).toContain("不一致");
      // 推送**确实落到了 push 目标**（证明失败原因就是核对，而不是 push 本身）
      expect(show(target, ["rev-parse", `refs/heads/${branch}`])).toBe(newSha);
      expect(show(stale, ["rev-parse", `refs/heads/${branch}`])).toBe(oldSha);
    },
    60_000,
  );

  it(
    "远端不可达（ls-remote 失败）→ PUSH_REJECTED，报告不得为 ready_for_integration",
    async () => {
      const repo = makeRealRepo();
      const missing = join(tmpdir(), `dac-missing-${Date.now()}-${Math.random()}`);
      expect(existsSync(missing)).toBe(false);
      must(repo.root, ["remote", "set-url", "origin", missing]);

      const result = gitPushBranch({
        worktree_path: repo.root,
        branch: "taskbranch",
        remote: "origin",
      });
      expect(result.pushed).toBe(false);
      expect(result.error_code).toBe("PUSH_REJECTED");
    },
    60_000,
  );

  it(
    "真实链路：远端核对不一致时，常驻入口上报的是 failed 而不是 ready_for_integration",
    async () => {
      const repo = makeRealRepo();
      const stale = track(mkdtempSync(join(tmpdir(), "dac-stale2-")));
      const target = track(mkdtempSync(join(tmpdir(), "dac-target2-")));
      for (const dir of [stale, target]) {
        execFileSync(resolveGitExecutable(), ["init", "--bare", "-q", dir], {
          windowsHide: true,
          stdio: "ignore",
        });
      }
      must(repo.root, ["remote", "set-url", "origin", stale]);
      must(repo.root, ["remote", "set-url", "--push", "origin", target]);

      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        { "apps/demo/feature.ts": "export const f = 1;\n" },
        { enable_push: true },
      );

      await runDaemon(h.options, h.deps);

      expect(h.pushes).toHaveLength(1); // 真的尝试推了
      expect(h.reports).toHaveLength(1);
      // 核对不过 → 绝不声称可整合
      expect(h.reports[0]!.status).toBe("failed");
      expect(h.reports[0]!.error_code).toBe("PUSH_REJECTED");
      // 而且远端 stale 上根本没有这个提交
      expect(show(stale, ["rev-parse", "refs/heads/task/TASK-0001/TASK-0001-A1"])).toBe("");
    },
    120_000,
  );
});

/* ================================================================== *
 * §4 评审单测试 3：未推送不得 ready_for_integration
 * ================================================================== */

describe("B5 §4 未推送不得 ready_for_integration", () => {
  it(
    "enable_push=false：本地有真实提交，但远端没有 → 降级 blocked_approval / UNAUTHORIZED_OPERATION",
    async () => {
      const repo = makeRealRepo();
      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        { "apps/demo/feature.ts": "export const f = 1;\n" },
        { enable_push: false },
      );

      await runDaemon(h.options, h.deps);

      const worktreePath = join(h.options.worktree_root, "TASK-0001-A1");
      // 提交是真的（本地 HEAD 已偏离基线）
      const localHead = show(worktreePath, ["rev-parse", "HEAD"]);
      expect(localHead).not.toBe(repo.base_sha);
      // 但远端**没有**这个提交
      expect(show(repo.bare, ["rev-parse", "refs/heads/task/TASK-0001/TASK-0001-A1"])).toBe("");
      // 所以不得声称可整合
      expect(h.pushes).toHaveLength(0);
      expect(h.reports[0]!.status).toBe("blocked_approval");
      expect(h.reports[0]!.error_code).toBe("UNAUTHORIZED_OPERATION");
      expect(h.reports[0]!.status).not.toBe("ready_for_integration");
    },
    120_000,
  );
});

/* ================================================================== *
 * §5 评审单测试 5：默认不删除 worktree 与在途记录
 * ================================================================== */

describe("B5 §5 默认不删除 worktree 与在途记录", () => {
  it(
    "一次完整运行结束后：worktree 目录与在途记录文件都还在，记录为终态",
    async () => {
      const repo = makeRealRepo();
      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        { "apps/demo/feature.ts": "export const f = 1;\n" },
        { enable_push: true },
      );

      await runDaemon(h.options, h.deps);

      const worktreePath = join(h.options.worktree_root, "TASK-0001-A1");
      expect(existsSync(worktreePath)).toBe(true);
      // worktree 仍被 git 登记（不是被删了一半）
      expect(show(repo.root, ["worktree", "list"])).toContain("TASK-0001-A1");

      const recordFile = inFlightPath(repo.root);
      expect(existsSync(recordFile)).toBe(true);
      const record = JSON.parse(readFileSync(recordFile, "utf8")) as InFlightRecord;
      expect(record.state).toBe("reported");
      expect(record.task_id).toBe("TASK-0001");
      // 记录里带着 worktree 路径，便于人工接手
      expect(record.worktree_path).toBe(worktreePath);
    },
    120_000,
  );
});

/* ================================================================== *
 * §6 agent 可执行文件不存在：必须**尽快**失败，不得永久挂住
 * ================================================================== */

describe("B5 §6 agent 可执行文件不存在（真实 spawn 一个缺失路径）", () => {
  it(
    "runOpenCodeTask 立即返回失败，而不是等满超时或抛未捕获异常",
    async () => {
      const missing = join(tmpdir(), `dac-no-such-agent-${Date.now()}-${Math.random()}`);
      expect(existsSync(missing)).toBe(false);

      const started = Date.now();
      const result = await runOpenCodeTask(
        { prompt: "任意任务", cwd: tmpdir(), model: "myapi/test-model", timeout_ms: 120_000 },
        { executable: missing },
      );
      const elapsed = Date.now() - started;

      // 没有进程可等：退出码按「未取得」返回，绝不伪造 0
      expect(result.exit_code).toBeNull();
      expect(result.timed_out).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.error_code).toBe("INTERNAL_ERROR");
      // 关键：**没有**等满 120 秒超时（修复前这里会永久挂起）
      expect(elapsed).toBeLessThan(20_000);
    },
    60_000,
  );

  it(
    "常驻入口在 agent 起不来时如实降级上报：不死等、不推送、不声称可整合",
    async () => {
      const repo = makeRealRepo();
      const missing = join(tmpdir(), `dac-no-such-agent-${Date.now()}-daemon`);
      const realRunner = new NodeOpenCodeProcessRunner();
      // 真实进程启动器 + 确定不存在的可执行文件：得到真实的 ENOENT
      const brokenRunner: OpenCodeProcessRunner = {
        start: (_executable, args, cwd) => realRunner.start(missing, args, cwd),
      };

      const h = makeRealHarness(
        repo,
        [{ kind: "leased", task: makeTask({ allow: ["apps/demo/**"], deny: [] }), lease: makeLease(repo) }],
        {},
        { enable_push: true },
        brokenRunner,
      );

      const started = Date.now();
      const report = await runDaemon(h.options, h.deps);
      const elapsed = Date.now() - started;

      // 修复前：这里会一直挂到 vitest 超时（本地实测 120 秒仍不返回）
      expect(elapsed).toBeLessThan(60_000);
      // agent 没产出 → 无提交 → 不得推送
      expect(h.pushes).toHaveLength(0);
      expect(h.reports).toHaveLength(1);
      expect(h.reports[0]!.status).not.toBe("ready_for_integration");
      expect(h.reports[0]!.status).toBe("repair_pending");
      expect(h.reports[0]!.error_code).toBe("INTERNAL_ERROR");
      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]!.pushed).toBe(false);
    },
    120_000,
  );
});
