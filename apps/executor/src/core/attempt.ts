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
import { runOpenCodeTask } from "../adapters/opencode.js";

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
      deps.agent_config ?? {},
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
        const stagedFiles = listStagedFiles(worktreePath);
        const stagedViolations = stagedFiles.filter((path) =>
          !isPathAllowed(path, input.write_scope),
        );
        const stagedSensitive = findSensitiveTouches(stagedFiles);

        if (stagedViolations.length > 0) {
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
      commit: trace.commit,
      changed_files: changedFiles,
      raw_test_output: rawTestOutput,
    };
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
