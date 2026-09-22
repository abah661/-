/**
 * 常驻执行器入口（TASK-B-EXECUTOR-B4）。
 *
 * ## 与 `index.ts` 的关系
 * `index.ts` 是**库的导出面**（纯导出，无副作用），本文件是**可运行的入口**。
 * 二者刻意分开：把常驻循环塞进 `index.ts` 会让「import 一下就启动了一个
 * 常驻进程」，测试与工具都会遭殃。启动方式见 `apps/executor/package.json`
 * 的 `start` / `start:json` 脚本。
 *
 * ## 本文件负责的 14 项真实流程（对应交接单 §4）
 * | # | 要求 | 落点 |
 * | --- | --- | --- |
 * | 1 | 从环境变量读配置，缺失时清楚报错，**绝不打印 Token** | `loadExecutorConfig` + `makeLogger` 统一脱敏 |
 * | 2 | 调 `/v1/health` 检查 Worker | `deps.health()`，失败即停止 |
 * | 3 | 注册 `EXE-B-OPENCODE` | `deps.registration.register` |
 * | 4 | 以稳定幂等键领取任务 | `HttpLeaseAcquirer`（同一次调用内复用键） |
 * | 5 | 空队列有上限轮询，**不当故障** | `max_idle_polls` |
 * | 6 | 先起独立续租与心跳，再调 OpenCode | `runAttempt` 内部时序（已由既有测试锁定） |
 * | 7 | 使用任务绑定的四项 SHA | `assertBindingComplete` |
 * | 8 | 租约有效 + diff 合法 + 无敏感文件才推送 | `trace.sideEffectsSkipped` + `report.status` |
 * | 9 | 固定幂等键回报结果 | 服务端按 task/attempt/epoch 自算 |
 * | 10 | `401/403` → `blocked_auth`，不计返修 | `stop_reason: "auth_blocked"` |
 * | 11 | `409` / 租约失效 → 停子进程，不推送不上报 | `sideEffectsSkipped` 分支 |
 * | 12 | 网络不可达 → 停止领取新任务 | `status === null` → `offline` |
 * | 13 | `Ctrl+C` → 停轮询/心跳/续租/子进程 | `signal` 透传到 agent 适配器 |
 * | 14 | 重启后先查归属再决定 | `decideRecovery` |
 *
 * ## 两条不可违反的红线
 * 1. **不猜**。云端没回答的事实一律不得用本地推断替代（网络不可达就是不可达）。
 * 2. **不假装成功**。自报完成不算完成；没推送就不能说推送了。
 *
 * ## 关于「不自动续跑未完成的 attempt」
 * 第 14 项要求「先查询归属，再决定继续或放弃」。B4 的实现是：**查得出来、
 * 但一律放弃**。原因是没有恢复中间 worktree 状态的能力，硬续跑会出现
 * 「两方同时改同一任务」。真正的断点续跑属 P5 范围，此处不假装实现。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Capability, ErrorCode, ExecutorRegistration, Lease, ResultStatus, TaskNode, WriteScope } from "@dac/protocol";
import { ERROR_POLICY } from "@dac/protocol";

import { runAttempt } from "./core/attempt.js";
import type { AttemptDeps, AttemptInput, AttemptOutcome, TestCommand } from "./core/attempt.js";
import { systemClock } from "./core/lease.js";
import type { LeaseClock, LeaseTransport } from "./core/lease.js";
import type { HeartbeatTransport } from "./core/heartbeat.js";
import { decideRecovery } from "./core/recovery.js";
import type { InFlightRecord, RecoveryDecision, RecoveryTransport } from "./core/recovery.js";
import { git } from "./core/worktree.js";
import {
  HttpHeartbeatTransport,
  HttpLeaseAcquirer,
  HttpLeaseTransport,
  HttpRecoveryTransport,
  HttpRegistrationTransport,
  HttpResultReporter,
} from "./transport/adapters.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationTransport,
  ResultReporter,
} from "./transport/adapters.js";
import { CoordinatorClient, CoordinatorHttpError, loadExecutorConfig, redactSecrets } from "./transport/http.js";
import type { ExecutorConfig } from "./transport/http.js";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 注册时声明的本机信息（非敏感，不含任何凭据）。 */
export interface DaemonRegistration {
  host_label: string;
  agent_kind: "codex" | "opencode" | "mock";
  capabilities: readonly Capability[];
  tool_versions?: Readonly<Record<string, string>>;
}

export interface DaemonOptions {
  config: ExecutorConfig;
  registration: DaemonRegistration;
  /** 协调系统仓库根目录（主仓库，非 worktree） */
  repo_root: string;
  /** worktree 存放根目录，例如 `<repo>/.local/worktrees` */
  worktree_root: string;
  /** OpenCode 模型。**必填**：不传会落到环境变量 provider 并 401 */
  model: string;
  /** 测试命令（固定程序 + 参数数组，不经 shell） */
  test_command?: TestCommand;
  /** 提示词构造；默认 `buildTaskPrompt` */
  prompt_for_task?: (task: TaskNode, lease: Lease) => string;
  poll_interval_ms?: number;
  /** 空闲轮询上限，超过即正常退出（空队列不是故障，但不能无限占用） */
  max_idle_polls?: number;
  /** 本次最多执行多少个 attempt（用于受控运行；默认不限） */
  max_attempts?: number;
  heartbeat_interval_ms?: number;
  agent_timeout_ms?: number;
  test_timeout_ms?: number;
  cleanup_worktree?: boolean;
  /** 是否在通过后推送任务分支 */
  enable_push?: boolean;
  /** 推送远端名，默认 `origin` */
  remote?: string;
  /** 取消信号（`Ctrl+C`） */
  signal?: AbortSignal;
  /** 日志出口；所有内容都会先经过凭据脱敏 */
  log?: (line: string) => void;
}

/** 单次尝试的编排函数（可注入，便于在无 git/无进程的环境下测试）。 */
export type AttemptRunner = (input: AttemptInput, deps: AttemptDeps) => Promise<AttemptOutcome>;

/** 推送结果。 */
export interface PushResult {
  pushed: boolean;
  error_code: ErrorCode | null;
  message: string | null;
}

export type PushFn = (input: {
  worktree_path: string;
  branch: string;
  remote: string;
}) => PushResult;

export interface DaemonDeps {
  /** 健康检查（`GET /v1/health`，免认证） */
  health: () => Promise<{ ok: boolean }>;
  registration: RegistrationTransport;
  acquirer: LeaseAcquirer;
  lease_transport: LeaseTransport;
  heartbeat_transport: HeartbeatTransport;
  recovery_transport: RecoveryTransport;
  result_reporter: ResultReporter;
  attempt_runner?: AttemptRunner;
  push_branch?: PushFn;
  clock?: LeaseClock;
  /** 读取在途记录（重启恢复用）；返回 null 表示无在途 */
  load_in_flight?: () => InFlightRecord | null;
  /** 写入/清除在途记录 */
  save_in_flight?: (record: InFlightRecord | null) => void;
}

/** 一次 attempt 的本地记录。 */
export interface DaemonAttemptRecord {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  result:
    | "reported"
    | "skipped_lease_lost"
    | "skipped_aborted"
    | "failed_to_report"
    | "refused_binding_incomplete";
  report_status: ResultStatus | null;
  pushed: boolean;
  error_code: ErrorCode | null;
}

export type DaemonStopReason =
  | "idle_limit"
  | "health_failed"
  | "registration_rejected"
  | "auth_blocked"
  | "offline"
  | "lease_lost"
  | "aborted"
  | "max_attempts_reached"
  | "halt_offline_on_recovery";

export interface DaemonReport {
  stop_reason: DaemonStopReason;
  health_ok: boolean;
  registered: boolean;
  recovery: RecoveryDecision | null;
  polls: number;
  attempts: readonly DaemonAttemptRecord[];
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/**
 * 由任务节点构造提示词。
 *
 * 只使用**结构化字段**拼接，不做任何 shell 解释；
 * 云端字符串始终是数据，不是命令（交接单 §4 末段）。
 */
export function buildTaskPrompt(task: TaskNode, lease: Lease): string {
  const lines: string[] = [
    `任务 ${task.task_id}（${task.kind}）：${task.title}`,
    "",
    "验收条件：",
    ...task.acceptance_criteria.map((criterion) => `- ${criterion}`),
    "",
    `Git 基线（base_sha）：${lease.binding.base_sha}`,
    `允许写入（allow）：${task.write_scope.allow.join(", ")}`,
  ];
  if (task.write_scope.deny.length > 0) {
    lines.push(`禁止写入（deny，优先级高于 allow）：${task.write_scope.deny.join(", ")}`);
  }
  if (task.expected_interfaces.length > 0) {
    lines.push("", "期望产出的接口：", ...task.expected_interfaces.map((item) => `- ${item}`));
  }
  lines.push(
    "",
    "要求：只修改允许范围内的文件；不要改动验收规则或 CI 配置；",
    "完成后在仓库根目录运行项目验证命令，并确保全绿。",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 在途记录（重启恢复）
 * ------------------------------------------------------------------ */

/** 在途记录的最小实现：写在 `.local/` 下（该目录已被 .gitignore 忽略）。 */
export function fileInFlightStore(
  repoRoot: string,
): Pick<DaemonDeps, "load_in_flight" | "save_in_flight"> {
  const file = join(repoRoot, ".local", "executor-in-flight.json");
  return {
    load_in_flight: (): InFlightRecord | null => {
      if (!existsSync(file)) return null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (parsed === null || typeof parsed !== "object") return null;
        const record = parsed as Partial<InFlightRecord>;
        if (typeof record.task_id !== "string" || typeof record.attempt_id !== "string") return null;
        return parsed as InFlightRecord;
      } catch {
        // 记录损坏：按「无在途」处理，但在日志里会说清楚（由调用方记录）
        return null;
      }
    },
    save_in_flight: (record: InFlightRecord | null): void => {
      if (record === null) {
        if (existsSync(file)) rmSync(file, { force: true });
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },
  };
}

/* ------------------------------------------------------------------ *
 * 推送
 * ------------------------------------------------------------------ */

/**
 * 推送任务分支。
 *
 * 用**参数数组**调用 git，不经 shell —— 分支名与远端名都来自结构化数据，
 * 即使含有特殊字符也不会被解释为命令。
 */
export function gitPushBranch(input: {
  worktree_path: string;
  branch: string;
  remote: string;
}): PushResult {
  const result = git(input.worktree_path, [
    "push",
    input.remote,
    `refs/heads/${input.branch}:refs/heads/${input.branch}`,
  ]);
  if (result.exit_code === 0) {
    return { pushed: true, error_code: null, message: null };
  }
  return {
    pushed: false,
    error_code: "PUSH_REJECTED",
    message: result.stderr.trim().slice(0, 500) || "git push 失败",
  };
}

/* ------------------------------------------------------------------ *
 * 真实 HTTP 依赖装配
 * ------------------------------------------------------------------ */

export function createHttpDaemonDeps(
  config: ExecutorConfig,
  overrides: Partial<DaemonDeps> = {},
): DaemonDeps {
  const client = new CoordinatorClient(config);
  return {
    health: () => client.health().then((result) => ({ ok: result.ok })),
    registration: new HttpRegistrationTransport(client),
    acquirer: new HttpLeaseAcquirer(client),
    lease_transport: new HttpLeaseTransport(client),
    heartbeat_transport: new HttpHeartbeatTransport(client),
    recovery_transport: new HttpRecoveryTransport(client),
    result_reporter: new HttpResultReporter(client),
    attempt_runner: runAttempt,
    push_branch: gitPushBranch,
    clock: systemClock,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function makeLogger(options: DaemonOptions): (line: string) => void {
  const sink = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  // 凭据红线：任何要落盘/上屏的内容都先脱敏。
  // 这样即使将来某条日志不小心带了请求头，也不会泄露 token。
  return (line: string) => sink(redactSecrets(line, [options.config.token]));
}

function httpStatusOf(error: unknown): number | null {
  return error instanceof CoordinatorHttpError ? error.status : null;
}

function errorCodeOf(error: unknown): ErrorCode {
  if (error instanceof CoordinatorHttpError) return error.code;
  return "INTERNAL_ERROR";
}

/**
 * 版本绑定四项必须齐全（AGENTS.md 规则 2）。
 *
 * 缺任一项**不得开工**。这里只做本地断言——服务端的 `LeaseSchema`
 * 本来就会拒绝缺项，本地断言是为了在契约被绕过时也能立刻停住，
 * 而不是带着半套绑定往下跑。
 */
export function findBindingProblem(lease: Lease): string | null {
  const binding = lease.binding as Partial<Lease["binding"]> | undefined;
  if (!binding) return "租约缺少 binding";
  const required: Array<keyof Lease["binding"]> = [
    "base_sha",
    "rules_sha",
    "contract_sha",
    "acceptance_sha",
  ];
  const missing = required.filter((key) => {
    const value = binding[key];
    return typeof value !== "string" || value.trim() === "";
  });
  return missing.length > 0 ? `版本绑定缺少：${missing.join(", ")}` : null;
}

/** 该错误码在协议里是不是 `blocked`（阻塞、不计返修）。 */
export function isBlockedCode(code: ErrorCode): boolean {
  return ERROR_POLICY[code].disposition === "blocked";
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

/**
 * 常驻主循环。
 *
 * 所有副作用都在本函数内被**显式判断后才发生**：
 * 推送与上报都有单独的前置条件，不做「跑完就上报」的隐式链路。
 */
export async function runDaemon(
  options: DaemonOptions,
  deps: DaemonDeps,
): Promise<DaemonReport> {
  const log = makeLogger(options);
  const clock: LeaseClock = deps.clock ?? systemClock;
  const runner: AttemptRunner = deps.attempt_runner ?? runAttempt;
  const attemptRecords: DaemonAttemptRecord[] = [];

  const report: DaemonReport = {
    stop_reason: "idle_limit",
    health_ok: false,
    registered: false,
    recovery: null,
    polls: 0,
    attempts: attemptRecords,
  };

  const aborted = (): boolean => options.signal?.aborted === true;

  /* --- 2. 健康检查 ------------------------------------------- */
  const health = await deps.health();
  if (!health.ok) {
    // 连不通就不做任何云端写操作，也不猜「可能只是这个端点挂了」。
    log("[health] Worker 健康检查未通过：停止，不进行任何云端写操作");
    report.stop_reason = "health_failed";
    return report;
  }
  report.health_ok = true;
  log(`[health] OK（${options.config.base_url}）`);

  /* --- 3. 注册 ------------------------------------------------ */
  const registration: ExecutorRegistration = {
    protocol_version: "1",
    executor_id: options.config.executor_id,
    host_label: options.registration.host_label,
    agent_kind: options.registration.agent_kind,
    capabilities: [...options.registration.capabilities] as ExecutorRegistration["capabilities"],
    tool_versions: { ...(options.registration.tool_versions ?? {}) },
    project_root: options.repo_root,
    registered_at: new Date(clock.now()).toISOString(),
  };

  try {
    const ack = await deps.registration.register(registration);
    if (!ack.registered) {
      log("[register] 服务端未确认注册：停止");
      report.stop_reason = "registration_rejected";
      return report;
    }
    report.registered = true;
    log(`[register] 已注册 ${ack.executor_id}（capabilities=${registration.capabilities.join(",")}）`);
  } catch (error) {
    const status = httpStatusOf(error);
    // 401/403 包含「Bearer 身份与 executor_id 不一致」（4503 EXECUTOR_IDENTITY_MISMATCH）。
    // 二者都属**凭据/身份问题**，必须人工介入，不计为代码返修。
    log(`[register] 注册被拒绝（HTTP ${status ?? "无"} / ${errorCodeOf(error)}）：停止`);
    report.stop_reason = "registration_rejected";
    return report;
  }

  /* --- 14. 重启恢复：先查归属，再决定 ------------------------- */
  const inFlight = deps.load_in_flight?.() ?? null;
  if (inFlight) {
    const decision = await decideRecovery({ record: inFlight }, deps.recovery_transport);
    report.recovery = decision;
    switch (decision.kind) {
      case "halt_offline":
        // 第 12 项：网络不可达时**不猜**任务仍归自己。
        log(`[recovery] 归属查询不可达（${decision.error}）：停止新操作`);
        report.stop_reason = "halt_offline_on_recovery";
        return report;
      case "resume":
        // 见文件头说明：能查出仍归我，但 B4 不具备断点续跑能力，
        // 因此显式放弃并清记录，而不是假装续跑。
        log(
          `[recovery] 在途 attempt 仍归本机（from_phase=${decision.from_phase ?? "none"}）：` +
            "B4 不支持断点续跑，放弃本地 attempt 并清理记录",
        );
        break;
      case "abandon_expired":
        log("[recovery] 在途 attempt 租约已过期：放弃，交由协调器重派");
        break;
      case "abandon_reassigned":
        log(`[recovery] 在途 attempt 已被重派给 ${decision.to_executor}：本地放手，不推送不上报`);
        break;
      case "abandon_unknown":
        log("[recovery] 在途 attempt 在云端不存在：清理本地记录");
        break;
    }
    deps.save_in_flight?.(null);
  }

  /* --- 5/4. 领取循环 ------------------------------------------ */
  const maxIdle = options.max_idle_polls ?? 3;
  const maxAttempts = options.max_attempts ?? Number.POSITIVE_INFINITY;
  const pollInterval = options.poll_interval_ms ?? 2_000;
  const hasPushCapability = options.registration.capabilities.includes("git_push");
  let idlePolls = 0;

  while (true) {
    if (aborted()) {
      log("[stop] 收到取消信号（Ctrl+C）：停止轮询");
      report.stop_reason = "aborted";
      break;
    }
    if (attemptRecords.length >= maxAttempts) {
      report.stop_reason = "max_attempts_reached";
      break;
    }
    if (idlePolls >= maxIdle) {
      // 空队列不是故障，但也不能无限占用本机与配额。
      log(`[poll] 连续 ${idlePolls} 次空队列：正常退出`);
      report.stop_reason = "idle_limit";
      break;
    }

    let acquisition: LeaseAcquisition;
    try {
      acquisition = await deps.acquirer.acquire({
        executor_id: options.config.executor_id,
        agent_kind: options.registration.agent_kind,
        capabilities: options.registration.capabilities,
      });
    } catch (error) {
      report.polls += 1;
      const status = httpStatusOf(error);
      if (status === 401 || status === 403) {
        // 第 10 项：认证失效 → blocked_auth。凭据问题，**不计返修**。
        log(`[lease] 认证失效（HTTP ${status}）：转 blocked_auth，停止领取`);
        report.stop_reason = "auth_blocked";
        break;
      }
      if (status === null) {
        // 第 12 项：网络不可达 → 停止领取新任务，不猜任务归属。
        log(`[lease] 协调器不可达（${errorCodeOf(error)}）：停止领取新任务`);
        report.stop_reason = "offline";
        break;
      }
      // 其余（429 / 5xx 已由客户端重试耗尽）：退避后继续，计入空闲上限防止死循环。
      idlePolls += 1;
      log(`[lease] 领取失败（HTTP ${status}）：退避 ${pollInterval}ms 后重试`);
      if (idlePolls < maxIdle) await clock.sleep(pollInterval);
      continue;
    }

    report.polls += 1;

    /* --- 5. 空队列：正常等待，不当故障 ----------------------- */
    if (acquisition.kind === "empty") {
      idlePolls += 1;
      log(`[lease] 空队列（第 ${idlePolls}/${maxIdle} 次）：正常等待，不视为故障`);
      if (idlePolls < maxIdle) await clock.sleep(pollInterval);
      continue;
    }

    idlePolls = 0;
    const { task, lease } = acquisition;
    log(`[lease] 领到 ${task.task_id} / ${lease.attempt_id}（epoch=${lease.lease_epoch}）`);

    /* --- 7. 版本绑定四项缺一不可 ---------------------------- */
    const bindingProblem = findBindingProblem(lease);
    if (bindingProblem !== null) {
      // 拒绝开工。**不构造伪造报告**：缺 binding 时无法构造与租约匹配的
      // 报告（服务端 `assertBindingMatches` 会比对四项），发出去只会得到 409。
      log(`[refuse] ${bindingProblem}：拒绝开工，需人工介入`);
      attemptRecords.push({
        task_id: task.task_id,
        attempt_id: lease.attempt_id,
        lease_epoch: lease.lease_epoch,
        result: "refused_binding_incomplete",
        report_status: null,
        pushed: false,
        error_code: "CONTRACT_MISMATCH",
      });
      continue;
    }

    /* --- 在途记录：供下次重启查询归属 ------------------------ */
    const worktreePath = join(options.worktree_root, lease.attempt_id);
    deps.save_in_flight?.({
      task_id: lease.task_id,
      attempt_id: lease.attempt_id,
      executor_id: lease.executor_id,
      lease_epoch: lease.lease_epoch,
      expired_at: lease.expires_at,
      worktree_path: worktreePath,
      completed_phases: [],
      local_commits: [],
    });

    /* --- 6. 编排一次 attempt（续租/心跳在内部先于 agent 启动）- */
    const promptBuilder = options.prompt_for_task ?? buildTaskPrompt;
    const attemptInput: AttemptInput = {
      lease,
      repo_root: options.repo_root,
      worktree_root: options.worktree_root,
      prompt: promptBuilder(task, lease),
      model: options.model,
      write_scope: task.write_scope as WriteScope,
      heartbeat_interval_ms: options.heartbeat_interval_ms ?? 15_000,
      cleanup_worktree: options.cleanup_worktree ?? true,
      ...(options.test_command !== undefined ? { test_command: options.test_command } : {}),
      ...(options.agent_timeout_ms !== undefined
        ? { agent_timeout_ms: options.agent_timeout_ms }
        : {}),
      ...(options.test_timeout_ms !== undefined ? { test_timeout_ms: options.test_timeout_ms } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    let outcome: AttemptOutcome;
    try {
      outcome = await runner(attemptInput, {
        lease_transport: deps.lease_transport,
        heartbeat_transport: deps.heartbeat_transport,
        clock,
      });
    } catch (error) {
      log(`[attempt] 编排异常（${errorCodeOf(error)}）：记录并继续`);
      attemptRecords.push({
        task_id: task.task_id,
        attempt_id: lease.attempt_id,
        lease_epoch: lease.lease_epoch,
        result: "failed_to_report",
        report_status: null,
        pushed: false,
        error_code: errorCodeOf(error),
      });
      deps.save_in_flight?.(null);
      continue;
    }

    /* --- 11/13. 租约失效或收到取消：不推送、不上报 ----------- */
    if (outcome.trace.sideEffectsSkipped || aborted()) {
      const cancelled = aborted();
      log(
        cancelled
          ? "[attempt] 收到取消信号：已终止子进程，不推送、不上报（租约将自然过期）"
          : `[attempt] 租约在运行期间失效（${outcome.trace.lease_lost_reason ?? "unknown"}）：不推送、不上报`,
      );
      attemptRecords.push({
        task_id: task.task_id,
        attempt_id: lease.attempt_id,
        lease_epoch: lease.lease_epoch,
        result: cancelled ? "skipped_aborted" : "skipped_lease_lost",
        report_status: outcome.report.status,
        pushed: false,
        error_code: cancelled ? null : "LEASE_EPOCH_STALE",
      });
      deps.save_in_flight?.(null);
      if (cancelled) {
        report.stop_reason = "aborted";
        break;
      }
      if (outcome.trace.lease_lost) {
        // 已被顶替：立即停止（继续领新任务只会制造更多冲突）
        report.stop_reason = "lease_lost";
        break;
      }
      continue;
    }

    /* --- 8. 仅在「通过 + 有推送能力 + 明确开启推送」时推送 ---- */
    let pushed = false;
    let reportToSend = outcome.report;
    const wouldPush = options.enable_push === true && hasPushCapability;
    if (wouldPush && outcome.report.status === "ready_for_integration") {
      const push = deps.push_branch?.({
        worktree_path: outcome.worktree_path,
        branch: `task/${lease.task_id}/${lease.attempt_id}`,
        remote: options.remote ?? "origin",
      }) ?? { pushed: false, error_code: "PUSH_REJECTED" as ErrorCode, message: "未配置推送实现" };
      pushed = push.pushed;
      if (pushed) {
        log(`[push] 已推送 task/${lease.task_id}/${lease.attempt_id}`);
      } else {
        // 推不上去就不能声称「可供整合」——head_sha 不在远端，
        // 协调器整合时会找不到提交。如实降级。
        log(`[push] 推送失败（${push.error_code ?? "PUSH_REJECTED"}）：报告降级为 failed`);
        reportToSend = {
          ...outcome.report,
          status: "failed",
          error_code: push.error_code ?? "PUSH_REJECTED",
          note: push.message,
        };
      }
    }

    /* --- 9. 上报（幂等键由服务端按 task/attempt/epoch 计算）--- */
    try {
      await deps.result_reporter.report(reportToSend);
      attemptRecords.push({
        task_id: task.task_id,
        attempt_id: lease.attempt_id,
        lease_epoch: lease.lease_epoch,
        result: "reported",
        report_status: reportToSend.status,
        pushed,
        error_code: null,
      });
      log(`[report] 已上报 ${task.task_id} / ${lease.attempt_id}：${reportToSend.status}`);
    } catch (error) {
      const status = httpStatusOf(error);
      attemptRecords.push({
        task_id: task.task_id,
        attempt_id: lease.attempt_id,
        lease_epoch: lease.lease_epoch,
        result: "failed_to_report",
        report_status: reportToSend.status,
        pushed,
        error_code: errorCodeOf(error),
      });
      if (status === 401 || status === 403) {
        log(`[report] 认证失效（HTTP ${status}）：转 blocked_auth，停止`);
        deps.save_in_flight?.(null);
        report.stop_reason = "auth_blocked";
        break;
      }
      if (status === 409) {
        // 该 attempt 已作废（epoch 过期/被顶替）：结果不能算数，停止。
        log("[report] 上报被拒（409，租赁已变更）：停止，不伪造成功");
        deps.save_in_flight?.(null);
        report.stop_reason = "lease_lost";
        break;
      }
      log(`[report] 上报失败（HTTP ${status ?? "无"} / ${errorCodeOf(error)}）：记录并继续`);
    }

    deps.save_in_flight?.(null);
  }

  return report;
}

/* ------------------------------------------------------------------ *
 * CLI 入口
 * ------------------------------------------------------------------ */

/** 环境变量名（与交接单 §7 一致，均为非敏感项）。 */
export const ENV_KEYS = {
  base_url: "COORDINATOR_BASE_URL",
  project_id: "PROJECT_ID",
  executor_id: "EXECUTOR_ID",
  token: "COORDINATOR_API_TOKEN",
  model: "OPENCODE_MODEL",
  host_label: "EXECUTOR_HOST_LABEL",
  repo_root: "EXECUTOR_REPO_ROOT",
  agent: "COORDINATOR_AGENT_KIND",
} as const;

/** 从环境变量装配运行参数。缺失配置抛 `MissingConfigError`，**不回退到占位值**。 */
export function loadDaemonOptions(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonOptions {
  // 复用既有校验：缺变量时一次性列出全部缺失项。
  const config = loadExecutorConfig(env);

  const repoRoot = env[ENV_KEYS.repo_root]?.trim() || process.cwd();
  const model = env[ENV_KEYS.model]?.trim();
  if (!model) {
    throw new Error(
      `缺少必需的环境变量：${ENV_KEYS.model}。` +
        `OpenCode 必须显式指定模型（形如 myapi/gpt-5.6-sol），不传会落到环境变量 provider 并返回 401。`,
    );
  }

  const rawKind = env[ENV_KEYS.agent]?.trim();
  const agentKind: DaemonRegistration["agent_kind"] =
    rawKind === "codex" || rawKind === "mock" ? rawKind : "opencode";

  // 能力按「本机真正具备什么」声明，不夸大：
  // 推送能力取决于是否显式开启，dry 模式声明 dry_run 而不声明 git_push。
  const enablePush = env["EXECUTOR_ENABLE_PUSH"] === "1";
  const capabilities: Capability[] = enablePush
    ? ["code", "test", "git_push"]
    : ["code", "test", "dry_run"];

  return {
    config,
    registration: {
      host_label: env[ENV_KEYS.host_label]?.trim() || "windows-executor",
      agent_kind: agentKind,
      capabilities,
    },
    repo_root: repoRoot,
    worktree_root: env["EXECUTOR_WORKTREE_ROOT"]?.trim() || join(repoRoot, ".local", "worktrees"),
    model,
    enable_push: enablePush,
    ...(env["EXECUTOR_TEST_COMMAND"]?.trim()
      ? { test_command: { executable: "npm", args: ["run", "check"] as const as string[] } }
      : {}),
    ...(env["EXECUTOR_MAX_IDLE_POLLS"]?.trim()
      ? { max_idle_polls: Number(env["EXECUTOR_MAX_IDLE_POLLS"]) }
      : {}),
    ...(env["EXECUTOR_MAX_ATTEMPTS"]?.trim()
      ? { max_attempts: Number(env["EXECUTOR_MAX_ATTEMPTS"]) }
      : {}),
  };
}

/**
 * 可执行入口。
 *
 * `Ctrl+C` 的处理：把 `SIGINT` 接到 `AbortController` 上，
 * 由主循环停止轮询、并由 agent 适配器终止子进程。
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = loadDaemonOptions(process.env);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deps = createHttpDaemonDeps(options.config, {
    ...fileInFlightStore(options.repo_root),
  });

  try {
    const report = await runDaemon({ ...options, signal: controller.signal }, deps);
    process.stdout.write(
      `\n[exit] stop_reason=${report.stop_reason} polls=${report.polls} ` +
        `attempts=${report.attempts.length} registered=${report.registered}\n`,
    );
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    return report.stop_reason === "health_failed" ||
      report.stop_reason === "registration_rejected"
      ? 1
      : 0;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** 直接执行本文件时才跑主流程；被 import 时保持无副作用。 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // 配置缺失属于「可读的启动失败」，打印原因即可，不打印任何凭据。
      process.stderr.write(`[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
