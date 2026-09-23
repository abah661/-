/**
 * 任务提交创建（B5，评审单 P0-2）。
 *
 * ## 为什么必须有这一层
 * `core/attempt.ts` 原先明确写着「执行器**不自行提交**」，只读取当前 HEAD。
 * 于是真实链路是：agent 改了文件但没有提交 → `HEAD === base_sha` →
 * 即使后续 `git push` 成功，远端也只拿到原基线。评审单 P0-2 判定这是阻塞缺陷：
 * 「没有可靠创建提交，推送可能只推回基线」。
 *
 * ## 本模块的边界
 * - 只做 Git 动作：暂存、列暂存清单、提交、读 HEAD。
 * - **不做判定**。写入范围与敏感文件由调用方（`core/attempt.ts`）在
 *   **暂存之后对暂存内容再查一次**——本模块不替它决定能不能提交。
 * - 所有 Git 调用一律**参数数组**，不经 shell。提交信息来自结构化字段，
 *   即使标题里带引号或换行也不会被解释。
 *
 * ## 为什么用两个 `-m` 而不是 `-F -`
 * 本项目的 `git()` 包装把 stdin 设为 `ignore`（见 `core/worktree.ts`），
 * 走管道传提交信息会静默拿到空标题。两个 `-m` 是唯一可靠写法。
 */

import type { ErrorCode } from "@dac/protocol";
import { git } from "./worktree.js";

/* ------------------------------------------------------------------ *
 * 暂存
 * ------------------------------------------------------------------ */

export interface StageResult {
  ok: boolean;
  error: string | null;
}

/** `git add -A`：暂存 worktree 内全部改动（含新增与删除）。 */
export function stageAllChanges(worktreePath: string): StageResult {
  const result = git(worktreePath, ["add", "-A"]);
  if (result.exit_code === 0) return { ok: true, error: null };
  return { ok: false, error: result.stderr.trim() || `git add 退出码 ${result.exit_code}` };
}

/**
 * 列出**已暂存**的文件（正斜杠）。
 *
 * 这是评审单「提交前再次检查实际 diff」的输入：查的是**即将进入这次提交的
 * 内容**，而不是工作区里可能尚未暂存的东西。两者在 `git add -A` 之后本应
 * 一致，但重查一次才能覆盖「两次查询之间文件又被改动」的窗口。
 */
export function listStagedFiles(worktreePath: string): readonly string[] {
  const result = git(worktreePath, ["diff", "--cached", "--name-only"]);
  if (result.exit_code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, "/"))
    .sort();
}

/* ------------------------------------------------------------------ *
 * 提交
 * ------------------------------------------------------------------ */

export interface CommitRequest {
  worktree_path: string;
  /** 标题，形如 `<TASK_ID>: <简述>` */
  subject: string;
  /** 正文：attempt 与四项冻结版本 */
  body: string;
}

export interface CommitResult {
  committed: boolean;
  /**
   * 提交号。**只能由 `git rev-parse HEAD` 读出**——
   * 评审单明确要求「不能由假体预填」。
   */
  sha: string | null;
  error_code: ErrorCode | null;
  message: string | null;
}

/** 读取 HEAD 的真实提交号。这是提交动作之后唯一可信的 SHA 来源。 */
export function readHeadSha(worktreePath: string): string | null {
  const result = git(worktreePath, ["rev-parse", "HEAD"]);
  if (result.exit_code !== 0) return null;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * 创建一次任务提交。
 *
 * 调用方必须**已经**确认：暂存内容在写入范围内、无敏感文件、测试全绿、
 * 租约仍有效。本函数不做这些判定，只做提交。
 */
export function createTaskCommit(request: CommitRequest): CommitResult {
  const commit = git(request.worktree_path, [
    "commit",
    "-m",
    request.subject,
    "-m",
    request.body,
  ]);
  if (commit.exit_code !== 0) {
    const detail =
      commit.stderr.trim().slice(0, 500) ||
      commit.stdout.trim().slice(0, 500) ||
      `git commit 退出码 ${commit.exit_code}`;
    return { committed: false, sha: null, error_code: "INTERNAL_ERROR", message: detail };
  }

  const sha = readHeadSha(request.worktree_path);
  if (sha === null) {
    // 提交真的成功了，但读不出 HEAD —— 这种情况不能假装有提交号可用。
    return {
      committed: true,
      sha: null,
      error_code: "INTERNAL_ERROR",
      message: "git commit 成功但无法读取 HEAD",
    };
  }
  return { committed: true, sha, error_code: null, message: null };
}

/* ------------------------------------------------------------------ *
 * 提交信息
 * ------------------------------------------------------------------ */

export interface CommitMessageInput {
  task_id: string;
  attempt_id: string;
  /** 四项冻结版本（规则 2） */
  binding: {
    base_sha: string;
    rules_sha: string;
    contract_sha: string;
    acceptance_sha: string;
  };
  /** 简述，通常是任务标题 */
  summary: string;
}

/** 标题上限：过长会让 `git log --oneline` 不可读，且部分工具会截断。 */
const SUBJECT_MAX = 200;

/**
 * 组装备份区间创建提交的标题与正文。
 *
 * 标题格式：`<TASK_ID>: <简述>`（评审单要求）。
 * 正文记录本次 attempt 与四项冻结版本——将来回看这次提交**依据什么版本做的**，
 * 不需要再去翻云端记录。
 */
export function buildCommitMessage(input: CommitMessageInput): {
  subject: string;
  body: string;
} {
  const summary = input.summary.replace(/\s+/g, " ").trim();
  const raw = `${input.task_id}: ${summary}`;
  const subject = raw.length > SUBJECT_MAX ? raw.slice(0, SUBJECT_MAX - 3) + "..." : raw;

  const body = [
    `attempt: ${input.attempt_id}`,
    "",
    "冻结版本（规则 2）：",
    `  base_sha:       ${input.binding.base_sha}`,
    `  rules_sha:      ${input.binding.rules_sha}`,
    `  contract_sha:   ${input.binding.contract_sha}`,
    `  acceptance_sha: ${input.binding.acceptance_sha}`,
    "",
    "本提交由 B 端执行器在校验（写入范围、敏感文件、测试证据、租约）通过后创建。",
  ].join("\n");

  return { subject, body };
}
