/**
 * B14 回归用例的**子进程驱动器**（不是测试文件，不匹配 `tests&#47;**&#47;*.test.ts`）。
 *
 * 为什么必须是子进程：本轮要证的是「**常驻入口跑完并空闲后，进程自己在时限内
 * 退出、并给出退出码**」。这件事只能由**进程**来证 —— 在 vitest 进程里，
 * 一个残留的 ref 定时器完全不会让测试失败（vitest 自己会退出），
 * 于是故障永远看不见。A 端 P3 首轮复验 §3 正是这样丢掉了退出码：
 * `idle_limit` 打印完之后主进程又活了十几分钟，最后被人工结束。
 *
 * 本驱动器尽量贴近真实：真实临时 Git 仓库 + 真实 worktree + 真实提交 +
 * 真实推送与远端核对 + 真实**子进程**（agent 与测试命令都真的 spawn）。
 * 只有协调器 HTTP 传输被替换为内存夹具（不碰网络、不碰任何远端）。
 *
 * 唯一被刻意保持默认的「大数字」是 agent 超时（30 分钟）—— 这正是原缺陷的
 * 引爆条件：兜底定时器等的是 `timeout + KILL_GRACE_MS`，`timeout` 一旦很大，
 * 残留定时器就把进程钉在事件循环里很久。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Lease, ResultReport, TaskNode } from "@dac/protocol";

import { runAttempt } from "../../../apps/executor/src/core/attempt.js";
import type { RenewOutcome } from "../../../apps/executor/src/core/lease.js";
import type { RecoveryTransport } from "../../../apps/executor/src/core/recovery.js";
import { git } from "../../../apps/executor/src/core/worktree.js";
import { fileInFlightStore, gitPushBranch, runDaemon } from "../../../apps/executor/src/daemon.js";
import type { AttemptRunner, DaemonDeps, DaemonOptions } from "../../../apps/executor/src/daemon.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationAck,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../../apps/executor/src/transport/adapters.js";

const TOKEN = "b14-driver-token";
const PROJECT = "PROJECT-B14";
const EXECUTOR = "EXE-B-OPENCODE";
const TASK_ID = "TASK-0001";
const ATTEMPT_ID = "TASK-0001-A1";

function must(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.exit_code !== 0) {
    throw new Error(
      `git ${args.join(" ")} 失败（${String(result.exit_code)}）：${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** 真实临时仓库三件套：主仓库 / 本地 bare remote / 基线 SHA。 */
function makeRepo(): { root: string; bare: string; base_sha: string } {
  const root = mkdtempSync(join(tmpdir(), "b14-exit-repo-"));
  const bare = mkdtempSync(join(tmpdir(), "b14-exit-bare-"));
  must(root, ["init", "-q"]);
  must(root, ["config", "user.email", "b@example.invalid"]);
  must(root, ["config", "user.name", "B14 Driver"]);
  must(root, ["config", "commit.gpgsign", "false"]);
  must(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "README.md"), "# B14 空闲退出驱动器仓库\n", "utf8");
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  writeFileSync(join(root, "apps", "demo", "index.ts"), "export const value = 1;\n", "utf8");
  must(root, ["add", "-A"]);
  must(root, ["commit", "-q", "-m", "init"]);

  const bareInit = git(root, ["init", "--bare", "-q", bare]);
  if (bareInit.exit_code !== 0) {
    throw new Error(`git init --bare 失败：${bareInit.stderr.trim()}`);
  }
  must(root, ["remote", "add", "origin", bare]);
  return { root, bare, base_sha: must(root, ["rev-parse", "HEAD"]).trim() };
}

function makeTask(): TaskNode {
  return {
    task_id: TASK_ID,
    kind: "implement",
    title: "B14：本轮只为验证「空闲后自然退出」",
    acceptance_criteria: ["测试全绿"],
    depends_on: [],
    write_scope: { allow: ["apps/demo/**"], deny: [] },
    contracts: [],
    requires: ["code"],
    expected_interfaces: [],
    status: "leased",
    assigned_executor: EXECUTOR,
    attempts_used: 1,
  };
}

function makeLease(baseSha: string): Lease {
  return {
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    executor_id: EXECUTOR,
    lease_epoch: 1,
    expires_at: "2030-01-01T00:00:00.000Z",
    binding: {
      base_sha: baseSha,
      rules_sha: baseSha,
      contract_sha: baseSha,
      acceptance_sha: baseSha,
    },
    agent_kind: "opencode",
  };
}

const repo = makeRepo();
const agentDir = mkdtempSync(join(tmpdir(), "b14-agent-"));
const agentScript = join(agentDir, "fake-agent.cjs");

/**
 * 假 agent：真的被 spawn，真的在 worktree 里写文件，真的打印合法事件流。
 * 只有「模型调用」是假的 —— 本轮要证的也不是模型质量。
 */
writeFileSync(
  agentScript,
  [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.mkdirSync(path.join(process.cwd(), 'apps/demo'), { recursive: true });",
    "fs.writeFileSync(path.join(process.cwd(), 'apps/demo/feature.ts'), 'export const feature = 14;\\n', 'utf8');",
    "process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_b14' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'done' } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', tokens: { total: 1, input: 1, output: 0, reasoning: 0 } } }) + '\\n');",
    "process.exit(0);",
    "",
  ].join("\n"),
  "utf8",
);

/** 队列：先给一个租约，其后一律空 —— 由 max_idle_polls 收口成 idle_limit。 */
const steps: Array<LeaseAcquisition | undefined> = [
  { kind: "leased", task: makeTask(), lease: makeLease(repo.base_sha) },
  undefined,
];
const reports: ResultReport[] = [];

const acquirer: LeaseAcquirer = {
  async acquire(): Promise<LeaseAcquisition> {
    const step = steps.shift();
    return step ?? { kind: "empty" };
  },
};

const store = fileInFlightStore(repo.root);

const options: DaemonOptions = {
  config: {
    base_url: "https://coordinator.example.invalid",
    project_id: PROJECT,
    executor_id: EXECUTOR,
    token: TOKEN,
  },
  registration: {
    host_label: "b14-driver",
    agent_kind: "opencode",
    capabilities: ["code", "test", "git_push"],
  },
  repo_root: repo.root,
  worktree_root: join(repo.root, ".local", "worktrees"),
  model: "myapi/b14-model",
  // 与真实用法一致：测试命令与 agent 都是**真的子进程**
  test_command: {
    executable: process.execPath,
    args: ["-e", "process.stdout.write('Tests  4 passed (4)\\n')"],
  },
  heartbeat_interval_ms: 50,
  max_idle_polls: 1,
  enable_push: true,
  remote: "origin",
  // 刻意**不设** agent_timeout_ms：默认 30 分钟，正是原缺陷的引爆条件
  agent_launcher: { js_entry: agentScript, node_path: process.execPath },
  log: (line) => process.stdout.write(`[driver] ${line}\n`),
};

const deps: DaemonDeps = {
  health: async () => ({ ok: true }),
  registration: {
    async register(): Promise<RegistrationAck> {
      return { executor_id: EXECUTOR, registered: true };
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
      return { kind: "unknown_task" };
    },
  } satisfies RecoveryTransport,
  result_reporter: {
    async report(report: ResultReport): Promise<ReportAck> {
      reports.push(report);
      return { accepted: true, state: "validating" };
    },
  } satisfies ResultReporter,
  attempt_runner: runAttempt as AttemptRunner,
  push_branch: gitPushBranch,
  load_in_flight: store.load_in_flight,
  save_in_flight: store.save_in_flight,
};

let exitCode = 0;
try {
  const report = await runDaemon(options, deps);
  process.stdout.write(
    "DRIVER_REPORT=" +
      JSON.stringify({
        stop_reason: report.stop_reason,
        polls: report.polls,
        attempts: report.attempts,
        reports: reports.length,
      }) +
      "\n",
  );
  // 驱动器自己也判定一次：报告不对就以非零码退出，父进程一眼能看出原因
  exitCode = report.stop_reason === "idle_limit" && report.attempts.length === 1 ? 0 : 3;
} catch (error) {
  process.stdout.write(`DRIVER_ERROR=${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 4;
} finally {
  try {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(repo.bare, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响「是否自然退出」这一结论 */
  }
}

process.stdout.write("DRIVER_DONE\n");
// 与常驻入口同一种收尾方式：只设 exitCode，**不**调用 process.exit()。
// 事件循环里若还挂着未被清理的 ref 定时器，这个进程就不会退出 ——
// 本用例要抓的正是这个。
process.exitCode = exitCode;
