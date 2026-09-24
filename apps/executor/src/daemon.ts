/**
 * 常驻执行器入口（TASK-B-EXECUTOR-B5，承接 B4 并修复评审单 6 项缺陷）。
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
 * | 7 | 使用任务绑定的四项 SHA | `findBindingProblem` |
 * | 8 | 租约有效 + diff 合法 + 无敏感文件才推送 | `trace.sideEffectsSkipped` + `report.status` |
 * | 9 | 固定幂等键回报结果 | 服务端按 task/attempt/epoch 自算 |
 * | 10 | `401/403` → `blocked_auth`，不计返修 | `stop_reason: "auth_blocked"` |
 * | 11 | `409` / 租约失效 → 停子进程，不推送不上报 | `sideEffectsSkipped` 分支 |
 * | 12 | 网络不可达 → 停止领取新任务 | `status === null` → `offline` |
 * | 13 | `Ctrl+C` → 停轮询/心跳/续租/子进程 | `signal` 透传到 agent 适配器 |
 * | 14 | 重启后先查归属再决定 | `decideRecovery` |
 *
 * ## B5 修复的真实链路缺陷（评审单）
 * | 缺陷 | 修法 |
 * | --- | --- |
 * | P0-1 推送前删 worktree | 常驻入口**始终**传 `cleanup_worktree: false`；清理推迟到推送、远端核对、上报全部结束之后，且必须显式开启 |
 * | P0-2 不创建提交 | `runAttempt` 在四道门全绿后创建提交，`head_sha` 取自真实 `rev-parse` |
 * | P0-3 只看推送退出码 | `gitPushBranch` push 后 `ls-remote` 核对远端 SHA，不一致即 `PUSH_REJECTED` |
 * | P0-4 未推送仍报可整合 | `ready_for_integration` 必须以「远端 SHA 核对一致」为前提，否则降级为 `blocked_approval` |
 * | P1-1 `still_mine` 后继续领取 | 安全停止并保留在途记录，不再进领取循环 |
 * | P1-2 自动删除在途记录 | 改为终态标记，**从不自动删除** |
 *
 * ## B6 补充（评审单：B5 的 P1-2 只完成了一半）
 * | 项 | 落点 |
 * | --- | --- |
 * | B6-1 终态记录仍被后续任务覆盖 | 记录改为一 attempt 一份：`.local/executor-attempts/<attempt_id>.json`；`load_in_flight` **只**加载仍为 `in_flight` 的记录 |
 * | B6-2 Windows 下裸名 `opencode` 必然 `ENOENT` | 新增 `adapters/opencode-launcher.ts`，解析出原生可执行文件或 `node.exe` + JS 入口后以**绝对路径 + 参数数组**启动，`shell: false` 不变 |
 *
 * ## 两条不可违反的红线
 * 1. **不猜**。云端没回答的事实一律不得用本地推断替代（网络不可达就是不可达）。
 * 2. **不假装成功**。自报完成不算完成；**没核对远端就不能说推送了**。
 *
 * ## 关于「不自动续跑未完成的 attempt」
 * 第 14 项要求「先查询归属，再决定继续或放弃」。B5 的实现是：
 * 查得出来、但**不续跑**——B5 不具备恢复中间 worktree 状态的能力，
 * 硬续跑会出现「两方同时改同一任务」。评审单 P1-1 因此要求：
 * `still_mine` 时必须**安全停止并保留记录**，等待租约自然到期或人工处理。
 * 真正的断点续跑属 P5 范围，此处不假装实现。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Capability, ErrorCode, ExecutorRegistration, Lease, ResultStatus, TaskNode, WriteScope } from "@dac/protocol";
import { ERROR_POLICY, blockedStatusFor } from "@dac/protocol";

import { runAttempt } from "./core/attempt.js";
import type { AttemptDeps, AttemptInput, AttemptOutcome, TestCommand } from "./core/attempt.js";
import type { OpenCodeProcessRunner } from "./adapters/opencode.js";
import {
  describeLaunchResolution,
  resolveOpenCodeLaunch,
} from "./adapters/opencode-launcher.js";
import type { OpenCodeLaunchConfig } from "./adapters/opencode-launcher.js";
import { readHeadSha } from "./core/commit.js";
import { systemClock } from "./core/lease.js";
import type { LeaseClock, LeaseTransport } from "./core/lease.js";
import type { HeartbeatTransport } from "./core/heartbeat.js";
import { decideRecovery } from "./core/recovery.js";
import type {
  InFlightRecord,
  InFlightState,
  RecoveryDecision,
  RecoveryTransport,
} from "./core/recovery.js";
import { git, removeWorktree } from "./core/worktree.js";
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
  /**
   * OpenCode 启动方式（B6-2）。
   *
   * 缺省时由 `adapters/opencode-launcher.ts` 从**本机环境**自动解析
   * （PATH / `npm_config_prefix` / `%APPDATA%\npm`）。
   * 这里只允许放本地路径，**不得硬编码任何用户目录**。
   */
  agent_launcher?: OpenCodeLaunchConfig;
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
  /**
   * 是否在**推送、远端 SHA 核对、结果上报全部结束之后**清理 worktree。
   *
   * 默认 `false`（B5，评审单 P0-1）。B4 默认 `true`，导致 worktree 在
   * `git push` 之前就被删掉——推送的工作目录根本不存在，真实推送必失败。
   *
   * 置为 `true` 也**不会**提前清理：清理点被固定在链路最末端。
   * 按项目清理规则，删除需要准确范围与批准，所以这里默认保留。
   */
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

/**
 * 推送结果（B5 扩展）。
 *
 * 评审单 P0-3：原实现的 `pushed` 只看 `git push` 的退出码。退出码为 0
 * **不等于**远端真的拿到了提交（推送被钩子改写、推到了别的 ref、
 * 凭证走了错误身份……）。因此现在必须回读远端 SHA 才能说 `pushed`。
 */
export interface PushResult {
  /** 仅当**远端 SHA 与本地 HEAD 逐字一致**时才为 true */
  pushed: boolean;
  error_code: ErrorCode | null;
  message: string | null;
  /** 推送后本地 `HEAD` 的真实提交号；读不到为 null */
  local_sha: string | null;
  /** `git ls-remote` 读到的远端任务分支提交号；读不到为 null */
  remote_sha: string | null;
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
  /**
   * agent 进程启动器（B5 补充项）。
   *
   * 常驻入口必须能把它透传给 `runAttempt`，否则**注入不到 agent 那一层**：
   * 编排里 `runAttempt` 会退回真实 `opencode` 可执行文件。B5 的真实链路
   * 测试正是踩到这一点——假 agent 只注入了直接调用 `runAttempt` 的用例，
   * 经常驻入口的用例仍在真实 `spawn opencode`（本机无此命令）。
   */
  agent_runner?: OpenCodeProcessRunner;
  push_branch?: PushFn;
  clock?: LeaseClock;
  /** 读取在途记录（重启恢复用）；返回 null 表示无在途 */
  load_in_flight?: () => InFlightRecord | null;
  /**
   * 写入在途记录。
   *
   * **不接受 `null`**（B5，评审单 P1-2）。B4 用 `save_in_flight(null)`
   * 表达「删掉记录」，那是把「运行完成」自动当成删除许可。
   * 现在结束一次 attempt 只能**推进状态**（见 `InFlightState`），
   * 记录一律留在磁盘上；真正清理走显式动作。
   */
  save_in_flight?: (record: InFlightRecord) => void;
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
  | "halt_offline_on_recovery"
  /** 重启后发现旧租约仍归本机，安全停止并保留记录（评审单 P1-1） */
  | "halt_still_mine";

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
    // B5（评审单 P0-2）：提交与推送由执行器统一负责。让 agent 也提交会造成
    // 「谁的提交算数」二义，所以这里明确禁止，执行器只认自己 `rev-parse` 读到的 HEAD。
    "不要自行执行 git commit 或 git push；改动留在工作区即可，",
    "提交与推送由执行器在校验（写入范围、敏感文件、测试证据、租约）通过后统一完成。",
  );
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * 在途记录（重启恢复）
 * ------------------------------------------------------------------ */

/**
 * 在途记录目录（B6-1，评审单）。
 *
 * ## 为什么从「一个文件」改成「一个目录」
 * B5 把所有 attempt 存进**同一个** `.local/executor-in-flight.json`，
 * 每次 `save_in_flight` 都整文件覆盖。于是下一次领取任务时
 * `markInFlight(newRecord, "in_flight")` 会把上一条终态记录直接抹掉：
 * 连续跑 N 个 attempt，磁盘上最多只剩最后一条。
 *
 * 那样一来「终态记录留在 `.local/` 里，可复查」只是纸面成立——B5 报告里
 * 这句话因此被评审驳回（B6-1）。现在改为**每个 attempt 一份、互不覆盖**：
 *
 * ```text
 * .local/executor-attempts/<attempt_id>.json
 * ```
 *
 * 记录**只能由它自己的 attempt 推进状态**，绝不会被后续任务覆盖或自动删除。
 */
export function inFlightDir(repoRoot: string): string {
  return join(repoRoot, ".local", "executor-attempts");
}

/**
 * 单个 attempt 的记录文件路径。
 *
 * `attempt_id` 做 URL 编码后再作文件名：既避免路径分隔符注入，
 * 又能容纳中文 —— 编码是**可逆的**，所以路径可以由 attempt_id 重算。
 */
export function inFlightRecordPath(repoRoot: string, attemptId: string): string {
  return join(inFlightDir(repoRoot), `${encodeURIComponent(attemptId)}.json`);
}

/** 解析单个记录文件；损坏或字段缺失时返回 null（跳过，不污染列表）。 */
function readInFlightFile(file: string): InFlightRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Partial<InFlightRecord>;
    if (typeof record.task_id !== "string" || typeof record.attempt_id !== "string") return null;
    return parsed as InFlightRecord;
  } catch {
    return null;
  }
}

/**
 * 一条记录是否仍代表**活动租约**。
 *
 * 只有 `in_flight` 算。B4 留下的旧记录没有 `state` 字段，
 * 按保守原则仍视为 `in_flight`（「不知道」不能当成「已终结」）。
 */
export function isActiveInFlightRecord(record: InFlightRecord): boolean {
  return record.state === undefined || record.state === "in_flight";
}

/**
 * 列出全部在途记录，**含终态**。按文件名排序（attempt_id 近似时间序）。
 *
 * 导出是为了让测试与人工排查能一次看到所有 attempt 的下场，
 * 而不只是「最后一条」。
 */
export function listInFlightRecords(repoRoot: string): readonly InFlightRecord[] {
  const dir = inFlightDir(repoRoot);
  if (!existsSync(dir)) return [];
  let names: readonly string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const records: InFlightRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readInFlightFile(join(dir, name));
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * 在途记录的最小实现：每 attempt 一个文件，写在 `.local/` 下
 * （该目录已被 .gitignore 忽略）。
 *
 * ## 两条不可动摇的语义
 * 1. **互不覆盖**（B6-1）：写入只针对 `record.attempt_id` 自己的文件。
 * 2. **只写不删**（B5 评审 P1-2）：这里没有任何删除路径，结束一次 attempt
 *    只能推进 `state`。B4 的 `save_in_flight(null)` → `rmSync` 把「跑完了」
 *    当成了删除许可，已被移除。
 *
 * 真正要清理必须调用 {@link clearInFlightRecord}，那是一个**显式动作**，
 * 常驻入口在任何自动路径里都不会调用它。
 */
export function fileInFlightStore(
  repoRoot: string,
): Pick<DaemonDeps, "load_in_flight" | "save_in_flight"> {
  return {
    load_in_flight: (): InFlightRecord | null => {
      // **只加载仍为 `in_flight` 的记录**：终态记录（reported / failed_* /
      // abandoned_* / halted_still_mine）不得再被当成活动租约去查归属、
      // 更不能被再次恢复执行。
      const active = listInFlightRecords(repoRoot).filter(isActiveInFlightRecord);
      // 多条活动记录意味着并发在途（异常）。取**最早**的一条走归属查询，
      // 其余原样保留——不擅自替别的 attempt 做决定，也不删它们的记录。
      return active[0] ?? null;
    },
    save_in_flight: (record: InFlightRecord): void => {
      const file = inFlightRecordPath(repoRoot, record.attempt_id);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    },
  };
}

/**
 * 显式清理**单个** attempt 的在途记录。
 *
 * **这不是常驻入口的自动路径**。按项目清理规则，删除需要准确范围与批准，
 * 因此本函数只应由「人工确认后执行的一次性动作」调用，且必须点名 attempt_id——
 * 「清空整个目录」这种粗粒度动作不在本函数能力范围内。
 * 常驻入口在任何情况下都不会调用它（这是评审单 P1-2 的核心要求）。
 */
export function clearInFlightRecord(
  repoRoot: string,
  attemptId: string,
): { removed: boolean; path: string } {
  const file = inFlightRecordPath(repoRoot, attemptId);
  if (!existsSync(file)) return { removed: false, path: file };
  rmSync(file, { force: true });
  return { removed: true, path: file };
}

/* ------------------------------------------------------------------ *
 * 推送
 * ------------------------------------------------------------------ */

/**
 * 读取远端某个分支的提交号。
 *
 * ## 两个必须记住的细节
 * 1. `git ls-remote` 的输出是**制表符分隔**（`<sha>\t<ref>`）。必须按
 *    `/\s+/` 切分——按单个空格切会让 `sha\tref` 粘成一个字段，比较永远失败。
 * 2. 远端没有该分支时返回 `sha: null, error: null`——**这是正常情况**
 *    （首次推送前就该是这样），不是错误。
 */
export function readRemoteBranchSha(
  repoPath: string,
  remote: string,
  branch: string,
): { sha: string | null; error: string | null } {
  const ref = `refs/heads/${branch}`;
  const result = git(repoPath, ["ls-remote", remote, ref]);
  if (result.exit_code !== 0) {
    return {
      sha: null,
      error: result.stderr.trim().slice(0, 500) || `git ls-remote 退出码 ${result.exit_code}`,
    };
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/).filter((part) => part.length > 0);
    if (parts.length >= 2 && parts[1] === ref) return { sha: parts[0] ?? null, error: null };
  }
  return { sha: null, error: null };
}

/**
 * 推送任务分支，并**核对远端结果**。
 *
 * 评审单 P0-3：退出码为 0 **不等于**远端真的拿到了提交。因此本函数在推送后：
 * 1. 读本地 `HEAD`；
 * 2. 用结构化参数执行 `git ls-remote <remote> refs/heads/<branch>`；
 * 3. **仅在两者逐字一致时**才返回 `pushed: true`；否则一律 `PUSH_REJECTED`。
 *
 * 不一致或无法核对时**绝不**返回成功——否则会向上报出「可供整合」，
 * 而那个提交可能只存在于本机，A 端根本取不到。
 *
 * 用**参数数组**调用 git，不经 shell —— 分支名与远端名都来自结构化数据，
 * 即使含有特殊字符也不会被解释为命令。
 */
export function gitPushBranch(input: {
  worktree_path: string;
  branch: string;
  remote: string;
}): PushResult {
  const push = git(input.worktree_path, [
    "push",
    input.remote,
    `refs/heads/${input.branch}:refs/heads/${input.branch}`,
  ]);
  if (push.exit_code !== 0) {
    return {
      pushed: false,
      error_code: "PUSH_REJECTED",
      message: push.stderr.trim().slice(0, 500) || "git push 失败",
      local_sha: null,
      remote_sha: null,
    };
  }

  const localSha = readHeadSha(input.worktree_path);
  if (localSha === null) {
    return {
      pushed: false,
      error_code: "PUSH_REJECTED",
      message: "推送后无法读取本地 HEAD，无法核对远端",
      local_sha: null,
      remote_sha: null,
    };
  }

  const remote = readRemoteBranchSha(input.worktree_path, input.remote, input.branch);
  if (remote.error !== null) {
    return {
      pushed: false,
      error_code: "PUSH_REJECTED",
      message: `无法核对远端：${remote.error}`,
      local_sha: localSha,
      remote_sha: null,
    };
  }
  if (remote.sha === null) {
    return {
      pushed: false,
      error_code: "PUSH_REJECTED",
      message: `远端不存在 refs/heads/${input.branch}`,
      local_sha: localSha,
      remote_sha: null,
    };
  }
  if (remote.sha !== localSha) {
    return {
      pushed: false,
      error_code: "PUSH_REJECTED",
      message:
        `远端 SHA 与本地 HEAD 不一致（本地 ${localSha.slice(0, 10)} / ` +
        `远端 ${remote.sha.slice(0, 10)}）`,
      local_sha: localSha,
      remote_sha: remote.sha,
    };
  }

  return {
    pushed: true,
    error_code: null,
    message: null,
    local_sha: localSha,
    remote_sha: remote.sha,
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

  /**
   * 推进在途记录的状态（B5，评审单 P1-2）。
   *
   * **只写不删，且只写自己那一份**。`save_in_flight` 不接受 `null`，
   * 所以这里唯一能做的事就是把 `state` 往前推一格、把变更时间记下来。
   * 记录落在 `.local/executor-attempts/<attempt_id>.json`（B6-1），
   * 且**只被它自己的 attempt 推进**——后续任务不会覆盖它。
   */
  const markInFlight = (record: InFlightRecord, state: InFlightState): void => {
    try {
      deps.save_in_flight?.({
        ...record,
        state,
        state_updated_at: new Date(clock.now()).toISOString(),
      });
    } catch {
      // 记录写不进去不应掩盖主流程结果；但必须留痕。
      log(`[in-flight] 状态写入失败（state=${state}）：继续，不影响本次结果`);
    }
  };

  /**
   * worktree 的**唯一**清理点（评审单 P0-1）。
   *
   * 位置刻意放在「提交 → 推送 → 远端 SHA 核对 → 上报」全部结束之后：
   * B4 让 `runAttempt` 在 `finally` 里就把目录删了，而推送发生在其后，
   * 于是 `git push` 的工作目录根本不存在——真实推送必失败。
   *
   * 默认**不清理**（`options.cleanup_worktree` 默认 `false`）。
   * 即使显式开启，清理也只发生在这一个位置。
   */
  const finalizeWorktree = (worktreePath: string, attemptId: string): void => {
    if (options.cleanup_worktree !== true) return;
    if (!existsSync(worktreePath)) return;
    const removed = removeWorktree(options.repo_root, worktreePath, true);
    log(
      removed
        ? `[worktree] 已按显式配置清理 ${attemptId} 的 worktree（清理点在推送与上报之后）`
        : `[worktree] 清理 ${attemptId} 的 worktree 失败：保留，需人工处理`,
    );
  };

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
        // 记录**原样保留**——还没拿到云端结论，不得推进状态。
        log(`[recovery] 归属查询不可达（${decision.error}）：停止新操作，保留在途记录`);
        report.stop_reason = "halt_offline_on_recovery";
        return report;

      case "resume":
        // 评审单 P1-1：服务端确认旧租约**仍归本机**，而 B5 不具备断点续跑能力。
        // 此时必须**安全停止**：
        //   - 不领取新任务：旧租约还在我手上，再领一份会让同一执行器同时持两份租约，
        //     旧 attempt 就永远没人收尾；
        //   - 不推送、不上报：本地状态与云端不一致，构造不出正确的报告；
        //   - 不删除记录：那是把「停止」当成删除许可。
        // 等旧租约自然到期，或人工处理后，再重启本进程。
        markInFlight(inFlight, "halted_still_mine");
        log(
          `[recovery] 在途 attempt 仍归本机（from_phase=${decision.from_phase ?? "none"}）：` +
            "B5 不具备断点续跑能力，安全停止并保留在途记录。" +
            "等待租约到期或人工处理后重启；本次不领取新任务、不推送、不上报",
        );
        report.stop_reason = "halt_still_mine";
        return report;

      case "abandon_expired":
        // 服务端已确认过期：本机不再是持有者，可以继续领取新任务。
        markInFlight(inFlight, "abandoned_expired");
        log("[recovery] 在途 attempt 租约已过期：放弃，交由协调器重派（记录保留为终态）");
        break;

      case "abandon_reassigned":
        markInFlight(inFlight, "abandoned_reassigned");
        log(
          `[recovery] 在途 attempt 已被重派给 ${decision.to_executor}：` +
            "本地放手，不推送不上报（记录保留为终态）",
        );
        break;

      case "abandon_unknown":
        markInFlight(inFlight, "abandoned_unknown");
        log("[recovery] 在途 attempt 在云端不存在：记录保留为终态");
        break;
    }
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
    const flightRecord: InFlightRecord = {
      task_id: lease.task_id,
      attempt_id: lease.attempt_id,
      executor_id: lease.executor_id,
      lease_epoch: lease.lease_epoch,
      expired_at: lease.expires_at,
      worktree_path: worktreePath,
      completed_phases: [],
      local_commits: [],
      state: "in_flight",
    };
    markInFlight(flightRecord, "in_flight");

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
      // 评审单 P0-1：**始终**不在编排内部清理。worktree 必须活到
      // 「提交 → 推送 → 远端 SHA 核对 → 上报」全部结束之后；
      // B4 在这里传的是 `options.cleanup_worktree ?? true`，
      // 于是 worktree 在 `git push` 之前就没了，真实推送必失败。
      // 是否清理改由链路最末端的 `finalizeWorktree` 决定（默认不清理）。
      cleanup_worktree: false,
      // 评审单 P0-2：提交由执行器创建，简述取任务标题。
      commit_spec: { summary: task.title },
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
        ...(deps.agent_runner !== undefined ? { agent_runner: deps.agent_runner } : {}),
        // B6-2：启动方式与 `agent_runner` 同一层往下传。不给时由适配器
        // 自动解析本机环境——**不要**在这里塞任何写死的路径。
        ...(options.agent_launcher !== undefined
          ? { agent_config: { launcher: options.agent_launcher } }
          : {}),
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
      markInFlight(flightRecord, "failed_orchestration");
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
      markInFlight(flightRecord, cancelled ? "skipped_aborted" : "skipped_lease_lost");
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

    /* --- 8. 推送与「可整合」的前置条件（评审单 P0-3 / P0-4）--- */
    let pushed = false;
    let reportToSend = outcome.report;
    const wouldPush = options.enable_push === true && hasPushCapability;

    if (reportToSend.status === "ready_for_integration") {
      if (!wouldPush) {
        // 评审单 P0-4：**未推送不得声称可整合**。
        // B4 在这里直接跳过推送、原样上报 ready_for_integration，协调器于是
        // 以为有个提交可供整合——而那个提交只存在于本机，A 端根本取不到。
        // 现在明确降级为「需要批准」，并按协议给出 UNAUTHORIZED_OPERATION。
        log(
          "[push] 无推送授权（未开启 enable_push 或未声明 git_push 能力）：" +
            "不得声称可供整合 → 降级为 blocked_approval",
        );
        reportToSend = {
          ...reportToSend,
          status: blockedStatusFor("UNAUTHORIZED_OPERATION") as ResultStatus,
          error_code: "UNAUTHORIZED_OPERATION",
          note: "本地提交未推送，远端不存在对应提交，无可整合成果",
        };
      } else {
        const branch = `task/${lease.task_id}/${lease.attempt_id}`;
        const push = deps.push_branch?.({
          worktree_path: outcome.worktree_path,
          branch,
          remote: options.remote ?? "origin",
        }) ?? {
          pushed: false,
          error_code: "PUSH_REJECTED" as ErrorCode,
          message: "未配置推送实现",
          local_sha: null,
          remote_sha: null,
        };
        pushed = push.pushed;
        if (pushed) {
          // 只有「远端 SHA 与本地 HEAD 逐字一致」才会走到这里（P0-3）
          log(
            `[push] 已推送并核对远端 ${branch}` +
              `（远端 ${(push.remote_sha ?? "").slice(0, 10)}）`,
          );
        } else {
          // 推不上去、或推了但核对不一致，都不能声称「可供整合」——
          // head_sha 不在远端，协调器整合时找不到提交。如实降级。
          log(`[push] 推送未通过核对（${push.error_code ?? "PUSH_REJECTED"}）：报告降级为 failed`);
          reportToSend = {
            ...reportToSend,
            status: "failed",
            error_code: push.error_code ?? "PUSH_REJECTED",
            note: push.message,
          };
        }
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
      markInFlight(flightRecord, "reported");
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
      markInFlight(flightRecord, "failed_to_report");
      if (status === 401 || status === 403) {
        log(`[report] 认证失效（HTTP ${status}）：转 blocked_auth，停止`);
        report.stop_reason = "auth_blocked";
        break;
      }
      if (status === 409) {
        // 该 attempt 已作废（epoch 过期/被顶替）：结果不能算数，停止。
        log("[report] 上报被拒（409，租赁已变更）：停止，不伪造成功");
        report.stop_reason = "lease_lost";
        break;
      }
      log(`[report] 上报失败（HTTP ${status ?? "无"} / ${errorCodeOf(error)}）：记录并继续`);
    }

    // 清理点固定在链路最末端：提交、推送、远端核对、上报都已结束。
    finalizeWorktree(outcome.worktree_path, lease.attempt_id);
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
  /**
   * OpenCode 启动方式（B6-2）。四项都**可选**：一个都不给就自动解析。
   * 全部是**本机路径**，不含凭据。
   */
  opencode_exe: "EXECUTOR_OPENCODE_EXE",
  opencode_js_entry: "EXECUTOR_OPENCODE_JS_ENTRY",
  opencode_node: "EXECUTOR_OPENCODE_NODE",
  opencode_search_dirs: "EXECUTOR_OPENCODE_SEARCH_DIRS",
} as const;

/**
 * 从环境变量装配 OpenCode 启动方式（B6-2）。
 *
 * **全部可选**：一个都没给时返回 `undefined`，由适配器
 * （`adapters/opencode-launcher.ts`）从 PATH / npm 全局目录自动解析——
 * 这是常规路径，因为「路径来自本机环境」正是 A 端的要求。
 *
 * 显式给了就以显式值为准：显式值指向不存在的文件时**明确失败**，
 * 不会静默退回裸命令名去撞 `ENOENT`。
 */
function buildLauncherConfig(
  env: Readonly<Record<string, string | undefined>>,
): OpenCodeLaunchConfig | undefined {
  const exe = env[ENV_KEYS.opencode_exe]?.trim();
  const jsEntry = env[ENV_KEYS.opencode_js_entry]?.trim();
  const nodePath = env[ENV_KEYS.opencode_node]?.trim();
  const searchRaw = env[ENV_KEYS.opencode_search_dirs]?.trim();

  const searchDirs =
    searchRaw === undefined || searchRaw === ""
      ? []
      : searchRaw
          .split(process.platform === "win32" ? ";" : ":")
          .map((part) => part.trim())
          .filter((part) => part !== "");

  const config: OpenCodeLaunchConfig = {};
  if (exe !== undefined && exe !== "") config.exe_path = exe;
  if (jsEntry !== undefined && jsEntry !== "") config.js_entry = jsEntry;
  if (nodePath !== undefined && nodePath !== "") config.node_path = nodePath;
  if (searchDirs.length > 0) config.search_dirs = searchDirs;

  return Object.keys(config).length > 0 ? config : undefined;
}

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

  // B6-2：启动方式优先取显式配置，缺省由适配器从本机环境解析。
  const launcher = buildLauncherConfig(env);

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
    ...(launcher !== undefined ? { agent_launcher: launcher } : {}),
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

  /*
   * B6-2：启动时就把「用哪种方式启动 OpenCode」打出来。
   * 解析失败时连**搜索过的路径**一起列出——否则 Windows 上的 `ENOENT`
   * 只能靠猜。两种情况下日志都不含凭据（只有本机文件路径）。
   */
  const launch = resolveOpenCodeLaunch(
    options.agent_launcher !== undefined ? { configured: options.agent_launcher } : {},
  );
  process.stdout.write(`[launch] ${describeLaunchResolution(launch)}\n`);

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
