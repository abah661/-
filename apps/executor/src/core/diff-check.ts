/**
 * 实际 Git diff 与写入范围核对（规则 3，错误码 DIFF_OUT_OF_SCOPE）。
 *
 * 规则 3 的关键点：`write_scope` 只是**声明**，强制检查必须在执行器侧
 * 用**实际 diff** 复核。agent 自称「只改了几个文件」不足为凭。
 *
 * glob 语义刻意保持简单可预测：
 * - `*`  匹配单层内的任意字符（不含 `/`）
 * - `**` 匹配任意层（含 `/`）
 * - 末尾 `/**` 匹配该目录下全部内容
 * 不引入完整 glob 库，避免两端实现对同一模式的解释不一致。
 */

import { git } from "./worktree.js";
import type { WriteScope } from "@dac/protocol";

/** 把 glob 编译为锚定的正则。 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` 表示「任意层，可以零层」；裸 `**` 表示任意内容
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * 判断某路径是否在写入范围内。
 *
 * `deny` 优先级**高于** `allow`：即使 allow 命中也拒绝。
 * 这与 AGENTS.md 的表述一致——禁止项是硬边界，不是参考。
 */
export function isPathAllowed(path: string, scope: WriteScope): boolean {
  // 统一为正斜杠，避免 Windows 反斜杠导致 glob 失配
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (matchesAny(normalized, scope.deny)) return false;
  return matchesAny(normalized, scope.allow);
}

export interface DiffCheckInput {
  /** worktree 路径 */
  worktree_path: string;
  /** 基线提交号（任务开工时的 base_sha） */
  base_sha: string;
  /** 声明的写入范围 */
  scope: WriteScope;
}

export interface DiffCheckResult {
  /** 实际变更的文件（相对路径，正斜杠） */
  changed_files: readonly string[];
  /** 越界文件 */
  violations: readonly string[];
  /** 合规为 true；有 violations 即为 false */
  ok: boolean;
  /** 是否存在未提交改动（有则说明尚未 commit，需先提交再看） */
  has_uncommitted: boolean;
}

/** 列出 base_sha 与当前 HEAD（或工作区）之间的变更文件。 */
export function listChangedFiles(worktreePath: string, baseSha: string): readonly string[] {
  const names = new Set<string>();

  // 已提交部分：base..HEAD
  const committed = git(worktreePath, ["diff", "--name-only", `${baseSha}..HEAD`]);
  if (committed.exit_code === 0) {
    for (const line of committed.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) names.add(trimmed.replace(/\\/g, "/"));
    }
  }

  // 未提交部分：相对 HEAD 的改动 + 暂存区
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = git(worktreePath, args);
    if (result.exit_code !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) names.add(trimmed.replace(/\\/g, "/"));
    }
  }

  return [...names].sort();
}

/**
 * 用实际 diff 与声明范围核对。
 *
 * 注意：**新增文件也算变更**。只在「已跟踪文件」上做比对会漏掉
 * 「偷偷新建一个越界文件」这类越界（与冻结守卫那次「逐文件比对发现不了增」
 * 是同一类疏漏，已在此显式处理）。
 */
export function checkDiffScope(input: DiffCheckInput): DiffCheckResult {
  const changed = listChangedFiles(input.worktree_path, input.base_sha);
  const violations = changed.filter((path) => !isPathAllowed(path, input.scope));
  const status = git(input.worktree_path, ["status", "--porcelain"]);
  const hasUncommitted =
    status.exit_code === 0 &&
    status.stdout.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("??"));

  return {
    changed_files: changed,
    violations,
    ok: violations.length === 0,
    has_uncommitted: hasUncommitted,
  };
}

/**
 * 是否触碰了敏感文件（错误码 SENSITIVE_FILE_DETECTED，需授权介入）。
 *
 * B5 补充了**凭据容器**类扩展名（`.pfx` / `.p12` / `.p7m`）。评审单 P0-2 要求
 * 「不得提交范围外或敏感文件」，而这三类恰恰是本项目 Token 交接会用到的格式
 * （见交接单 §6：`.cer` → `.p7m`）。它们一旦出现在提交里就是凭据泄露，
 * 因此宁可在这里多拦一层，也不依赖写入范围声明去挡。
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/auth.json",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/credentials.json",
  "**/.credentials.json",
  // 凭据容器（B5 新增）
  "**/*.pfx",
  "**/*.p12",
  "**/*.p7m",
];

export function findSensitiveTouches(changedFiles: readonly string[]): readonly string[] {
  return changedFiles.filter((path) => matchesAny(path, SENSITIVE_PATH_PATTERNS));
}
