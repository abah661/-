/**
 * 常驻执行器入口测试（B4 建立，B5 按评审单扩展）。
 *
 * 覆盖交接单 §5 要求的 10 项：
 * 1. 启动配置完整/缺失
 * 2. 注册成功与身份不匹配
 * 3. 空队列轮询
 * 4. 领取成功且同一次重试复用幂等键
 * 5. 续租、心跳、执行、结果上报的顺序
 * 6. 401/403、409、429、网络中断
 * 7. 租约失效后不推送、不上报
 * 8. 优雅停止与重启恢复
 * 9. 日志中不出现 Bearer Token
 * 10. Windows 中文和空格路径不退化
 *
 * B5 按评审单新增/改写的部分（以 `P0-x` / `P1-x` 标注）：
 * - P0-1 worktree 保留到推送与上报之后
 * - P0-2 执行器创建提交
 * - P0-3 推送后核对远端 SHA（`readRemoteBranchSha` / `gitPushBranch`）
 * - P0-4 未推送不得 `ready_for_integration`
 * - P1-1 `still_mine` 安全停止并保留记录
 * - P1-2 在途记录不自动删除
 *
 * 说明：`attempt` 内部的时序（**续租循环必须先于 agent 启动**）由
 * `tests/executor/attempt.test.ts` 用真实 `runAttempt` 覆盖；
 * 本文件覆盖的是**跨边界**顺序与各条错误路径的分支结果。
 * 真实临时仓库 + 真实 worktree + 本地 bare remote 的端到端链路由
 * `tests/executor/real-chain.test.ts` 覆盖（评审单「B5 必须增加的真实测试」）。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Lease, ResultReport, TaskNode } from "@dac/protocol";
import type { AttemptDeps, AttemptInput, AttemptOutcome, AttemptProcessState } from "../../apps/executor/src/core/attempt.js";
import { AttemptOrchestrationError } from "../../apps/executor/src/core/attempt.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { LeaseClock, LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { InFlightRecord, RecoveryTransport, TaskOwnership } from "../../apps/executor/src/core/recovery.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationAck,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import { HttpLeaseAcquirer } from "../../apps/executor/src/transport/adapters.js";
import { CoordinatorClient, CoordinatorHttpError, MissingConfigError } from "../../apps/executor/src/transport/http.js";
import type { ExecutorConfig } from "../../apps/executor/src/transport/http.js";
import {
  ENV_KEYS,
  SUPPORTED_AGENT_KIND,
  clearInFlightRecord,
  fileInFlightStore,
  findBindingProblem,
  findHaltedProcessRecord,
  inFlightDir,
  inFlightRecordPath,
  isActiveInFlightRecord,
  isBlockedCode,
  isHaltedProcessState,
  isSupportedAgentKind,
  listInFlightRecords,
  loadDaemonOptions,
  parseTestCommandConfig,
  resolveAgentKind,
  runDaemon,
} from "../../apps/executor/src/daemon.js";
import type {
  AttemptRunner,
  DaemonDeps,
  DaemonOptions,
  PushResult,
} from "../../apps/executor/src/daemon.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const BINDING = {
  base_sha: SHA_A,
  rules_sha: SHA_B,
  contract_sha: "c".repeat(40),
  acceptance_sha: "d".repeat(40),
};

const LEASE: Lease = {
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-OPENCODE",
  lease_epoch: 1,
  expires_at: "2030-01-01T00:00:00.000Z",
  binding: BINDING,
  agent_kind: "opencode",
};

const TASK: TaskNode = {
  task_id: "TASK-0001",
  kind: "implement",
  title: "实现示例功能",
  acceptance_criteria: ["测试全绿"],
  depends_on: [],
  write_scope: { allow: ["apps/executor/**"], deny: [] },
  contracts: [],
  requires: ["code"],
  expected_interfaces: [],
  status: "leased",
  assigned_executor: "EXE-B-OPENCODE",
  attempts_used: 1,
};

const TOKEN = "s3cr3t-bearer-token-value";

/**
 * 假推送返回的 SHA。
 *
 * B5 起 `pushed: true` 的语义变成「**远端 SHA 与本地 HEAD 逐字一致**」
 * （评审单 P0-3），所以假实现也必须给出两端一致的值，否则就不是一个
 * 合法的「推送成功」。
 */
const FAKE_PUSH_SHA = "e".repeat(40);

const CONFIG: ExecutorConfig = {
  base_url: "https://coordinator.example.invalid",
  project_id: "PROJECT-TEST",
  executor_id: "EXE-B-OPENCODE",
  token: TOKEN,
};

function makeReport(overrides: Partial<ResultReport> = {}): ResultReport {
  return {
    protocol_version: "1",
    task_id: LEASE.task_id,
    attempt_id: LEASE.attempt_id,
    executor_id: LEASE.executor_id,
    lease_epoch: LEASE.lease_epoch,
    agent_kind: "opencode",
    base_sha: BINDING.base_sha,
    head_sha: SHA_B,
    rules_sha: BINDING.rules_sha,
    contract_sha: BINDING.contract_sha,
    acceptance_sha: BINDING.acceptance_sha,
    status: "ready_for_integration",
    evidence_id: "EVID-1",
    changed_files: ["apps/executor/src/daemon.ts"],
    evidence: {
      evidence_id: "EVID-1",
      command: ["npm", "run", "check"],
      exit_code: 0,
      summary: { passed: 10, failed: 0, skipped: 0 },
      log_artifact: null,
      output_sha256: null,
    },
    error_code: null,
    commit_shas: [SHA_B],
    note: null,
    reported_at: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<AttemptOutcome> = {}): AttemptOutcome {
  return {
    report: makeReport(),
    trace: {
      phases: ["preparing_worktree", "running_agent", "committing", "reporting"],
      lease_lost: false,
      lease_lost_reason: null,
      sideEffectsSkipped: false,
      worktree_ready: true,
      commit: { committed: true, sha: SHA_B, error_code: null, message: null },
      commit_skipped_reason: null,
      // B8：默认「进程正常终止、Git 核对成功」
      kill_failed: false,
      git_error: null,
      // B11：默认「进程已观察到关闭」——可安全继续的两种状态之一。
      // 需要「状态未知 / 已确认残留」的用例必须显式覆盖它，
      // 否则会悄悄退回「默认安全」这条被点名过的老路。
      process_state: "stopped",
      // B12：默认「没有因为在途进程状态而短路 worktree 操作」。
      shortCircuited: false,
    },
    worktree_removed: true,
    worktree_path: "/repo/.local/worktrees/TASK-0001-A1",
    local_commits: [SHA_B],
    commit: { committed: true, sha: SHA_B, error_code: null, message: null },
    changed_files: ["apps/executor/src/daemon.ts"],
    raw_test_output: "Tests 10 passed",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    config: CONFIG,
    registration: {
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: ["code", "test", "git_push"],
    },
    repo_root: "C:\\repo",
    worktree_root: "C:\\repo\\.local\\worktrees",
    model: "myapi/gpt-5.6-sol",
    max_idle_polls: 3,
    poll_interval_ms: 1,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 假体
 * ------------------------------------------------------------------ */

type AcquireStep = LeaseAcquisition | { fail: unknown };

interface Harness {
  deps: DaemonDeps;
  events: string[];
  logs: string[];
  acquireCalls: () => number;
  reports: ResultReport[];
  pushes: Array<{ worktree_path: string; branch: string; remote: string }>;
  /**
   * 在途记录的写入历史（B5：不再有 `null` —— 删除路径已从存储层移除）。
   *
   * 评审单 P1-2 要求「默认保留历史/终态记录」，所以这里断言的是
   * **状态的推进**，而不再是「记录被清掉」。
   */
  saved: InFlightRecord[];
  attemptInputs: AttemptInput[];
  attemptDeps: AttemptDeps[];
}

function makeHarness(config: {
  script?: AcquireStep[];
  healthOk?: boolean;
  registerAck?: RegistrationAck | { fail: unknown };
  outcome?: AttemptOutcome;
  attemptRunner?: AttemptRunner;
  inFlight?: InFlightRecord | null;
  /** B9：磁盘上的**全量**在途记录（含终态），供启动门禁检查残留进程标记 */
  inFlightRecords?: readonly InFlightRecord[];
  recovery?: TaskOwnership;
  reportAck?: ReportAck | { fail: unknown };
  pushResult?: PushResult;
} = {}): Harness {
  const events: string[] = [];
  const logs: string[] = [];
  const reports: ResultReport[] = [];
  const pushes: Array<{ worktree_path: string; branch: string; remote: string }> = [];
  const saved: InFlightRecord[] = [];
  const attemptInputs: AttemptInput[] = [];
  const attemptDeps: AttemptDeps[] = [];
  const script = config.script ?? [{ kind: "empty" }];
  let acquireCallCount = 0;

  const leaseTransport: LeaseTransport = {
    async renew(): Promise<RenewOutcome> {
      events.push("renew");
      return { kind: "renewed", expires_at: LEASE.expires_at, lease_epoch: LEASE.lease_epoch };
    },
  };

  const heartbeatTransport: HeartbeatTransport = {
    async send(_request: HeartbeatRequest): Promise<void> {
      events.push("heartbeat");
    },
  };

  const acquirer: LeaseAcquirer = {
    async acquire(): Promise<LeaseAcquisition> {
      const index = acquireCallCount;
      acquireCallCount += 1;
      events.push("acquire");
      // 脚本耗尽即视为队列为空。真实协调器不会把**同一个** attempt 反复租给
      // 同一个执行器，所以这里不做「无限重复最后一步」——那样会让假体掩盖
      // 真实循环上限的问题（曾把 daemon 的 max_attempts=Infinity 喂成死循环）。
      if (index >= script.length) return { kind: "empty" };
      const step = script[index]!;
      if (typeof step === "object" && step !== null && "fail" in step) throw step.fail;
      return step as LeaseAcquisition;
    },
  };

  const registration: RegistrationTransport = {
    async register(): Promise<RegistrationAck> {
      events.push("register");
      const ack = config.registerAck ?? { executor_id: CONFIG.executor_id, registered: true };
      if (typeof ack === "object" && ack !== null && "fail" in ack) throw ack.fail;
      return ack as RegistrationAck;
    },
  };

  const recoveryTransport: RecoveryTransport = {
    async queryOwnership(): Promise<TaskOwnership> {
      events.push("query_ownership");
      return config.recovery ?? { kind: "unknown_task" };
    },
  };

  const resultReporter: ResultReporter = {
    async report(report: ResultReport): Promise<ReportAck> {
      events.push("report");
      reports.push(report);
      const ack = config.reportAck ?? { accepted: true, state: "validating" };
      if (typeof ack === "object" && ack !== null && "fail" in ack) throw ack.fail;
      return ack as ReportAck;
    },
  };

  const defaultRunner: AttemptRunner = async (input, deps) => {
    attemptInputs.push(input);
    attemptDeps.push(deps);
    events.push("agent");
    return config.outcome ?? makeOutcome();
  };

  return {
    deps: {
      health: async () => ({ ok: config.healthOk ?? true }),
      registration,
      acquirer,
      lease_transport: leaseTransport,
      heartbeat_transport: heartbeatTransport,
      recovery_transport: recoveryTransport,
      result_reporter: resultReporter,
      attempt_runner: config.attemptRunner ?? defaultRunner,
      push_branch: (input) => {
        events.push("push");
        pushes.push(input);
        return (
          config.pushResult ?? {
            pushed: true,
            error_code: null,
            message: null,
            local_sha: FAKE_PUSH_SHA,
            remote_sha: FAKE_PUSH_SHA,
          }
        );
      },
      load_in_flight: () => config.inFlight ?? null,
      load_in_flight_records: () => config.inFlightRecords ?? [],
      save_in_flight: (record) => {
        saved.push(record);
      },
    },
    events,
    logs,
    acquireCalls: () => acquireCallCount,
    reports,
    pushes,
    saved,
    attemptInputs,
    attemptDeps,
  };
}

/** 让 daemon 记录日志，便于断言脱敏。 */
function withLog(options: DaemonOptions, logs: string[]): DaemonOptions {
  return { ...options, log: (line) => logs.push(line) };
}

/** 构造一条在途记录（B6-1 测试用）。默认 `state: "in_flight"`，即「活动租约」。 */
function makeInFlightRecord(
  dir: string,
  attemptId: string,
  taskId = "TASK-0001",
): InFlightRecord {
  return {
    task_id: taskId,
    attempt_id: attemptId,
    executor_id: CONFIG.executor_id,
    lease_epoch: 1,
    expired_at: LEASE.expires_at,
    worktree_path: join(dir, "worktrees", attemptId),
    completed_phases: [],
    local_commits: [],
    state: "in_flight",
  };
}

/** 构造一个可分类的 HTTP 错误。 */
function httpError(status: number, code: Parameters<typeof isBlockedCode>[0]): CoordinatorHttpError {
  return new CoordinatorHttpError({
    code,
    message: `请求失败：HTTP ${status}`,
    status,
    retryable: false,
  });
}

/* ------------------------------------------------------------------ *
 * 1. 启动配置
 * ------------------------------------------------------------------ */

describe("B4 §1 启动配置", () => {
  const baseEnv = {
    [ENV_KEYS.base_url]: "https://coordinator.example.invalid",
    [ENV_KEYS.project_id]: "PROJECT-TEST",
    [ENV_KEYS.executor_id]: "EXE-B-OPENCODE",
    [ENV_KEYS.token]: TOKEN,
    [ENV_KEYS.model]: "myapi/gpt-5.6-sol",
    [ENV_KEYS.repo_root]: "C:\\repo",
    // B8（B7-6）：测试命令必须由本机显式选择程序与参数。
    [ENV_KEYS.test_executable]: "npm",
    [ENV_KEYS.test_args]: '["test"]',
  };

  it("齐全时装配成功，且默认不声明 git_push（推送需显式开启）", () => {
    const options = loadDaemonOptions(baseEnv);
    expect(options.config.executor_id).toBe("EXE-B-OPENCODE");
    expect(options.model).toBe("myapi/gpt-5.6-sol");
    expect(options.registration.capabilities).toContain("dry_run");
    expect(options.registration.capabilities).not.toContain("git_push");
    expect(options.enable_push).toBe(false);
  });

  it("显式开启推送时才声明 git_push（不夸大能力）", () => {
    const options = loadDaemonOptions({ ...baseEnv, EXECUTOR_ENABLE_PUSH: "1" });
    expect(options.registration.capabilities).toContain("git_push");
    expect(options.enable_push).toBe(true);
  });

  it("缺 token → MissingConfigError 列出全部缺失项，且不提供占位默认值", () => {
    const env = { ...baseEnv };
    delete (env as Record<string, string | undefined>)[ENV_KEYS.token];
    let caught: unknown;
    try {
      loadDaemonOptions(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingConfigError);
    expect((caught as MissingConfigError).missing).toEqual([ENV_KEYS.token]);
  });

  it("缺模型 → 明确报错（不传模型会落到环境变量 provider 并 401）", () => {
    const env = { ...baseEnv };
    delete (env as Record<string, string | undefined>)[ENV_KEYS.model];
    expect(() => loadDaemonOptions(env)).toThrowError(/OPENCODE_MODEL/);
  });

  it("健康检查失败 → 立即停止，不做任何云端写操作", async () => {
    const h = makeHarness({ healthOk: false });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("health_failed");
    expect(report.health_ok).toBe(false);
    // 注册与领取都不得发生
    expect(h.events).not.toContain("register");
    expect(h.events).not.toContain("acquire");
  });
});

/* ------------------------------------------------------------------ *
 * B8 §1b 身份守卫（A 端 B7-4）
 *
 * 缺陷：`daemon.ts` 接受 codex / mock 身份，但 `core/attempt.ts` 无条件
 * 调 `runOpenCodeTask()`。于是注册身份与实际执行者可以不一致。
 * 要求：只接受 opencode，其他身份**启动即拒绝**。
 * ------------------------------------------------------------------ */

describe("B8 §B7-4 身份与实际适配器一致", () => {
  it("只支持 opencode 身份", () => {
    expect(SUPPORTED_AGENT_KIND).toBe("opencode");
    expect(isSupportedAgentKind("opencode")).toBe(true);
    expect(isSupportedAgentKind("codex")).toBe(false);
    expect(isSupportedAgentKind("mock")).toBe(false);
  });

  it("未设置身份时默认 opencode（且不因缺省而放宽）", () => {
    expect(resolveAgentKind(undefined)).toBe("opencode");
    expect(resolveAgentKind("")).toBe("opencode");
    expect(resolveAgentKind("opencode")).toBe("opencode");
  });

  it("codex / mock 身份被明确拒绝，错误信息说明为什么", () => {
    expect(() => resolveAgentKind("codex")).toThrowError(/不支持的 agent 身份/);
    expect(() => resolveAgentKind("codex")).toThrowError(/runOpenCodeTask|适配器只有 OpenCode/);
    expect(() => resolveAgentKind("mock")).toThrowError(/不支持的 agent 身份/);
    // 拒绝理由必须点出「mock 会伪造执行证据」，不能只说「不支持」
    expect(() => resolveAgentKind("mock")).toThrowError(/未真实执行|伪造/);
  });

  it("从环境变量装配时，codex 身份启动即失败（不会带着错误身份连云端）", () => {
    const env = {
      [ENV_KEYS.base_url]: "https://coordinator.example.invalid",
      [ENV_KEYS.project_id]: "PROJECT-TEST",
      [ENV_KEYS.executor_id]: "EXE-B-OPENCODE",
      [ENV_KEYS.token]: TOKEN,
      [ENV_KEYS.model]: "myapi/gpt-5.6-sol",
      [ENV_KEYS.test_executable]: "npm",
      [ENV_KEYS.test_args]: '["test"]',
      [ENV_KEYS.agent]: "codex",
    };
    expect(() => loadDaemonOptions(env)).toThrowError(/不支持的 agent 身份/);
  });

  it("绕过配置层直接调 runDaemon 时同样被挡住，且**不做任何云端操作**", async () => {
    const h = makeHarness();
    const options = makeOptions({
      registration: {
        host_label: "b-desktop",
        agent_kind: "codex" as unknown as "opencode",
        capabilities: ["code", "test", "git_push"],
      },
    });
    const report = await runDaemon(withLog(options, h.logs), h.deps);

    expect(report.stop_reason).toBe("agent_kind_unsupported");
    // 关键：连健康检查都不做，更不能注册/领取
    expect(report.health_ok).toBe(false);
    expect(report.registered).toBe(false);
    expect(h.events).toEqual([]);
    expect(h.acquireCalls()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * B8 §1c 测试命令结构化配置（A 端 B7-6）
 *
 * 缺陷：任何非空 `EXECUTOR_TEST_COMMAND` 都被映射为 `npm run check`，
 * 不设则完全没有测试命令；且「设了任意值」与「设对的值」行为相同。
 * ------------------------------------------------------------------ */

describe("B8 §B7-6 测试命令结构化配置", () => {
  it("显式给出程序与参数时被原样采用（不经过 shell）", () => {
    const command = parseTestCommandConfig({
      [ENV_KEYS.test_executable]: "npm",
      [ENV_KEYS.test_args]: '["test"]',
    });
    // 目标示例仓库只有 npm test —— 现在真的能选到它
    expect(command).toEqual({ executable: "npm", args: ["test"] });
  });

  it("参数可省略（缺省空数组）", () => {
    expect(parseTestCommandConfig({ [ENV_KEYS.test_executable]: "npm" })).toEqual({
      executable: "npm",
      args: [],
    });
  });

  it("含空格的绝对路径被接受（等价于 Program Files 形态，用本平台路径）", () => {
    // 刻意**不**硬编码 `C:\Program Files\nodejs\node.exe`：在 Linux 上
    // `path.isAbsolute()` 对 Windows 盘符路径返回 false，会被上面的
    // 「空白词」规则当成命令行拒绝。第一版就是这么在 Ubuntu CI 上挂掉的
    // （Windows 上因为该文件确实存在而恰好通过 —— 典型的平台假设）。
    // 改用本平台真实存在、且目录名带空格的绝对路径。
    const dir = mkdtempSync(join(tmpdir(), "b8 abs path "));
    try {
      const exe = join(dir, "node.exe");
      writeFileSync(exe, "#!/bin/sh\n", "utf8");
      expect(parseTestCommandConfig({ [ENV_KEYS.test_executable]: exe }).executable).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺可执行程序 → 启动即拒绝（不再有隐式默认）", () => {
    expect(() => parseTestCommandConfig({})).toThrowError(/EXECUTOR_TEST_EXECUTABLE/);
    expect(() => parseTestCommandConfig({ [ENV_KEYS.test_executable]: "   " })).toThrowError(
      /EXECUTOR_TEST_EXECUTABLE/,
    );
  });

  it("参数不是合法 JSON 数组 → 拒绝，不做容错解析", () => {
    expect(() =>
      parseTestCommandConfig({
        [ENV_KEYS.test_executable]: "npm",
        [ENV_KEYS.test_args]: "test",
      }),
    ).toThrowError(/不是合法 JSON/);
    expect(() =>
      parseTestCommandConfig({
        [ENV_KEYS.test_executable]: "npm",
        [ENV_KEYS.test_args]: '{"run":"test"}',
      }),
    ).toThrowError(/必须是字符串数组/);
    expect(() =>
      parseTestCommandConfig({
        [ENV_KEYS.test_executable]: "npm",
        [ENV_KEYS.test_args]: '["test", 1]',
      }),
    ).toThrowError(/必须是字符串数组/);
  });

  it("可执行名含 shell 元字符 → 拒绝（疑似整条命令行）", () => {
    expect(() =>
      parseTestCommandConfig({ [ENV_KEYS.test_executable]: "npm run check" }),
    ).toThrowError(/shell 元字符/);
    expect(() =>
      parseTestCommandConfig({ [ENV_KEYS.test_executable]: "npm && rm -rf /" }),
    ).toThrowError(/shell 元字符/);
  });

  it("绝对路径后夹带参数仍被拒（整串不是盘上存在的文件）", () => {
    const dir = mkdtempSync(join(tmpdir(), "b8 abs path "));
    try {
      const exe = join(dir, "npm.cmd");
      writeFileSync(exe, "#!/bin/sh\n", "utf8");
      // 存在的绝对路径 + 尾巴参数 → 整串不是文件，
      // 说明有人把一整条命令行塞进了这一个变量。
      expect(() =>
        parseTestCommandConfig({ [ENV_KEYS.test_executable]: `${exe} test` }),
      ).toThrowError(/shell 元字符/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("装配后的 options.test_command 与配置一致", () => {
    const options = loadDaemonOptions({
      [ENV_KEYS.base_url]: "https://coordinator.example.invalid",
      [ENV_KEYS.project_id]: "PROJECT-TEST",
      [ENV_KEYS.executor_id]: "EXE-B-OPENCODE",
      [ENV_KEYS.token]: TOKEN,
      [ENV_KEYS.model]: "myapi/gpt-5.6-sol",
      [ENV_KEYS.test_executable]: "npm",
      [ENV_KEYS.test_args]: '["test"]',
    });
    expect(options.test_command).toEqual({ executable: "npm", args: ["test"] });
    // 必须真的走进 runAttempt（否则配置只是在启动时不报错而已）
    expect(options.registration.agent_kind).toBe("opencode");
  });
});

/* ------------------------------------------------------------------ *
 * B8 §1d 停机门槛（A 端 B7-1）
 *
 * 缺陷：强杀失败时 `attempt.ts` 只把原因写进 `report.note`，`daemon.ts`
 * 上报后仍继续轮询。残留进程会占着 worktree 与文件锁，下一个任务
 * 的失败将无法解释。
 * ------------------------------------------------------------------ */

describe("B8 §B7-1 残留进程停机门槛", () => {
  it("kill_failed（无存活证据）→ 按「状态未知」停机，不冒称已确认残留、不领新任务/不推送/不清理", async () => {
    const h = makeHarness({
      // 队列里给两个任务：若没有停机门槛，会继续领第二个
      script: [
        { kind: "leased", task: TASK, lease: LEASE },
        { kind: "leased", task: TASK, lease: LEASE },
      ],
      // 刻意让结果「看似可整合」，用来证明停机门槛会**压过**推送资格：
      // 进程没被杀掉时，提交对应的工作区状态不可信。
      outcome: makeOutcome({ trace: { ...makeOutcome().trace, kill_failed: true } }),
    });

    const report = await runDaemon(withLog(makeOptions({ enable_push: true }), h.logs), h.deps);

    // B12（A 端 B11 复验 P2）：`kill_failed` 只说明「没等到退出」，
    // **不说明「确认还活着」**。没有存活探测证据时必须记「状态未知」，
    // 用「不知道」冒充「已确认残留」就是伪造证据。
    expect(report.stop_reason).toBe("halt_process_unknown");
    // 只领了**一次**：停机门槛生效
    expect(h.acquireCalls()).toBe(1);
    expect(report.attempts).toHaveLength(1);
    // 结果必须**如实上报**（否则协调器永远等不到这个 attempt 的下落）
    expect(h.events).toContain("report");
    expect(h.reports).toHaveLength(1);
    // 但不得推送：工作区状态不可信 → 如实降级为 failed
    expect(h.events).not.toContain("push");
    expect(h.pushes).toHaveLength(0);
    expect(h.reports[0]!.status).toBe("failed");
    // 在途记录终态可区分于「正常上报」
    expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
    // 日志必须点明「需要人工处理」，且措辞与证据强度一致
    expect(h.logs.some((line) => line.includes("状态未知的进程"))).toBe(true);
    expect(h.logs.some((line) => line.includes("残留进程"))).toBe(false);
  });

  it("kill_failed 且存活探测确认仍在运行（process_state=residual）→ 标记为「已确认残留」", async () => {
    const h = makeHarness({
      script: [
        { kind: "leased", task: TASK, lease: LEASE },
        { kind: "leased", task: TASK, lease: LEASE },
      ],
      outcome: makeOutcome({
        trace: { ...makeOutcome().trace, kill_failed: true, process_state: "residual" },
      }),
    });

    const report = await runDaemon(withLog(makeOptions({ enable_push: true }), h.logs), h.deps);

    // 有探测证据才用「已确认」这个词：两者都要停机，但结论强度不同。
    expect(report.stop_reason).toBe("halt_residual_process");
    expect(h.acquireCalls()).toBe(1);
    expect(h.events).not.toContain("push");
    expect(h.saved.at(-1)?.state).toBe("halted_residual_process");
    expect(h.logs.some((line) => line.includes("残留进程"))).toBe(true);
  });

  it("kill_failed=false 时不触发停机，循环照常继续", async () => {
    const h = makeHarness({
      script: [
        { kind: "leased", task: TASK, lease: LEASE },
        { kind: "empty" },
        { kind: "empty" },
      ],
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(h.saved.some((record) => record.state === "reported")).toBe(true);
    expect(report.stop_reason).not.toBe("halt_residual_process");
    expect(report.stop_reason).not.toBe("halt_process_unknown");
  });
});

/* ------------------------------------------------------------------ *
 * B9 § 残留进程状态：所有退出分支 + 重启门禁（A 端 B8 复验 §3）
 *
 * B8 只在「上报成功 + kill_failed」这一条路径上保留了残留标记：
 *   1. 取消 / 租约失效分支不检查 kill_failed，日志还声称「已终止子进程」；
 *   2. 上报失败先写成 failed_to_report，401/403/409 在停机门**之前**就 break；
 *   3. 启动恢复用 `isActiveInFlightRecord` 过滤，而 `halted_residual_process`
 *      不是活动租约，于是重启后照常注册、照常领取。
 * 本组逐条覆盖 A 点名的分支，并锁定「标记存在即拒绝开工」。
 * ------------------------------------------------------------------ */

describe("B9 §B8复验 残留进程状态的所有分支与重启门禁", () => {
  /** 残留标记 = 结果已收尾但进程没被杀掉。构造它只需改 state。 */
  const residualRecord = (dir: string, attemptId = "TASK-0001-A1"): InFlightRecord => ({
    ...makeInFlightRecord(dir, attemptId),
    state: "halted_residual_process",
  });

  const killFailedOutcome = (extra: Partial<AttemptOutcome["trace"]> = {}): AttemptOutcome =>
    makeOutcome({ trace: { ...makeOutcome().trace, kill_failed: true, ...extra } });

  /* --- §3.1 取消 / 租约失效 ---------------------------------- */

  it("① 取消 + kill_failed → 不声称「已终止」、保留停机标记、停止领取新任务", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      // 队列里放两个：没有停机门槛时会继续领第二个
      script: [
        { kind: "leased", task: TASK, lease: LEASE },
        { kind: "leased", task: TASK, lease: LEASE },
      ],
      attemptRunner: async () => {
        controller.abort(); // 模拟 agent 运行中被 Ctrl+C 打断
        return killFailedOutcome();
      },
    });
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );

    // attempt 视角：确实没推送、没上报（事实不变）
    expect(report.attempts[0]!.result).toBe("skipped_aborted");
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    // 但本机不安全 → 停机，且只领了一次
    // B12（A 端 B11 复验 P2）：`kill_failed` 本身没有存活证据 → 「状态未知」，
    // 不得写成「已确认残留」。
    expect(report.stop_reason).toBe("halt_process_unknown");
    expect(h.acquireCalls()).toBe(1);
    expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
    // 不得声称子进程「已终止」——那句话在 kill_failed 时是假的
    expect(h.logs.some((line) => line.includes("已终止子进程"))).toBe(false);
    expect(h.logs.some((line) => line.includes("状态未知"))).toBe(true);
  });

  it("② 租约失效 + kill_failed → 保留停机标记并停机", async () => {
    const h = makeHarness({
      script: [
        { kind: "leased", task: TASK, lease: LEASE },
        { kind: "leased", task: TASK, lease: LEASE },
      ],
      outcome: killFailedOutcome({
        lease_lost: true,
        lease_lost_reason: "lease_epoch_stale",
        sideEffectsSkipped: true,
      }),
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);

    expect(report.attempts[0]!.result).toBe("skipped_lease_lost");
    expect(report.stop_reason).toBe("halt_process_unknown");
    expect(h.acquireCalls()).toBe(1);
    expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
    expect(h.logs.some((line) => line.includes("状态未知"))).toBe(true);
  });

  it("③ 取消但进程已正常终止 → 仍是 skipped_aborted / aborted（不误报残留）", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      attemptRunner: async () => {
        controller.abort();
        return makeOutcome(); // kill_failed: false
      },
    });
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );
    expect(report.stop_reason).toBe("aborted");
    expect(h.saved.at(-1)?.state).toBe("skipped_aborted");
  });

  /* --- §3.2 上报失败（401/403/409/其他）---------------------- */

  for (const [label, status, code, expectedStop] of [
    ["401", 401, "AUTH_EXPIRED", "halt_process_unknown"],
    ["403", 403, "AUTH_EXPIRED", "halt_process_unknown"],
    ["409", 409, "LEASE_EPOCH_STALE", "halt_process_unknown"],
    ["500", 500, "INTERNAL_ERROR", "halt_process_unknown"],
  ] as const) {
    it(`④ 上报 ${label} + kill_failed → 停机标记优先，停机（不再被 ${label} 分支抢走）`, async () => {
      const h = makeHarness({
        script: [
          { kind: "leased", task: TASK, lease: LEASE },
          { kind: "leased", task: TASK, lease: LEASE },
        ],
        outcome: killFailedOutcome(),
        reportAck: { fail: httpError(status, code) },
      });
      const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);

      expect(report.attempts[0]!.result).toBe("failed_to_report");
      expect(report.stop_reason).toBe(expectedStop);
      // B12（A 端 B11 复验 P2）：无存活证据时记「状态未知」，不冒称「已确认残留」
      expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
      expect(h.acquireCalls()).toBe(1);
      expect(h.logs.some((line) => line.includes("状态未知"))).toBe(true);
    });
  }

  it("⑤ 上报 401 且进程已终止 → 仍走 auth_blocked（回归：不误报残留）", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      reportAck: { fail: httpError(401, "AUTH_EXPIRED") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("auth_blocked");
    expect(h.saved.at(-1)?.state).toBe("failed_to_report");
  });

  it("⑥ 上报 409 且进程已终止 → 仍走 lease_lost（回归）", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      reportAck: { fail: httpError(409, "LEASE_EPOCH_STALE") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("lease_lost");
    expect(h.saved.at(-1)?.state).toBe("failed_to_report");
  });

  /* --- §3.3 重启门禁 ---------------------------------------- */

  it("⑦ 重启发现残留标记 → 拒绝开工（不注册、不领取任何任务）", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      inFlightRecords: [residualRecord("C:\\repo")],
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);

    expect(report.stop_reason).toBe("halt_residual_process_on_startup");
    expect(report.registered).toBe(false);
    // 「拒绝开工」= 连注册都不做（注册是本次第一个云端写操作）
    expect(h.events).not.toContain("register");
    expect(h.events).not.toContain("acquire");
    expect(h.acquireCalls()).toBe(0);
    expect(h.logs.some((line) => line.includes("残留进程"))).toBe(true);
  });

  it("⑧ 停机标记不是活动租约（load_in_flight 看不到），但启动门禁能看到", () => {
    const record = residualRecord("C:\\repo");
    // 这正是 B8 的盲点：按「活动租约」过滤会把它漏掉
    expect(isActiveInFlightRecord(record)).toBe(false);
    expect(findHaltedProcessRecord([record])?.attempt_id).toBe("TASK-0001-A1");
    // 正常记录不触发
    expect(findHaltedProcessRecord([makeInFlightRecord("C:\\repo", "TASK-0002-A1")])).toBeNull();
    expect(findHaltedProcessRecord([])).toBeNull();
    // B10：判据是「已确认残留 **或** 状态未知」，两种都要拦
    expect(isHaltedProcessState("halted_residual_process")).toBe(true);
    expect(isHaltedProcessState("halted_process_unknown")).toBe(true);
    // 其余状态不得被误拦（否则正常终态会让执行器永远起不来）
    expect(isHaltedProcessState("in_flight")).toBe(false);
    expect(isHaltedProcessState("reported")).toBe(false);
    expect(isHaltedProcessState("failed_to_report")).toBe(false);
    expect(isHaltedProcessState(undefined)).toBe(false);
  });

  it("⑨ 集成 fileInFlightStore：标记在 → 拒绝开工；显式清除后可正常开工", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-residual-"));
    try {
      const store = fileInFlightStore(dir);
      store.save_in_flight?.(residualRecord(dir, "TASK-0001-A1"));

      // ① 标记存在 → 拒绝开工
      const blocked = makeHarness({ script: [{ kind: "empty" }] });
      const first = await runDaemon(
        withLog(makeOptions({ max_idle_polls: 1 }), blocked.logs),
        { ...blocked.deps, ...store },
      );
      expect(first.stop_reason).toBe("halt_residual_process_on_startup");
      expect(blocked.events).not.toContain("acquire");
      // 记录**原样保留**——门禁不是删除许可
      expect(listInFlightRecords(dir)).toHaveLength(1);

      // ② 人工显式清除这个标记（唯一被允许的解除方式）
      const cleared = clearInFlightRecord(dir, "TASK-0001-A1");
      expect(cleared.removed).toBe(true);

      // ③ 清除后重启正常开工
      const ok = makeHarness({ script: [{ kind: "empty" }] });
      const second = await runDaemon(
        withLog(makeOptions({ max_idle_polls: 1 }), ok.logs),
        { ...ok.deps, ...store },
      );
      expect(second.stop_reason).toBe("idle_limit");
      expect(ok.events).toContain("acquire");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⑩ 没有标记时启动门禁不干扰正常流程", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      inFlightRecords: [makeInFlightRecord("C:\\repo", "TASK-0009-A1")], // 普通终态/活动记录
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(h.events).toContain("register");
    expect(h.events).toContain("acquire");
  });
});

/* ------------------------------------------------------------------ *
 * B10 § 编排异常后的进程状态（A 端 B9 复验 §4）
 *
 * 旧实现：runner 抛异常 → 记 `failed_orchestration` → `continue` 领下一个任务。
 * 那是 fail-open —— 异常可能发生在子进程启动**之后**，进程去向未知，
 * 却被当成「已停止」处理，于是新任务会和去向不明的旧进程并行。
 *
 * 现在按**可证明的进程状态**分流，四种状态各有确定性用例：
 *   not_started / stopped → 无残留风险：记录后继续；
 *   residual / unknown    → 停机 + 保留标记 + 重启门禁拦截。
 * 另加一条反向锁：**非类型化异常必须按 unknown 处理** ——
 * 拿不到状态声明时，不允许乐观默认为「已停止」。
 * ------------------------------------------------------------------ */

describe("B10 §B9复验 编排异常后的进程状态与 fail-closed 停机", () => {
  type State = "not_started" | "stopped" | "residual" | "unknown";

  /** 故障注入：模拟编排在「进程已启动之后」（或可证明的启动之前）抛异常。 */
  const throwingRunner = (state: State, message = "故障注入"): AttemptRunner =>
    async () => {
      throw new AttemptOrchestrationError(`${message}（${state}）`, state, new Error("injected"));
    };

  /** 队列里塞两个任务：没有停机门时**一定**会去领第二个。 */
  const twoLeased = [
    { kind: "leased" as const, task: TASK, lease: LEASE },
    { kind: "leased" as const, task: TASK, lease: LEASE },
  ];

  /* --- 不可证明的两种状态 → 必须停机 ------------------------- */

  for (const [label, state, expectedStop, expectedState, keyword] of [
    ["unknown", "unknown", "halt_process_unknown", "halted_process_unknown", "无法证明"],
    ["residual", "residual", "halt_residual_process", "halted_residual_process", "已确认未被终止"],
  ] as const) {
    it(`① 编排异常且状态为 ${label} → 停机、不再领第二个任务、标记持久化`, async () => {
      const h = makeHarness({
        script: twoLeased,
        attemptRunner: throwingRunner(state),
      });
      const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);

      // attempt 视角：这次 attempt 确实没跑完
      expect(report.attempts[0]!.result).toBe("failed_orchestration");
      // 本机不安全 → 停机，且**只领过一次**
      expect(report.stop_reason).toBe(expectedStop);
      expect(h.acquireCalls()).toBe(1);
      expect(h.saved.at(-1)?.state).toBe(expectedState);
      // 未推送、未上报：没有 outcome，构造不出可信报告
      expect(h.events).not.toContain("push");
      expect(h.events).not.toContain("report");
      // 状态措辞必须能分辨「已确认残留」与「未知」，否则会把排查引偏
      expect(h.logs.some((line) => line.includes(keyword))).toBe(true);
      // worktree 刻意不清理：清理可能被仍未退出的进程挡住
      expect(h.logs.some((line) => line.includes("worktree 刻意不清理"))).toBe(true);
    });
  }

  /* --- 可证明的两种状态 → 允许按安全结束处理 ------------------ */

  for (const [label, state] of [
    ["not_started（异常可证明发生在进程启动之前）", "not_started"],
    ["stopped（进程已确认退出）", "stopped"],
  ] as const) {
    it(`② ${label} → 记录后继续领下一个任务（不误停）`, async () => {
      const h = makeHarness({
        script: twoLeased,
        attemptRunner: throwingRunner(state),
      });
      const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);

      // 两个任务都被处理（各自抛异常），第三次领取遇到空队列 → 正常退出
      expect(h.acquireCalls()).toBe(3);
      expect(report.attempts).toHaveLength(2);
      expect(report.attempts.every((a) => a.result === "failed_orchestration")).toBe(true);
      expect(report.stop_reason).toBe("idle_limit");
      // 安全结束走的是既有的 failed_orchestration，**不得**写停机标记
      expect(h.saved.at(-1)?.state).toBe("failed_orchestration");
      expect(isHaltedProcessState(h.saved.at(-1)?.state)).toBe(false);
    });
  }

  /* --- 反向锁：拿不到状态声明 → 一律按未知处置 ----------------- */

  it("③ 非类型化异常（裸 Error）→ 按 unknown 处理，不乐观默认「已停止」", async () => {
    const h = makeHarness({
      script: twoLeased,
      attemptRunner: async () => {
        throw new Error("裸异常：抛错方没有回答「进程在哪」");
      },
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);

    expect(report.attempts[0]!.result).toBe("failed_orchestration");
    expect(report.stop_reason).toBe("halt_process_unknown");
    expect(h.acquireCalls()).toBe(1);
    expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
  });

  /* --- 重启门禁：未知标记同样要拦 ----------------------------- */

  it("④ 重启发现「状态未知」标记 → 同样拒绝开工（不注册、不领取）", async () => {
    const unknownRecord: InFlightRecord = {
      ...makeInFlightRecord("C:\\repo", "TASK-0001-A1"),
      state: "halted_process_unknown",
    };
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      inFlightRecords: [unknownRecord],
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);

    expect(report.stop_reason).toBe("halt_process_unknown_on_startup");
    expect(report.registered).toBe(false);
    // 「拒绝开工」= 连注册都不做（注册是本次第一个云端写操作）
    expect(h.events).not.toContain("register");
    expect(h.acquireCalls()).toBe(0);
    // 措辞要说「未知」，不能说成「已确认残留」
    expect(h.logs.some((line) => line.includes("状态**未知**"))).toBe(true);
    expect(h.logs.some((line) => line.includes("已确认") && line.includes("残留进程"))).toBe(false);
  });

  it("⑤ 集成 fileInFlightStore：未知标记在 → 拒绝开工；显式清除后可正常开工", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-unknown-"));
    try {
      const store = fileInFlightStore(dir);
      store.save_in_flight?.({
        ...makeInFlightRecord(dir, "TASK-0001-A1"),
        state: "halted_process_unknown",
      });

      // ① 标记存在 → 拒绝开工
      const blocked = makeHarness({ script: [{ kind: "empty" }] });
      const first = await runDaemon(
        withLog(makeOptions({ max_idle_polls: 1 }), blocked.logs),
        { ...blocked.deps, ...store },
      );
      expect(first.stop_reason).toBe("halt_process_unknown_on_startup");
      expect(blocked.events).not.toContain("acquire");
      // 记录**原样保留**——门禁不是删除许可
      expect(listInFlightRecords(dir)).toHaveLength(1);

      // ② 人工显式清除这个标记（唯一被允许的解除方式）
      expect(clearInFlightRecord(dir, "TASK-0001-A1").removed).toBe(true);

      // ③ 清除后重启正常开工
      const ok = makeHarness({ script: [{ kind: "empty" }] });
      const second = await runDaemon(
        withLog(makeOptions({ max_idle_polls: 1 }), ok.logs),
        { ...ok.deps, ...store },
      );
      expect(second.stop_reason).toBe("idle_limit");
      expect(ok.events).toContain("acquire");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * B11 § 正常返回路径的进程状态门禁（A 端 B10 复验 §a）
 *
 * B10 的四种状态只接在**异常分支**上。但超时并不抛异常：
 * `runOpenCodeTask` 会正常返回一个结果（`timed_out: true`），而进程可能
 * 始终没有被观察到退出。A 端复验 §a 点名的正是这条路径：
 * 「超时可以正常返回一个结果，但进程仍可能活着」，判据不能只看异常分支，
 * 也不能用 `exit_code !== null` 反推（被信号终止也可能没有数字退出码）。
 *
 * 本组锁定：**正常返回**同样按 `trace.process_state` 分流，
 * `unknown` / `residual` → 停机 + 门禁标记持久化 + 不清理 worktree。
 * ------------------------------------------------------------------ */

describe("B11 §B10复验 正常返回路径的进程状态门禁", () => {
  /** 队列里塞两个任务：没有停机门时**一定**会去领第二个。 */
  const twoLeased = [
    { kind: "leased" as const, task: TASK, lease: LEASE },
    { kind: "leased" as const, task: TASK, lease: LEASE },
  ];

  /** 正常返回（不是异常），但带着一个不安全的进程状态。 */
  const outcomeWithState = (
    state: AttemptProcessState,
    extra: Partial<AttemptOutcome> = {},
  ): AttemptOutcome =>
    makeOutcome({
      trace: { ...makeOutcome().trace, process_state: state },
      ...extra,
    });

  it("① 正常返回但状态未知 → 上报后停机、不领第二个任务、标记为「未知」", async () => {
    const h = makeHarness({
      script: twoLeased,
      outcome: outcomeWithState("unknown"),
    });
    const report = await runDaemon(
      withLog(makeOptions({ enable_push: true, max_idle_polls: 1 }), h.logs),
      h.deps,
    );

    // 本机不安全 → 停机，且**只领过一次**
    expect(report.stop_reason).toBe("halt_process_unknown");
    expect(h.acquireCalls()).toBe(1);
    expect(report.attempts).toHaveLength(1);
    // 结果仍必须**如实上报**：协调器要拿到这个 attempt 的下落
    expect(h.events).toContain("report");
    expect(h.reports).toHaveLength(1);
    // 门禁标记要落盘，且**不得**冒称「已确认残留」
    expect(h.saved.at(-1)?.state).toBe("halted_process_unknown");
    expect(h.saved.some((record) => record.state === "halted_residual_process")).toBe(false);
    // 措辞必须说「无法证明」，不能把「不知道」说成「已确认杀不掉」
    expect(h.logs.some((line) => line.includes("无法证明"))).toBe(true);
  });

  it("② 正常返回但确认残留 → 停机、标记为「已确认残留」", async () => {
    const h = makeHarness({
      script: twoLeased,
      outcome: outcomeWithState("residual"),
    });
    const report = await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1 }), h.logs),
      h.deps,
    );

    expect(report.stop_reason).toBe("halt_residual_process");
    expect(h.acquireCalls()).toBe(1);
    expect(h.saved.at(-1)?.state).toBe("halted_residual_process");
    expect(h.logs.some((line) => line.includes("已确认未被终止"))).toBe(true);
  });

  it("③ 未观察到关闭但结果看似可整合 → 拒绝推送并降级（推送门同样扩到 unknown）", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      outcome: outcomeWithState("unknown"),
    });
    const report = await runDaemon(
      withLog(makeOptions({ enable_push: true, max_idle_polls: 1 }), h.logs),
      h.deps,
    );

    // 结果默认是 ready_for_integration；进程状态不可信 → 不得推送
    expect(h.events).not.toContain("push");
    expect(h.pushes).toHaveLength(0);
    expect(h.reports[0]!.status).toBe("failed");
    expect(h.reports[0]!.error_code).toBe("INTERNAL_ERROR");
    expect(report.stop_reason).toBe("halt_process_unknown");
  });

  it("④ 显式开启 cleanup_worktree 时，停机路径仍**不清理** worktree", async () => {
    // 清理点固定在链路最末端（推送与上报之后）；停机必须在它之前 break。
    // 用真实临时目录做 worktree_path：若停机分支被执行到，目录会被动过。
    const worktreePath = mkdtempSync(join(tmpdir(), "dac-b11-wt-"));
    try {
      const halted = makeHarness({
        script: twoLeased,
        outcome: outcomeWithState("unknown", { worktree_path: worktreePath }),
      });
      const haltedReport = await runDaemon(
        withLog(makeOptions({ cleanup_worktree: true, max_idle_polls: 1 }), halted.logs),
        halted.deps,
      );
      expect(haltedReport.stop_reason).toBe("halt_process_unknown");
      // 目录原样保留，且清理动作从未被尝试
      expect(existsSync(worktreePath)).toBe(true);
      expect(halted.logs.some((line) => line.startsWith("[worktree]"))).toBe(false);

      // 对照组：同样的配置、进程已确认关闭 → 清理点**会被走到**
      // （临时目录不是 git worktree，所以清理会失败并如实记日志；
      //  这里要证明的是「代码路径走到了」，不是清理成功。）
      const safe = makeHarness({
        script: [{ kind: "leased", task: TASK, lease: LEASE }],
        outcome: outcomeWithState("stopped", { worktree_path: worktreePath }),
      });
      const safeReport = await runDaemon(
        withLog(makeOptions({ cleanup_worktree: true, max_idle_polls: 1 }), safe.logs),
        safe.deps,
      );
      expect(safeReport.stop_reason).not.toBe("halt_process_unknown");
      expect(safe.logs.some((line) => line.startsWith("[worktree]"))).toBe(true);
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("⑤ 反向锁定：状态为 stopped 且未 kill_failed 时不得误停", async () => {
    // 「被信号终止、拿不到数字退出码」也属 stopped —— 若实现退回去看
    // exit_code，这种正常结束会被误判 unknown 并停掉执行器。
    const h = makeHarness({
      script: twoLeased,
      outcome: outcomeWithState("stopped"),
    });
    const report = await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1 }), h.logs),
      h.deps,
    );
    expect(report.stop_reason).not.toBe("halt_process_unknown");
    expect(report.stop_reason).not.toBe("halt_residual_process");
    // 又领了下一个任务（而不是停在这一轮）
    expect(h.acquireCalls()).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 注册
 * ------------------------------------------------------------------ */

describe("B4 §2 注册", () => {
  it("注册成功 → 继续进入领取循环", async () => {
    const h = makeHarness();
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.registered).toBe(true);
    expect(h.events).toContain("register");
    expect(h.events).toContain("acquire");
  });

  it("身份不匹配（403）→ registration_rejected，且**不领取任何任务**", async () => {
    const h = makeHarness({
      registerAck: { fail: httpError(403, "AUTH_EXPIRED") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("registration_rejected");
    expect(report.registered).toBe(false);
    expect(h.events).not.toContain("acquire");
    // 凭据类问题属于 blocked，不得计为代码返修
    expect(isBlockedCode("AUTH_EXPIRED")).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 空队列轮询
 * ------------------------------------------------------------------ */

describe("B4 §3 空队列轮询", () => {
  it("空队列按上限轮询后正常退出，不抛错、不当作故障", async () => {
    const h = makeHarness({ script: [{ kind: "empty" }] });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 4 }), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(report.polls).toBe(4);
    expect(report.attempts).toHaveLength(0);
  });

  it("空队列之后领到任务 → 空闲计数重置，任务被处理", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }, { kind: "leased", task: TASK, lease: LEASE }],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 5 }), h.logs), h.deps);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]!.result).toBe("reported");
    expect(report.stop_reason).toBe("idle_limit"); // 处理完继续轮询直到上限
  });
});

/* ------------------------------------------------------------------ *
 * 4. 领取的幂等键
 * ------------------------------------------------------------------ */

describe("B4 §4 领取的幂等键", () => {
  interface Captured {
    url: string;
    body: Record<string, unknown>;
  }

  function makeClient(script: Array<{ status: number; body?: unknown } | Error>): {
    client: CoordinatorClient;
    captured: Captured[];
  } {
    const captured: Captured[] = [];
    let index = 0;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      if (step instanceof Error) throw step;
      return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new CoordinatorClient(CONFIG, {
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    return { client, captured };
  }

  const request = {
    executor_id: CONFIG.executor_id,
    agent_kind: "opencode" as const,
    capabilities: ["code", "test"] as const,
  };

  it("同一次领取的网络重试**复用同一个幂等键**（重试不产生第二个租约）", async () => {
    const { client, captured } = makeClient([
      { status: 429 },
      { status: 200, body: { task: TASK, lease: LEASE } },
    ]);
    const result = await new HttpLeaseAcquirer(client).acquire(request);
    expect(result.kind).toBe("leased");
    expect(captured).toHaveLength(2);
    expect(captured[0]!.body["idempotency_key"]).toBe(captured[1]!.body["idempotency_key"]);
    expect(captured[0]!.url).toContain("/v1/projects/PROJECT-TEST/tasks/lease");
  });

  it("不同轮次**必须换新键**（否则服务端会一直回放首次缓存的空队列）", async () => {
    const { client, captured } = makeClient([
      { status: 200, body: { task: null, lease: null, status: "empty" } },
      { status: 200, body: { task: null, lease: null, status: "empty" } },
    ]);
    const acquirer = new HttpLeaseAcquirer(client);
    expect((await acquirer.acquire(request)).kind).toBe("empty");
    expect((await acquirer.acquire(request)).kind).toBe("empty");
    expect(captured[0]!.body["idempotency_key"]).not.toBe(captured[1]!.body["idempotency_key"]);
  });

  it("空队列应答 `{task:null,lease:null,status:'empty'}` 解析为 empty 而不是错误", async () => {
    const { client } = makeClient([
      { status: 200, body: { task: null, lease: null, status: "empty" } },
    ]);
    await expect(new HttpLeaseAcquirer(client).acquire(request)).resolves.toEqual({
      kind: "empty",
    });
  });
});

/* ------------------------------------------------------------------ *
 * 5. 顺序
 * ------------------------------------------------------------------ */

describe("B4 §5 续租/心跳/执行/上报的顺序", () => {
  it("跨边界顺序：领取 → 编排(续租/心跳/agent) → 推送 → 上报", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    // 用真实语义消费 daemon 注入的传输：续租与心跳都必须走那一份，
    // 这样 acquire / attempt_start / renew / heartbeat / agent / push / report
    // 才落在同一个 events 数组里，顺序才有可比性。
    h.deps.attempt_runner = async (input, deps) => {
      h.events.push("attempt_start");
      await deps.lease_transport.renew(input.lease.task_id, input.lease.attempt_id, 1);
      await deps.heartbeat_transport.send({
        protocol_version: "1",
        executor_id: input.lease.executor_id,
        state: "running",
        task_id: input.lease.task_id,
        attempt_id: input.lease.attempt_id,
        lease_epoch: 1,
        sent_at: "2026-09-22T00:00:00.000Z",
        idempotency_key: "hb-1",
      });
      h.events.push("agent");
      return makeOutcome({
        worktree_path: join(input.worktree_root, input.lease.attempt_id),
      });
    };

    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1, enable_push: true }), h.logs),
      h.deps,
    );

    const order = h.events.filter((event) =>
      ["acquire", "attempt_start", "renew", "heartbeat", "agent", "push", "report"].includes(event),
    );
    // 第 8 个 acquire 是处理完一次 attempt 后主循环的再次轮询
    // （max_idle_polls=1，随即因空闲上限退出）。
    expect(order.slice(0, 7)).toEqual([
      "acquire",
      "attempt_start",
      "renew",
      "heartbeat",
      "agent",
      "push",
      "report",
    ]);
  });

  it("编排器拿到的是注入的传输（续租与心跳都由 daemon 转发，不是各写一套）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(h.attemptDeps[0]!.lease_transport).toBe(h.deps.lease_transport);
    expect(h.attemptDeps[0]!.heartbeat_transport).toBe(h.deps.heartbeat_transport);
  });

  /** 评审单 P0-1 / P0-2：常驻入口传给编排器的两个关键参数。 */
  it("常驻入口：**始终**不清理 worktree，并把提交规格交给编排器（P0-1 / P0-2）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    const input = h.attemptInputs[0]!;
    // P0-1：绝不在这里清理——worktree 要活到推送与远端核对之后。
    // 即使调用方没传 cleanup_worktree（默认 undefined），也必须是 false。
    expect(input.cleanup_worktree).toBe(false);
    // P0-2：提交规格必须交给编排器，否则不会创建任何提交
    expect(input.commit_spec).toEqual({ summary: TASK.title });
  });

  it("推送未通过远端核对 → 上报降级为 failed，不得声称可整合（P0-3）", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      pushResult: {
        pushed: false,
        error_code: "PUSH_REJECTED",
        message: "远端 SHA 与本地 HEAD 不一致",
        local_sha: SHA_A,
        remote_sha: SHA_B,
      },
    });
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1, enable_push: true }), h.logs), h.deps);
    expect(h.pushes).toHaveLength(1); // 真的尝试推了
    expect(h.reports[0]!.status).toBe("failed");
    expect(h.reports[0]!.error_code).toBe("PUSH_REJECTED");
  });

  it("推送发生在上报**之前**（上报里的 commit_shas 必须已在远端）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 1, enable_push: true }), h.logs),
      h.deps,
    );
    // 先证明推送真的发生了（否则 indexOf 返回 -1 会让下面的断言假通过）
    expect(h.pushes).toHaveLength(1);
    expect(h.events).toContain("push");
    expect(h.events.indexOf("push")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("push")).toBeLessThan(h.events.indexOf("report"));
  });

  /**
   * 评审单 P0-4（B5 反向锁定）。
   *
   * B4 的测试原本断言「enable_push=false 时**不推送但照常上报
   * ready_for_integration**」——那等于告诉协调器有个提交可供整合，
   * 而对应的 SHA 只存在于 B 本机，A 端根本取不到。评审单明确要求
   * 「修改现有反向测试，锁定『未推送不得 ready_for_integration』」。
   */
  it("未显式开启推送 → 不推送，且**不得**上报 ready_for_integration（降级 blocked_approval）", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    // registration.capabilities 含 git_push，但没有 enable_push
    await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(h.events).not.toContain("push");
    expect(h.pushes).toHaveLength(0);
    // 仍然上报（要说清楚发生了什么），但不能声称可整合
    expect(h.events).toContain("report");
    expect(h.reports[0]!.status).not.toBe("ready_for_integration");
    expect(h.reports[0]!.status).toBe("blocked_approval");
    expect(h.reports[0]!.error_code).toBe("UNAUTHORIZED_OPERATION");
  });

  it("声明了 dry_run 而未声明 git_push → 同样不得 ready_for_integration", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    const options = makeOptions({ max_idle_polls: 1, enable_push: true });
    // 开了 enable_push，但能力里没有 git_push：授权动作与能力声明必须**同时**满足
    options.registration = {
      ...options.registration,
      capabilities: ["code", "test", "dry_run"],
    };
    await runDaemon(withLog(options, h.logs), h.deps);
    expect(h.pushes).toHaveLength(0);
    expect(h.reports[0]!.status).toBe("blocked_approval");
    expect(h.reports[0]!.error_code).toBe("UNAUTHORIZED_OPERATION");
  });
});

/* ------------------------------------------------------------------ *
 * 6. 错误分类
 * ------------------------------------------------------------------ */

describe("B4 §6 错误分类", () => {
  it("401 → auth_blocked（凭据问题，不计返修）", async () => {
    const h = makeHarness({ script: [{ fail: httpError(401, "AUTH_EXPIRED") }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("auth_blocked");
    expect(isBlockedCode("AUTH_EXPIRED")).toBe(true);
  });

  it("403 → auth_blocked", async () => {
    const h = makeHarness({ script: [{ fail: httpError(403, "AUTH_EXPIRED") }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("auth_blocked");
  });

  it("网络不可达 → offline，停止领取新任务（不猜任务仍归自己）", async () => {
    const h = makeHarness({
      script: [
        { fail: new CoordinatorHttpError({ code: "INTERNAL_ERROR", message: "网络错误", status: null, retryable: true }) },
      ],
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("offline");
  });

  it("429 之后恢复 → 不算故障，继续领到任务", async () => {
    const h = makeHarness({
      script: [{ fail: httpError(429, "RATE_LIMITED") }, { kind: "leased", task: TASK, lease: LEASE }],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 4 }), h.logs), h.deps);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]!.result).toBe("reported");
  });

  it("上报遇 409 → lease_lost，停止且不伪造成功", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      reportAck: { fail: httpError(409, "LEASE_EPOCH_STALE") },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("lease_lost");
    expect(report.attempts[0]!.result).toBe("failed_to_report");
  });

  it("429 持续 → 由空闲上限兜住，不会无限自旋", async () => {
    // 显式写三次 429，而不是靠假体重复最后一步——否则测不出「上限真的生效」。
    const h = makeHarness({
      script: [
        { fail: httpError(429, "RATE_LIMITED") },
        { fail: httpError(429, "RATE_LIMITED") },
        { fail: httpError(429, "RATE_LIMITED") },
      ],
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 3 }), h.logs), h.deps);
    expect(report.stop_reason).toBe("idle_limit");
    expect(h.acquireCalls()).toBe(3);
    expect(h.events).not.toContain("agent");
  });
});

/* ------------------------------------------------------------------ *
 * 7. 租约失效后不推送、不上报
 * ------------------------------------------------------------------ */

describe("B4 §7 租约失效", () => {
  it("sideEffectsSkipped → 既不推送也不上报，且停止循环", async () => {
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      outcome: makeOutcome({
        trace: {
          phases: [],
          lease_lost: true,
          lease_lost_reason: "lease_epoch_stale",
          sideEffectsSkipped: true,
          // B12：`shortCircuited` 与 `sideEffectsSkipped` 是**两个不同的原因**。
          // 本用例是「租约失效」，不是「进程状态不安全」，所以这里必须是 false
          // —— 否则记录会把一个根本没发生的原因写进去。
          shortCircuited: false,
          worktree_ready: true,
          commit: null,
          commit_skipped_reason: null,
          kill_failed: false,
          git_error: null,
          process_state: "stopped",
        },
      }),
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    expect(report.attempts[0]!.result).toBe("skipped_lease_lost");
    expect(report.stop_reason).toBe("lease_lost");
  });

  it("版本绑定缺项 → 拒绝开工（不上报伪造结果）", async () => {
    const brokenLease = {
      ...LEASE,
      binding: { ...BINDING, contract_sha: "" },
    } as unknown as Lease;
    expect(findBindingProblem(brokenLease)).toContain("contract_sha");
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: brokenLease }] });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.attempts[0]!.result).toBe("refused_binding_incomplete");
    expect(h.events).not.toContain("agent");
    expect(h.events).not.toContain("report");
  });

  it("版本绑定齐全 → 放行", () => {
    expect(findBindingProblem(LEASE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 8. 优雅停止与重启恢复
 * ------------------------------------------------------------------ */

describe("B4 §8 优雅停止与重启恢复", () => {
  it("取消信号在循环前即已置位 → 不领取任何任务", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness();
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );
    expect(report.stop_reason).toBe("aborted");
    expect(h.acquireCalls()).toBe(0);
  });

  it("编排期间收到取消 → 不推送、不上报（租约自然过期）", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      script: [{ kind: "leased", task: TASK, lease: LEASE }],
      attemptRunner: async () => {
        controller.abort(); // 模拟 agent 运行中被 Ctrl+C 打断
        return makeOutcome();
      },
    });
    const report = await runDaemon(
      withLog(makeOptions({ signal: controller.signal }), h.logs),
      h.deps,
    );
    expect(report.attempts[0]!.result).toBe("skipped_aborted");
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    expect(report.stop_reason).toBe("aborted");
  });

  /**
   * 评审单 P1-1（B5 反向锁定）。
   *
   * B4 的行为是：查得仍归本机 → **删掉在途记录 → 立刻进领取循环**。
   * 那会造成同一执行器同时持两份租约，旧 attempt 永远没人收尾，
   * 而且「旧 worktree 与旧租约」的事实被本地丢失了。
   */
  it("重启恢复：仍归本机 → 安全停止、保留记录、不领取新任务（P1-1）", async () => {
    const record: InFlightRecord = {
      task_id: "TASK-0001",
      attempt_id: "TASK-0001-A1",
      executor_id: CONFIG.executor_id,
      lease_epoch: 1,
      expired_at: LEASE.expires_at,
      worktree_path: "C:\\repo\\.local\\worktrees\\TASK-0001-A1",
      completed_phases: ["running_agent"],
      local_commits: [],
    };
    const h = makeHarness({
      inFlight: record,
      recovery: {
        kind: "still_mine",
        lease: {
          task_id: "TASK-0001",
          attempt_id: "TASK-0001-A1",
          executor_id: CONFIG.executor_id,
          lease_epoch: 1,
          expires_at: LEASE.expires_at,
        },
      },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);

    // ① 决策被识别为 resume（仍归我）
    expect(report.recovery).toEqual({ kind: "resume", from_phase: "running_agent" });
    // ② 本轮**安全停止**，而不是继续领取
    expect(report.stop_reason).toBe("halt_still_mine");

    const recoveryIndex = h.events.indexOf("query_ownership");
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    // ③ 查完归属之后不得再领任务
    expect(h.events.slice(recoveryIndex + 1)).not.toContain("acquire");
    // ④ 不得推送、不得上报
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    expect(report.attempts).toHaveLength(0);

    // ⑤ 记录**被保留**并推进为终态（P1-2：不再有任何删除路径）
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]!.state).toBe("halted_still_mine");
    expect(h.saved[0]!.task_id).toBe("TASK-0001");
    expect(typeof h.saved[0]!.state_updated_at).toBe("string");
  });

  it("重启恢复：归属不可达 → halt_offline，停止新操作", async () => {
    const h = makeHarness({
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: { kind: "unreachable", error: "ECONNRESET" },
    });
    const report = await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(report.stop_reason).toBe("halt_offline_on_recovery");
    expect(h.events).not.toContain("acquire");
    // 还没拿到云端结论 → **不得**推进记录状态
    expect(h.saved).toHaveLength(0);
  });

  it("重启恢复：已被重派 → 本地放手，记录保留为终态，可继续领取", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }],
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: {
        kind: "reassigned",
        reason: "lease_reassigned",
        to_executor: "EXE-A-LENOVO",
        attempt_id: "TASK-0001-A2",
        lease_epoch: 2,
      },
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(report.recovery?.kind).toBe("abandon_reassigned");
    expect(h.events).not.toContain("push");
    expect(h.events).not.toContain("report");
    // 服务端已确认不再归我 → 记录推进为终态，但**文件仍在**
    expect(h.saved[0]!.state).toBe("abandoned_reassigned");
    // 但可以继续领取新任务（不再持有旧租约）
    expect(h.events).toContain("acquire");
  });

  it("重启恢复：租约已过期 → 记录保留为终态，可继续领取", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }],
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: "2020-01-01T00:00:00.000Z",
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: {
        kind: "still_mine",
        lease: {
          task_id: "TASK-0001",
          attempt_id: "TASK-0001-A1",
          executor_id: CONFIG.executor_id,
          lease_epoch: 1,
          expires_at: "2020-01-01T00:00:00.000Z",
        },
      },
    });
    const report = await runDaemon(withLog(makeOptions({ max_idle_polls: 1 }), h.logs), h.deps);
    expect(report.recovery?.kind).toBe("abandon_expired");
    expect(h.saved[0]!.state).toBe("abandoned_expired");
    expect(h.events).toContain("acquire");
  });
});

/* ------------------------------------------------------------------ *
 * 9. 日志脱敏
 * ------------------------------------------------------------------ */

describe("B4 §9 日志中不出现 Bearer Token", () => {
  it("把所有事件跑一遍，日志里都不含 token", async () => {
    const h = makeHarness({
      script: [{ kind: "empty" }],
      registerAck: { fail: httpError(401, "AUTH_EXPIRED") },
    });
    await runDaemon(withLog(makeOptions(), h.logs), h.deps);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("Bearer ");
    }
  });

  it("即使日志字段里带了 token，也会在出口被脱敏后再输出", async () => {
    // 让 daemon **真的**把 token 打进日志行：归属查询的错误文本会原样进入 [recovery] 行。
    // 这样断言的就不是「恰好没打印」，而是「脱敏确实生效」。
    const sink: string[] = [];
    const h = makeHarness({
      inFlight: {
        task_id: "TASK-0001",
        attempt_id: "TASK-0001-A1",
        executor_id: CONFIG.executor_id,
        lease_epoch: 1,
        expired_at: LEASE.expires_at,
        worktree_path: "C:\\repo\\wt",
        completed_phases: [],
        local_commits: [],
      },
      recovery: { kind: "unreachable", error: `ECONNRESET Bearer ${TOKEN}` },
    });
    await runDaemon({ ...makeOptions(), log: (line) => sink.push(line) }, h.deps);

    const recoveryLine = sink.find((line) => line.includes("[recovery]"));
    // 1) 这行确实产生了，且输入里确实携带了 token
    expect(recoveryLine).toBeDefined();
    // 2) token 原值不得出现
    expect(sink.every((line) => !line.includes(TOKEN))).toBe(true);
    // 3) 兜底规则把 Bearer 形态整体替换掉 —— 证明替换真的发生了
    expect(recoveryLine).toContain("Bearer [REDACTED]");
  });

  it("CoordinatorClient 的错误信息不含 token（红线）", () => {
    const error = new CoordinatorHttpError({
      code: "INTERNAL_ERROR",
      message: "网络错误：POST /tasks/lease",
      status: null,
      retryable: true,
    });
    expect(error.message).not.toContain(TOKEN);
  });
});

/* ------------------------------------------------------------------ *
 * 10. Windows 中文与空格路径
 * ------------------------------------------------------------------ */

describe("B4 §10 Windows 中文与空格路径", () => {
  const chineseRepo = "C:\\Users\\测试 用户\\Desktop\\协调 系统 仓库";
  const chineseWorktree = "C:\\Users\\测试 用户\\Desktop\\协调 系统 仓库\\.local\\worktrees";

  it("含中文与空格的路径原样透传给编排器，不被截断或改写", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(
        makeOptions({ repo_root: chineseRepo, worktree_root: chineseWorktree, max_idle_polls: 1 }),
        h.logs,
      ),
      h.deps,
    );
    expect(h.attemptInputs[0]!.repo_root).toBe(chineseRepo);
    expect(h.attemptInputs[0]!.worktree_root).toBe(chineseWorktree);
    expect(h.attemptInputs[0]!.repo_root).toContain(" ");
  });

  it("在途记录使用任务专属 worktree 子目录，中文路径拼接正确", async () => {
    const h = makeHarness({ script: [{ kind: "leased", task: TASK, lease: LEASE }] });
    await runDaemon(
      withLog(
        makeOptions({ repo_root: chineseRepo, worktree_root: chineseWorktree, max_idle_polls: 1 }),
        h.logs,
      ),
      h.deps,
    );
    const record = h.saved[0]!;
    expect(record.worktree_path).toBe(join(chineseWorktree, LEASE.attempt_id));
    expect(record.worktree_path.endsWith(LEASE.attempt_id)).toBe(true);
  });

  /**
   * 评审单 P1-2（B5）+ B6-1（B6）。
   *
   * B4 的存储层用 `save_in_flight(null)` → `rmSync` 表达「运行完成」，
   * 等于把「跑完了」当成删除许可。B5 去掉了删除路径，但**仍把所有 attempt
   * 写进同一个文件**——第二个 attempt 一落盘就把第一个覆盖掉（B6-1）。
   * 现在：每 attempt 一份文件，结束只推进 `state`，历史不得被覆盖。
   */
  it("在途记录：每 attempt 一份文件，结束只推进状态、**不删除**（P1-2 + B6-1）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-inflight-"));
    try {
      const store = fileInFlightStore(dir);
      expect(store.load_in_flight?.()).toBeNull();

      const record = makeInFlightRecord(dir, "TASK-0001-A1");
      const file = inFlightRecordPath(dir, record.attempt_id);
      store.save_in_flight?.(record);
      expect(store.load_in_flight?.()).toEqual(record);
      expect(existsSync(file)).toBe(true);

      // 「结束」= 推进状态，而不是删除
      store.save_in_flight?.({ ...record, state: "reported", state_updated_at: "x" });
      expect(existsSync(file)).toBe(true);
      // 关键（B6-1）：终态记录**不再**被当成活动租约返回……
      expect(store.load_in_flight?.()).toBeNull();
      // ……但它本人还在磁盘上，可复查
      const all = listInFlightRecords(dir);
      expect(all).toHaveLength(1);
      expect(all[0]!.state).toBe("reported");

      // 只有**显式**清理动作才会删文件，且它不在常驻入口的自动路径里
      const cleared = clearInFlightRecord(dir, record.attempt_id);
      expect(cleared.removed).toBe(true);
      expect(cleared.path).toBe(file);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * B6-1 的核心验收：**记录不会再被后续任务覆盖**。
   *
   * 连续完成两个不同 attempt 后，两份记录都必须存在且各自状态正确；
   * 重启恢复只处理仍为 `in_flight` 的那一份。
   */
  it("B6-1：连续两个 attempt 的记录都在，且只恢复 in_flight 的那一份", () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-attempts-"));
    try {
      const store = fileInFlightStore(dir);

      const first = makeInFlightRecord(dir, "TASK-0001-A1");
      store.save_in_flight?.(first);
      store.save_in_flight?.({
        ...first,
        state: "reported",
        state_updated_at: "2026-09-24T00:00:00.000Z",
      });

      // 第二个 attempt 落盘：**不得**覆盖第一个
      const second = makeInFlightRecord(dir, "TASK-0002-A1", "TASK-0002");
      store.save_in_flight?.(second);

      const all = listInFlightRecords(dir);
      expect(all.map((r) => r.attempt_id)).toEqual(["TASK-0001-A1", "TASK-0002-A1"]);
      const firstOnDisk = all.find((r) => r.attempt_id === "TASK-0001-A1")!;
      expect(firstOnDisk.state).toBe("reported");
      expect(isActiveInFlightRecord(firstOnDisk)).toBe(false);

      // 重启只会拿到仍为 in_flight 的那一份
      const loaded = store.load_in_flight?.();
      expect(loaded?.attempt_id).toBe("TASK-0002-A1");
      expect(loaded?.state).toBe("in_flight");

      // 两份文件各自独立存在于磁盘
      expect(existsSync(inFlightRecordPath(dir, "TASK-0001-A1"))).toBe(true);
      expect(existsSync(inFlightRecordPath(dir, "TASK-0002-A1"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * B6-1（集成）：磁盘上只留下终态记录时，重启**不得**发起恢复查询。
   *
   * 这条是「终态记录不会再次被当成活动租约恢复」的真实检验：
   * 断言 `query_ownership` 从未被调用，且 `recovery` 为 null。
   */
  it("B6-1：磁盘上只有终态记录时，重启不做恢复查询", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dac-terminal-"));
    try {
      const store = fileInFlightStore(dir);
      store.save_in_flight?.({
        ...makeInFlightRecord(dir, "TASK-0009-A1", "TASK-0009"),
        state: "halted_still_mine",
      });

      const h = makeHarness({ script: [] });
      const report = await runDaemon(
        withLog(makeOptions({ max_idle_polls: 1 }), h.logs),
        { ...h.deps, ...store },
      );

      expect(report.recovery).toBeNull();
      expect(h.events).not.toContain("query_ownership");
      // 终态记录原样保留
      expect(listInFlightRecords(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("在途记录能真实读写含中文与空格的目录（Windows 不退化）", () => {
    const dir = mkdtempSync(join(tmpdir(), "dac 中文 测试 "));
    try {
      const store = fileInFlightStore(dir);
      expect(store.load_in_flight?.()).toBeNull();
      const record = makeInFlightRecord(dir, "TASK-0001-A1");
      store.save_in_flight?.(record);
      expect(store.load_in_flight?.()).toEqual(record);
      // 目录形态本身也要正确（B6-1）
      expect(inFlightDir(dir).endsWith(join(".local", "executor-attempts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 辅助断言：时钟注入
 * ------------------------------------------------------------------ */

describe("B4 时钟注入", () => {
  it("轮询等待走注入的 clock（测试不依赖真实时间）", async () => {
    const slept: number[] = [];
    const clock: LeaseClock = {
      now: () => 0,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
    const h = makeHarness({ script: [{ kind: "empty" }] });
    await runDaemon(
      withLog(makeOptions({ max_idle_polls: 3, poll_interval_ms: 77 }), h.logs),
      { ...h.deps, clock },
    );
    expect(slept).toEqual([77, 77]);
  });
});
