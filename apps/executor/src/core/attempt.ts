/**
 * 执行器常驻入口编排（第 8 节全流程）。
 *
 * ## 职责边界
 * 本模块**只做编排**：按第 8 节把已有的构件串起来，并在每个阶段切换
 * 心跳 `phase`。所有实际逻辑都在各自的模块里：
 *
 * | 阶段 | 模块 |
 * | --- | --- |
 * | 准备 worktree | `core/worktree.ts` |
 * | 起独立续租 | `core/lease.ts` |
 * | 上报存活 | `core/heartbeat.ts` |
 * | 跑 agent | `adapters/opencode.ts` |
 * | 核对写入范围 | `core/diff-check.ts` |
 * | 收集测试证据 | `core/evidence.ts` |
 * | 归一化结果 | `result/normalize.ts` |
 *
 * ## 四条不可违反的时序约束
 * 1. **续租必须先于 agent 启动**——否则 agent 跑长命令时租约会在中途过期。
 * 2. **租约丢失后不得提交、不得推送、不得上报**。`onLeaseLost` 会立刻记录，
 *    并且本模块在返回前复查，把 `push_skipped_due_to_lease_loss` 显式暴露。
 * 3. **worktree 默认不清理**。推送与远端 SHA 核对需要这个目录存在
 *    （评审单 P0-1：原实现在推送前就把目录删了，真实推送必失败）。
 *    是否清理由调用方在**推送与上报全部结束之后**决定。
 * 4. **提交只能在校验全绿后发生**（评审单 P0-2）。四道门是：写入范围合规、
 *    无敏感文件、测试证据全绿、租约仍有效。任一门未过即不提交，
 *    由归一化层如实降级——不允许「越界文件被提交进任务分支」这种状态。
 */

import { join } from "node:path";
import type { Lease, ResultReport, TestEvidence, WriteScope } from "@dac/protocol";
import { LeaseGuard } from "../core/lease.js";
import type { LeaseClock, LeaseTransport } from "../core/lease.js";
import { Heartbeat } from "../core/heartbeat.js";
import type { ExecutorPhase, HeartbeatTransport } from "../core/heartbeat.js";
import { checkDiffScope, findSensitiveTouches, isPathAllowed } from "../core/diff-check.js";
import {
  buildCommitMessage,
  createTaskCommit,
  listStagedFiles,
  readHeadSha,
  stageAllChanges,
} from "../core/commit.js";
import type { CommitResult } from "../core/commit.js";
import { collectEvidence } from "../core/evidence.js";
import { inspectWorktree, prepareWorktree, removeWorktree } from "../core/worktree.js";
import { normalizeResult } from "../result/normalize.js";
import type {
  OpenCodeAdapterConfig,
  OpenCodeAdapterResult,
  OpenCodeProcessRunner,
} from "../adapters/opencode.js";
import { OpenCodePreStartError, runOpenCodeTask } from "../adapters/opencode.js";
import type { OpenCodeProcessState } from "../adapters/opencode.js";

/* ------------------------------------------------------------------ *
 * 编排输入
 * ------------------------------------------------------------------ */

/** 测试命令：固定程序 + 参数数组（不经 shell）。 */
export interface TestCommand {
  executable: string;
  args: readonly string[];
}

/**
 * 提交规格（B5，评审单 P0-2）。
 *
 * 由调用方按任务给出。**缺失即不创建提交**——`plan` / `diagnose` 这类
 * 可能天然没有产出的任务走这条路，此时 `head_sha` 仍等于 `base_sha`，
 * 归一化层会如实降级，而不是伪造一个空提交。
 */
export interface CommitSpec {
  /** 简述，用于组成 `<TASK_ID>: <简述>`；通常是任务标题 */
  summary: string;
}

export interface AttemptInput {
  /** 区段一：租约。`expires_at` 必填，用于 `LeaseGuard` 计算剩余时间。 */
  lease: Lease;
  /** 工作仓库根目录（主仓库，非 worktree） */
  repo_root: string;
  /** worktree 存放根目录，例如 `<repo>/.local/worktrees` */
  worktree_root: string;
  /** 提示词 */
  prompt: string;
  /** 模型（必填，见 OpenCode 适配器约束：不传会 401） */
  model: string;
  /** 写入范围 */
  write_scope: WriteScope;
  /** 测试命令；未提供则视为「无测试」，结果会因缺证据而降级 */
  test_command?: TestCommand;
  /** agent 超时毫秒数 */
  agent_timeout_ms?: number;
  /**
   * 外部取消信号（Ctrl+C）。透传给 agent 适配器，用于真正终止子进程。
   * 置位后本函数仍按正常路径返回，但调用方**不得**再推送或上报。
   */
  signal?: AbortSignal;
  /** 测试超时毫秒数 */
  test_timeout_ms?: number;
  /** 续租与心跳间隔毫秒数 */
  heartbeat_interval_ms: number;
  /** 是否在结束后清理 worktree */
  cleanup_worktree?: boolean;
  /** 证据编号前缀，形如 EVID-<TASK>-<ATTEMPT>-<序号> */
  evidence_seq?: number;
  /**
   * 提交规格（B5）。提供时，四道门全绿后由执行器创建提交；
   * 未提供则不创建（见 `CommitSpec` 说明）。
   */
  commit_spec?: CommitSpec;
}

export interface AttemptDeps {
  lease_transport: LeaseTransport;
  heartbeat_transport: HeartbeatTransport;
  clock?: LeaseClock;
  agent_runner?: OpenCodeProcessRunner;
  /**
   * agent 适配器配置（B6-2）。
   *
   * 常驻入口必须把它透传下来，否则编排里只能退回默认启动方式——
   * 在 Windows 上那就是裸名 `opencode`，必然 `ENOENT`。
   * 与 `agent_runner` 同一层：**只允许经依赖注入往下传**，不读全局环境。
   */
  agent_config?: OpenCodeAdapterConfig;
  /** 注入 now() 便于测试确定性 */
  now?: () => number;
}

/** 一步编排的可观测轨迹，便于测试与排障。 */
export interface AttemptTrace {
  phases: ExecutorPhase[];
  lease_lost: boolean;
  lease_lost_reason: string | null;
  /** 是否因为租约丢失而放弃后续副作用（推送/清理） */
  sideEffectsSkipped: boolean;
  /** worktree 是否创建成功 */
  worktree_ready: boolean;
  /** 本次是否创建了提交（含提交失败的结果），未尝试时为 null */
  commit: CommitResult | null;
  /** 未创建提交时的具体原因。**排障用**：能看出是四道门里的哪一道没过 */
  commit_skipped_reason: string | null;
  /**
   * 测试/agent 进程**未能被终止**（B8，A 端 B7-1）。
   *
   * 为 true 时有残留进程可能仍占用 worktree 与文件锁。常驻入口据此
   * **停止领取新任务**并要求人工处理，而不是继续下一轮轮询。
   */
  kill_failed: boolean;
  /**
   * Git 核对是否失败（B8，A 端 B7-2）。
   *
   * 非 null 表示「无法确认是否越界」——不是「确认没有越界」。
   * 调用方**不得**据此提交或推送。
   */
  git_error: string | null;
  /**
   * 本次 attempt 结束时，本机**可证明的进程状态**（B11，A 端 B10 复验 §a）。
   *
   * 常驻入口据此决定「能不能继续领任务」：`residual` / `unknown` 都必须停机
   * 并保留门禁记录。之所以要放进 trace：**正常返回**也可能带着状态未知的进程
   * （例如 agent 超时且始终未观察到关闭）。异常分支之外的那条路径过去完全
   * 没有被检查过 —— 只覆盖异常分支，等于只覆盖了一半。
   */
  process_state: AttemptProcessState;
}

/* ------------------------------------------------------------------ *
 * 进程状态与编排异常（B10，A 端 B9 复验 §4）
 * ------------------------------------------------------------------ */

/**
 * 一次 attempt **异常退出**时，本机可证明的进程状态。
 *
 * A 端复验单要的是「四种状态」而不是一个布尔，理由很直接：
 * **「异常」不等于「进程已停止」**。之前 `runAttempt` 抛异常时，
 * 常驻入口只看到「抛了个错」，于是把「本机可能有进程还在跑」这件事
 * 当成「没有进程」处理，继续领取下一个任务 —— 这就是被点名的 fail-open。
 *
 * - `not_started`：可证明异常发生在任何 agent / 测试进程启动**之前**；
 * - `stopped`    ：可证明进程已退出（拿到过退出码）；
 * - `residual`   ：已确认进程**没有**被终止（`kill_failed`）；
 * - `unknown`    ：无法证明进程是否还在跑。
 *
 * `unknown` 既不等于 `stopped`，也不允许冒充 `residual` ——
 * 它是「不知道」，而不知道在进程可能仍占用 worktree 的场景下同样不安全。
 */
export type AttemptProcessState = "not_started" | "stopped" | "residual" | "unknown";

/**
 * 编排异常（B10，A 端 B9 复验 §4）。
 *
 * 为什么要包一层而不是原样抛出：异常的**形态**里不携带「进程现在在哪」，
 * 调用方无法据此判断能不能安全继续。包成这个类型后，`process_state` 是
 * 强制字段 —— 想抛异常就必须先回答「进程状态是什么」，不允许留空由
 * 调用方去猜（猜的结果过去就是「当成没有进程」）。
 */
export class AttemptOrchestrationError extends Error {
  readonly process_state: AttemptProcessState;

  constructor(message: string, process_state: AttemptProcessState, cause: unknown) {
    super(message);
    this.name = "AttemptOrchestrationError";
    this.process_state = process_state;
    // 保留原始异常：上层沿用原有的错误码分类（见 `errorCodeOf`），
    // 不要把 `CoordinatorHttpError` 之类的既有分类信息丢掉。
    this.cause = cause;
  }
}

/** 进程状态的人话说明，供日志与上报备注复用（避免两处措辞不一致）。 */
export function describeProcessState(state: AttemptProcessState): string {
  switch (state) {
    case "not_started":
      return "异常发生在进程启动之前（无残留风险）";
    case "stopped":
      return "进程已确认退出";
    case "residual":
      return "进程**已确认未被终止**（kill_failed）";
    case "unknown":
      return "**无法证明**进程已退出（状态未知）";
  }
}

/* ------------------------------------------------------------------ *
 * 进程状态判定辅助（B11，A 端 B10 复验 §a）
 * ------------------------------------------------------------------ */

/**
 * 适配器进程状态 → 编排层进程状态。
 *
 * `spawn_failed` 是「可证明进程从未存在」，等价于 `not_started`；
 * 其余三种同名直传。**不要**在这里做任何「看起来差不多」的合并：
 * 合并的代价正是这次返修要修掉的那类错误。
 */
export function mapAdapterProcessState(state: OpenCodeProcessState): AttemptProcessState {
  switch (state) {
    case "spawn_failed":
      return "not_started";
    case "stopped":
      return "stopped";
    case "residual":
      return "residual";
    case "unknown":
      return "unknown";
  }
}

/**
 * 该进程状态是否**不允许**继续开工（B11，A 端 B10 复验 §a）。
 *
 * `residual`（确认杀不掉）与 `unknown`（无法证明已退出）都必须停机：
 * 两者都可能仍有进程占用 worktree 与文件锁，继续领任务只会制造更多
 * 无法解释的失败。`not_started` / `stopped` 才是可以安全继续的两种。
 */
export function isUnsafeProcessState(state: AttemptProcessState): boolean {
  return state === "residual" || state === "unknown";
}

/**
 * 不安全进程状态对应的在途记录状态（B11，A 端 B10 复验 §a）。
 *
 * 两种状态**命名分立**：`residual` 是「已确认杀不掉」，`unknown` 是
 * 「无法证明已退出」。两者都要人工介入，但把后者说成前者就是伪造证据。
 * 只应在 {@link isUnsafeProcessState} 为真时调用。
 */
export function haltedStateFor(
  state: AttemptProcessState,
): "halted_residual_process" | "halted_process_unknown" {
  return state === "residual" ? "halted_residual_process" : "halted_process_unknown";
}

/** 不安全进程状态对应的停机原因，与 {@link haltedStateFor} 一一对应。 */
export function haltStopReasonFor(
  state: AttemptProcessState,
): "halt_residual_process" | "halt_process_unknown" {
  return state === "residual" ? "halt_residual_process" : "halt_process_unknown";
}

/**
 * 从 trace 汇总出「是否需要停机」（B11，A 端 B10 复验 §a）。
 *
 * 输入刻意取**两个**信号：`process_state` 是主判据，`kill_failed` 是它对应的
 * 旧信号。二者本应一致（attempt 层在 `kill_failed` 时把状态置为 `residual`），
 * 真出现不一致时这里**取更严的一档**：停机判据宁愿多停一次（代价是一次人工
 * 确认），也不能漏停（代价是残留进程与新任务并行抢同一个 worktree）。
 *
 * `not_started` / `stopped` 且未 `kill_failed` 时返回 `unsafe: false`。
 */
export function haltSignalOf(trace: {
  kill_failed: boolean;
  process_state: AttemptProcessState;
}): { unsafe: boolean; state: AttemptProcessState } {
  if (trace.process_state === "residual") return { unsafe: true, state: "residual" };
  if (trace.process_state === "unknown") return { unsafe: true, state: "unknown" };
  if (trace.kill_failed) return { unsafe: true, state: "residual" };
  return { unsafe: false, state: trace.process_state };
}

export interface AttemptOutcome {
  report: ResultReport;
  trace: AttemptTrace;
  /** worktree 是否已清理 */
  worktree_removed: boolean;
  /** worktree 实际路径 */
  worktree_path: string;
  /** 本地提交哈希（空数组表示未提交） */
  local_commits: readonly string[];
  /** 本次创建的提交（未创建为 null） */
  commit: CommitResult | null;
  /** 变更文件列表 */
  changed_files: readonly string[];
  /** 原始测试输出，供写入本地 artifact */
  raw_test_output: string;
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 编排实现
 * ------------------------------------------------------------------ */

/**
 * 执行一次任务尝试，返回归一化后的结果报告。
 *
 * **本函数不推送、不改远端状态**——推送与上报由调用方在确认
 * `trace.sideEffectsSkipped === false` 后进行。这样「是否允许产生副作用」
 * 是一个显式判断，而不是埋在函数内部的隐式行为。
 */
export async function runAttempt(input: AttemptInput, deps: AttemptDeps): Promise<AttemptOutcome> {
  const now = deps.now ?? Date.now;
  const phases: ExecutorPhase[] = [];
  const trace: AttemptTrace = {
    phases,
    lease_lost: false,
    lease_lost_reason: null,
    sideEffectsSkipped: false,
    worktree_ready: false,
    commit: null,
    commit_skipped_reason: null,
    kill_failed: false,
    git_error: null,
    process_state: "not_started",
  };

  /**
   * 本机进程状态记账（B10，A 端 B9 复验 §4）。
   *
   * 初始为 `not_started`：还没碰过任何子进程，异常一定安全。
   * 之后每跨过一个「可能已有进程存在」的边界就更新一次，
   * 保证**任何时刻抛出都能说出进程在哪**。
   */
  let processState: AttemptProcessState = "not_started";

  const { lease } = input;
  const worktreePath = join(input.worktree_root, lease.attempt_id);
  const branch = `task/${lease.task_id}/${lease.attempt_id}`;

  /* --- 心跳与续租：两者独立，互不代替 --------------------------- */

  const heartbeat = new Heartbeat(lease.executor_id, deps.heartbeat_transport, {
    heartbeat_interval_ms: input.heartbeat_interval_ms,
    ...(deps.clock ? { clock: deps.clock } : {}),
    // 心跳失败只记录，绝不改变任务状态（契约：心跳不代替续租）
    onError: () => {
      /* 静默：心跳失败是观测问题，不是任务问题 */
    },
  });

  const guard = new LeaseGuard(lease, deps.lease_transport, {
    heartbeat_interval_ms: input.heartbeat_interval_ms,
    ...(deps.clock ? { clock: deps.clock } : {}),
    onLeaseLost: (reason) => {
      trace.lease_lost = true;
      trace.lease_lost_reason = reason;
    },
  });

  const setPhase = (phase: ExecutorPhase, detail?: string): void => {
    phases.push(phase);
    heartbeat.setPhase(phase, detail);
  };

  // running 必须带完整租约三元组（契约 §1）
  heartbeat.markRunning({
    task_id: lease.task_id,
    attempt_id: lease.attempt_id,
    lease_epoch: guard.lease_epoch,
  });
  heartbeat.start();
  // 独立续租循环先于 agent 启动（时序约束 1）
  const renewLoop = guard.start();

  try {
    /* --- 1. 准备 worktree ------------------------------------- */
    setPhase("preparing_worktree");
    prepareWorktree({
      repo_root: input.repo_root,
      worktree_root: input.worktree_root,
      base_sha: lease.binding.base_sha,
      task_id: lease.task_id,
      attempt_id: lease.attempt_id,
      branch,
    });
    trace.worktree_ready = true;

    /* --- 2. 加载上下文 ---------------------------------------- */
    setPhase("loading_context");

    /* --- 3. 跑 agent ------------------------------------------ */
    setPhase("running_agent");
    // B10（A 端 B9 复验 §4）：从这一行起，本机**可能**出现一个 agent 进程。
    // 若此后抛异常，而没拿到退出码，就无从证明它已结束 —— 先按「未知」记账；
    // 正常返回后再按引擎给出的退出事实改写为 stopped / unknown。
    // 刻意**不**在这里记 `not_started`：那会把「可能已在跑」说成「肯定没在跑」。
    processState = "unknown";
    const agentResult: OpenCodeAdapterResult = await runOpenCodeTask(
      {
        prompt: input.prompt,
        cwd: worktreePath,
        model: input.model,
        ...(input.agent_timeout_ms !== undefined ? { timeout_ms: input.agent_timeout_ms } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
      deps.agent_config ?? {},
      deps.agent_runner as OpenCodeProcessRunner,
    );

    // B11（A 端 B10 复验 §a）：进程状态**由适配器给出**，不再由退出码反推。
    //
    // 旧写法 `exit_code !== null ? "stopped" : "unknown"` 两个方向都错：
    //  - 进程被信号终止时「确实已退出」却拿不到数字退出码 → 被误判 unknown，
    //    于是执行器为一个其实干净的结束停在人工门禁上；
    //  - `spawn_failed` 时进程「根本没启动」，退出码同样兑现成 null → 一并
    //    落进 unknown，把「没起来」说成「去向不明」。
    // 现在三种事实分别记账（关闭事件 / 主动探测 / 启动失败），见适配器。
    processState = mapAdapterProcessState(agentResult.process_state);
    trace.process_state = processState;

    /* --- 4. 核对写入范围 -------------------------------------- */
    setPhase("checking_diff");
    const diff = checkDiffScope({
      worktree_path: worktreePath,
      base_sha: lease.binding.base_sha,
      scope: input.write_scope,
    });
    // B8（A 端 B7-2）：核对本身失败也要暴露，且**一律不提交**。
    if (diff.error !== null) trace.git_error = diff.error;
    const changedFiles = diff.changed_files;
    const sensitive = findSensitiveTouches(changedFiles);

    /* --- 5. 测试证据 ------------------------------------------ */
    setPhase("running_tests");
    const evidenceId = `EVID-${lease.task_id}-${lease.attempt_id}-${input.evidence_seq ?? 1}`;
    let evidence: TestEvidence | null = null;
    let rawTestOutput = "";
    /** 测试进程终止过程的异常说明（B7）；正常为 null */
    let terminationDetail: string | null = null;

    if (input.test_command) {
      const collected = await collectEvidence({
        command: [input.test_command.executable, ...input.test_command.args],
        cwd: worktreePath,
        timeout_ms: input.test_timeout_ms ?? 600_000,
        evidence_id: evidenceId,
      });
      evidence = collected.evidence;
      rawTestOutput = `${collected.raw_stdout}\n${collected.raw_stderr}`;
      terminationDetail = collected.termination_detail;
      // B8（A 端 B7-1）：杀不掉的进程必须成为**显式信号**，
      // 而不是只留一句备注。常驻入口据此停机。
      trace.kill_failed = collected.kill_failed;
      // B10（A 端 B9 复验 §4）：测试进程已确认杀不掉 → `residual`，这是
      // 最坏的一种，不允许被后来的步骤回退成 `stopped`。
      // 只在 kill_failed 时改写：agent 那次若本来就「未知」，
      // 不能因为这次测试进程干净退出就被洗白。
      if (collected.kill_failed) processState = "residual";
      trace.process_state = processState;
    }

    /* --- 6. 创建提交（B5，评审单 P0-2）------------------------- */
    setPhase("committing");

    // 四道门 + 两项空产物保护。任一未过就**不提交**，交给归一化层如实降级；
    // 绝不能出现「越界或敏感文件被提交进任务分支」这种事后无法解释的状态。
    const evidenceGreen =
      evidence !== null && evidence.exit_code === 0 && evidence.summary.failed === 0;
    const commitSpec = input.commit_spec ?? null;

    let commitBlockedReason: string | null = null;
    if (commitSpec === null) {
      commitBlockedReason = "调用方未提供 commit_spec";
    } else if (diff.error !== null) {
      // B8（A 端 B7-2）：**核对失败即未通过**。
      // 「读不出 git 状态」绝不能被当成「没有越界」而放行提交。
      commitBlockedReason = `Git 核对失败，无法确认写入范围：${diff.error}`;
    } else if (sensitive.length > 0) {
      commitBlockedReason = `触碰敏感文件：${sensitive.join(", ")}`;
    } else if (!diff.ok) {
      commitBlockedReason = `越界文件：${diff.violations.join(", ")}`;
    } else if (!evidenceGreen) {
      commitBlockedReason = "测试证据未全绿";
    } else if (guard.lost) {
      commitBlockedReason = "租约已失效";
    } else if (diff.changed_files.length === 0) {
      commitBlockedReason = "与基线无差异";
    }

    if (commitBlockedReason !== null) {
      trace.commit_skipped_reason = commitBlockedReason;
    } else if (commitSpec === null) {
      // 逻辑上不可达（上面已置过 reason）。保留此分支只为让类型收窄：
      // 走到 else 时 commitSpec 必然非空。
      trace.commit_skipped_reason = "调用方未提供 commit_spec";
    } else {
      const staged = stageAllChanges(worktreePath);
      if (!staged.ok) {
        trace.commit_skipped_reason = `暂存失败：${staged.error ?? "unknown"}`;
      } else {
        // 提交前**对暂存内容再查一次**（评审单要求）：
        // 这次查的是即将进入提交的东西，而不是工作区里可能尚未暂存的。
        const stagedList = listStagedFiles(worktreePath);
        const stagedFiles = stagedList.files;
        const stagedViolations = stagedFiles.filter((path) =>
          !isPathAllowed(path, input.write_scope),
        );
        const stagedSensitive = findSensitiveTouches(stagedFiles);

        if (stagedList.error !== null) {
          // B8（A 端 B7-2）：读不出暂存内容 ≠ 没有待提交内容。一律不提交。
          trace.commit_skipped_reason = `暂存内容核对失败：${stagedList.error}`;
          trace.git_error = stagedList.error;
        } else if (stagedViolations.length > 0) {
          trace.commit_skipped_reason = `暂存内容越界：${stagedViolations.join(", ")}`;
        } else if (stagedSensitive.length > 0) {
          trace.commit_skipped_reason = `暂存内容含敏感文件：${stagedSensitive.join(", ")}`;
        } else if (stagedFiles.length === 0) {
          // 无待提交内容：agent 可能已自行提交。**不造空提交**，
          // 下面用 rev-parse 读出真实 HEAD 沿用。
          trace.commit_skipped_reason = "无待提交内容（沿用已有 HEAD）";
        } else {
          const message = buildCommitMessage({
            task_id: lease.task_id,
            attempt_id: lease.attempt_id,
            binding: lease.binding,
            summary: commitSpec.summary,
          });
          const created = createTaskCommit({
            worktree_path: worktreePath,
            subject: message.subject,
            body: message.body,
          });
          trace.commit = created;
          if (!created.committed) {
            trace.commit_skipped_reason = `提交失败：${created.message ?? "unknown"}`;
          }
        }
      }
    }

    // 提交号**只能来自真实的 `git rev-parse HEAD`**，不得由假体预填。
    const head = readHeadSha(worktreePath) ?? lease.binding.base_sha;
    // `head_sha === base_sha` 会被归一化层判为无产出并降级。
    const localCommits: readonly string[] = head === lease.binding.base_sha ? [] : [head];

    /* --- 7. 归一化 -------------------------------------------- */
    setPhase("reporting");
    // B7：终止异常必须出现在上报备注里。否则云端只看到 exit_code=1，
    // 无法区分「测试真的失败」与「进程杀不掉、需要人工介入」。
    const noteParts: string[] = [];
    if (trace.lease_lost) {
      noteParts.push(`租约在运行期间丢失（${trace.lease_lost_reason ?? "unknown"}），已放弃推送`);
    }
    if (terminationDetail !== null) {
      noteParts.push(`测试进程终止异常：${terminationDetail}`);
    }
    const report = normalizeResult({
      lease,
      adapter: agentResult,
      diff,
      evidence,
      base_sha: lease.binding.base_sha,
      head_sha: head,
      sensitive_touches: sensitive,
      commit_shas: localCommits,
      note: noteParts.length > 0 ? noteParts.join("；") : null,
      reported_at: new Date(now()).toISOString(),
    });

    if (guard.lost) trace.sideEffectsSkipped = true;

    // 兜底同步：常驻入口在**正常返回**路径上读的就是这个字段（B11）。
    trace.process_state = processState;

    return {
      report,
      trace,
      worktree_removed: false,
      worktree_path: worktreePath,
      local_commits: localCommits,
      commit: trace.commit,
      changed_files: changedFiles,
      raw_test_output: rawTestOutput,
    };
  } catch (error) {
    // B10（A 端 B9 复验 §4）：异常**不再原样抛出**。
    //
    // 原实现把内部异常直接丢给常驻入口，而异常形态里没有「进程现在在哪」，
    // 入口只能记一句 failed_orchestration 然后继续领任务 —— 那条路径在
    // 子进程已启动时是 fail-open。
    //
    // 现在：`OpenCodePreStartError` 是**可证明**的「启动前失败」（进程还没
    // 被创建），按 `not_started` 处理；其余一律沿用前面逐段记账的
    // `processState`。**绝不在这里默认成 `stopped`** —— 拿不到证据就是 `unknown`。
    const state: AttemptProcessState =
      error instanceof OpenCodePreStartError ? "not_started" : processState;
    const detail = error instanceof Error ? error.message : String(error);
    throw new AttemptOrchestrationError(
      `编排异常（${describeProcessState(state)}）：${detail}`,
      state,
      error,
    );
  } finally {
    // 顺序：先停心跳与续租，再考虑清理（避免清理时仍在续租）
    heartbeat.markStopping();
    heartbeat.stop();
    guard.stop();
    await renewLoop;

    // 时序约束 3：默认**不清理**。推送与远端 SHA 核对需要该目录存在，
    // 是否清理由调用方在推送与上报全部结束之后决定（评审单 P0-1）。
    if (input.cleanup_worktree && !trace.lease_lost && trace.worktree_ready) {
      try {
        removeWorktree(input.repo_root, worktreePath, true);
        trace.phases.push("reporting");
      } catch {
        /* 清理失败不掩盖主结果 */
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 可观测辅助
 * ------------------------------------------------------------------ */

/** 汇总 worktree 当前状态，供上报前复核。 */
export function describeWorktree(worktreePath: string): {
  exists: boolean;
  dirty: boolean;
  head_sha: string | null;
} {
  try {
    const status = inspectWorktree(worktreePath);
    return { exists: true, dirty: status.dirty, head_sha: readHeadSha(worktreePath) };
  } catch {
    return { exists: false, dirty: false, head_sha: null };
  }
}
