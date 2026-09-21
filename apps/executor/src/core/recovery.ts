/**
 * 重启恢复（第 8 节；README「Windows 重点测试」含休眠恢复）。
 *
 * 核心原则：**先向云端核对任务归属，再决定本地动作**。
 *
 * 进程可能在任意时刻被杀（崩溃、休眠、断电）。重启后本地只知道
 * 「上次我正在做 X」，但不知道：
 * - 租约是否还在我手上（可能已被重派给别人）
 * - 我上次是否已经推送成功（重复推送会被拒绝）
 *
 * 因此恢复流程不允许凭本地记录直接继续，必须先查云端。
 */

import { inspectWorktree, git } from "./worktree.js";
import { isLeaseExpired } from "./lease.js";
import type { Lease } from "@dac/protocol";

/** 本地持久化的在途任务记录（存于 .local/，忽略提交）。 */
export interface InFlightRecord {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  expired_at: string;
  worktree_path: string;
  /** 已完成的阶段，避免恢复时重复执行 */
  completed_phases: readonly string[];
  /** 已创建的本地提交（可能未推送） */
  local_commits: readonly string[];
}

/** 云端对「这个任务现在归谁」的回答。 */
export type TaskOwnership =
  | { kind: "still_mine"; lease: Lease }
  | { kind: "reassigned"; to_executor: string; attempt_id: string }
  | { kind: "unknown_task" }
  | { kind: "unreachable"; error: string };

export interface RecoveryTransport {
  queryOwnership(task_id: string, attempt_id: string): Promise<TaskOwnership>;
}

/** 恢复决策。**必须**先取得这个结论再动本地状态。 */
export type RecoveryDecision =
  /** 租约仍归我且未过期：可以继续未完成阶段 */
  | { kind: "resume"; from_phase: string | null }
  /** 租约仍归我但已过期：不继续，上报并让协调器重派 */
  | { kind: "abandon_expired" }
  /** 已被分派给其他执行器：本地必须完全放手，不得推送 */
  | { kind: "abandon_reassigned"; to_executor: string }
  /** 云端不可达：**停止新操作**，等恢复连接（第 7 节） */
  | { kind: "halt_offline"; error: string }
  /** 任务在云端不存在：本地记录是垃圾，清理 */
  | { kind: "abandon_unknown" };

export interface RecoveryInput {
  record: InFlightRecord;
  /** 本地 now()，用于过期判定 */
  now?: number;
}

/**
 * 决定恢复动作。
 *
 * 顺序刻意如此——**先判云端归属，再看本地租约时间，最后才看 worktree**：
 * 若已被重派，本地无论多完整都不能继续，否则会产生两方同时改同一任务。
 */
export async function decideRecovery(
  input: RecoveryInput,
  transport: RecoveryTransport,
): Promise<RecoveryDecision> {
  const { record } = input;
  const ownership = await transport.queryOwnership(record.task_id, record.attempt_id);

  switch (ownership.kind) {
    case "unreachable":
      // 第 7 节：断网后停止新操作。不猜、不继续。
      return { kind: "halt_offline", error: ownership.error };

    case "unknown_task":
      return { kind: "abandon_unknown" };

    case "reassigned":
      // 已有别人接手，本地立即放手。**不推送、不上报、不清理他人 worktree**。
      return { kind: "abandon_reassigned", to_executor: ownership.to_executor };

    case "still_mine": {
      // epoch 变更说明期间发生过重派后又回到我手上，本地缓存已失效。
      if (ownership.lease.lease_epoch !== record.lease_epoch) {
        return { kind: "abandon_reassigned", to_executor: ownership.lease.executor_id };
      }
      if (isLeaseExpired(ownership.lease, input.now ?? Date.now())) {
        return { kind: "abandon_expired" };
      }
      const lastPhase =
        record.completed_phases.length > 0
          ? record.completed_phases[record.completed_phases.length - 1]!
          : null;
      return { kind: "resume", from_phase: lastPhase };
    }
  }
}

/**
 * 恢复前的本地检查：worktree 是否还在、是否被外部改动过。
 *
 * 返回的问题列表为空才允许 resume。任何一项异常都应转人工，
 * 因为「本地状态与预期不符」意味着有并发写入或外部干扰。
 */
export interface LocalStateCheck {
  worktree_exists: boolean;
  is_git_repo: boolean;
  problems: readonly string[];
}

export function checkLocalState(record: InFlightRecord): LocalStateCheck {
  const problems: string[] = [];
  let worktreeExists = false;
  let isGitRepo = false;

  try {
    const status = git(record.worktree_path, ["rev-parse", "--is-inside-work-tree"]);
    isGitRepo = status.exit_code === 0 && status.stdout.trim() === "true";
    worktreeExists = isGitRepo;
    if (!isGitRepo) {
      problems.push(`worktree 路径不可用或不是 Git 工作区：${record.worktree_path}`);
    } else {
      const dirty = inspectWorktree(record.worktree_path);
      if (dirty.dirty) {
        problems.push(
          `worktree 有未提交改动（${dirty.modified.length} 个文件）。` +
            `重启前的在途改动无法确认归属，需人工判断是否保留。`,
        );
      }
      // 本地提交是否还在
      for (const sha of record.local_commits) {
        const exists = git(record.worktree_path, ["cat-file", "-e", `${sha}^{commit}`]);
        if (exists.exit_code !== 0) {
          problems.push(`记录中的本地提交已不存在：${sha}`);
        }
      }
    }
  } catch (error) {
    problems.push(`检查 worktree 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return { worktree_exists: worktreeExists, is_git_repo: isGitRepo, problems };
}

/**
 * 推送前核对：该提交是否已经在远端。
 *
 * 休眠/崩溃恢复后最常见的重复动作就是「再推一次」。
 * 先查远端可避免无谓的 PUSH_REJECTED 与误判。
 */
export function isCommitPushed(worktreePath: string, remote: string, sha: string): boolean {
  const result = git(worktreePath, ["branch", "-r", "--contains", sha]);
  if (result.exit_code !== 0) return false;
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(remote));
}
