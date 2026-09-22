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
 * ## 三条不可违反的时序约束
 * 1. **续租必须先于 agent 启动**——否则 agent 跑长命令时租约会在中途过期。
 * 2. **租约丢失后不得推送、不得上报**。`onLeaseLost` 会立刻记录，
 *    并且本模块在返回前复查，把 `push_skipped_due_to_lease_loss` 显式暴露。
 * 3. **只有仍持有租约时才清理 worktree**——已被重派时别人可能正在用该目录。
 */

import { join } from "node:path";
import type { Lease, ResultReport, TestEvidence, WriteScope } from "@dac/protocol";
import { LeaseGuard } from "../core/lease.js";
import type { LeaseClock, LeaseTransport } from "../core/lease.js";
import { Heartbeat } from "../core/heartbeat.js";
import type { ExecutorPhase, HeartbeatTransport } from "../core/heartbeat.js";
import { checkDiffScope, findSensitiveTouches } from "../core/diff-check.js";
import { collectEvidence } from "../core/evidence.js";
import { git, inspectWorktree, prepareWorktree, removeWorktree } from "../core/worktree.js";
import { normalizeResult } from "../result/normalize.js";
import type { OpenCodeAdapterResult, OpenCodeProcessRunner } from "../adapters/opencode.js";
import { runOpenCodeTask } from "../adapters/opencode.js";

/* ------------------------------------------------------------------ *
 * 编排输入
 * ------------------------------------------------------------------ */

/** 测试命令：固定程序 + 参数数组（不经 shell）。 */
export interface TestCommand {
  executable: string;
  args: readonly string[];
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
}

export interface AttemptDeps {
  lease_transport: LeaseTransport;
  heartbeat_transport: HeartbeatTransport;
  clock?: LeaseClock;
  agent_runner?: OpenCodeProcessRunner;
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
  /** 变更文件列表 */
  changed_files: readonly string[];
  /** 原始测试输出，供写入本地 artifact */
  raw_test_output: string;
}

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/** 取当前 HEAD 提交号；失败返回 null（不猜）。 */
function headSha(repoPath: string): string | null {
  const result = git(repoPath, ["rev-parse", "HEAD"]);
  if (result.exit_code !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

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
  };

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
    const agentResult: OpenCodeAdapterResult = await runOpenCodeTask(
      {
        prompt: input.prompt,
        cwd: worktreePath,
        model: input.model,
        ...(input.agent_timeout_ms !== undefined ? { timeout_ms: input.agent_timeout_ms } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
      {},
      deps.agent_runner as OpenCodeProcessRunner,
    );

    /* --- 4. 核对写入范围 -------------------------------------- */
    setPhase("checking_diff");
    const diff = checkDiffScope({
      worktree_path: worktreePath,
      base_sha: lease.binding.base_sha,
      scope: input.write_scope,
    });
    const changedFiles = diff.changed_files;
    const sensitive = findSensitiveTouches(changedFiles);

    /* --- 5. 测试证据 ------------------------------------------ */
    setPhase("running_tests");
    const evidenceId = `EVID-${lease.task_id}-${lease.attempt_id}-${input.evidence_seq ?? 1}`;
    let evidence: TestEvidence | null = null;
    let rawTestOutput = "";

    if (input.test_command) {
      const collected = await collectEvidence({
        command: [input.test_command.executable, ...input.test_command.args],
        cwd: worktreePath,
        timeout_ms: input.test_timeout_ms ?? 600_000,
        evidence_id: evidenceId,
      });
      evidence = collected.evidence;
      rawTestOutput = `${collected.raw_stdout}\n${collected.raw_stderr}`;
    }

    /* --- 6. 计算 head_sha 与本地提交 --------------------------- */
    setPhase("committing");
    const head = headSha(worktreePath) ?? lease.binding.base_sha;
    // 执行器**不自行提交**——提交由任务契约决定。
    // 这里只记录「当前 HEAD 是否已偏离基线」，供归一化层判断
    //（head_sha === base_sha 会被判为无产出并降级）。
    const localCommits: readonly string[] =
      head === lease.binding.base_sha ? [] : [head];

    /* --- 7. 归一化 -------------------------------------------- */
    setPhase("reporting");
    const report = normalizeResult({
      lease,
      adapter: agentResult,
      diff,
      evidence,
      base_sha: lease.binding.base_sha,
      head_sha: head,
      sensitive_touches: sensitive,
      commit_shas: localCommits,
      note: trace.lease_lost
        ? `租约在运行期间丢失（${trace.lease_lost_reason ?? "unknown"}），已放弃推送`
        : null,
      reported_at: new Date(now()).toISOString(),
    });

    if (guard.lost) trace.sideEffectsSkipped = true;

    return {
      report,
      trace,
      worktree_removed: false,
      worktree_path: worktreePath,
      local_commits: localCommits,
      changed_files: changedFiles,
      raw_test_output: rawTestOutput,
    };
  } finally {
    // 顺序：先停心跳与续租，再考虑清理（避免清理时仍在续租）
    heartbeat.markStopping();
    heartbeat.stop();
    guard.stop();
    await renewLoop;

    // 时序约束 3：只有仍持有租约时才清理
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
    return { exists: true, dirty: status.dirty, head_sha: headSha(worktreePath) };
  } catch {
    return { exists: false, dirty: false, head_sha: null };
  }
}
