/**
 * Git 基线与独立 worktree（第 8 节步骤 2，规则 3）。
 *
 * 硬约束：
 * - 每个任务用**独立 worktree**，互不覆盖；两端、多任务并行时不能共用工作区。
 * - **已有未提交内容不能覆盖**。若目标路径有脏改动，必须停止而不是清理。
 * - 基线 SHA 来自领取时的版本绑定，不得用「当前 HEAD」代替。
 *
 * Windows 要点：路径可能含中文与空格。所有 Git 调用一律走参数数组，
 * 不拼接命令行字符串；比较路径时先规范化再比较。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

/** 一次 Git 调用的结果。 */
export interface GitResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Git 可执行文件解析：本机 git 可能不在 PATH，必须先探测后使用。 */
export const GIT_CANDIDATES: readonly string[] = [
  "git",
  "C:/Program Files/Git/cmd/git.exe",
  "C:/Program Files (x86)/Git/cmd/git.exe",
];

let cachedGit: string | null = null;

/**
 * 找到可用的 git。
 * **找不到必须硬失败**——静默回退会让后续所有 Git 断言失效。
 */
export function resolveGitExecutable(candidates: readonly string[] = GIT_CANDIDATES): string {
  if (cachedGit && candidates === GIT_CANDIDATES) return cachedGit;
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
      if (candidates === GIT_CANDIDATES) cachedGit = candidate;
      return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error(
    `未找到可用的 git。已尝试：${candidates.join(", ")}。` +
      `请确认 Git 已安装并在 PATH 中，或把 git.exe 路径加入候选列表。`,
  );
}

/** 执行一次 git 命令。始终使用参数数组，不经 shell。 */
export function git(repoPath: string, args: readonly string[]): GitResult {
  const executable = resolveGitExecutable();
  try {
    const stdout = execFileSync(executable, [...args], {
      cwd: repoPath,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { exit_code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exit_code: typeof failure.status === "number" ? failure.status : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** 取某个提交号对应的子树哈希：`git rev-parse <sha>:<path>`。 */
export function treeShaAt(repoPath: string, commit: string, subPath: string): string {
  const result = git(repoPath, ["rev-parse", `${commit}:${subPath}`]);
  if (result.exit_code !== 0) {
    throw new Error(`无法取得 ${commit}:${subPath} 的树哈希：${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** 工作区是否干净（无未提交改动、无未跟踪文件干扰）。 */
export interface DirtyReport {
  dirty: boolean;
  /** 有改动的已跟踪文件 */
  modified: readonly string[];
  /** 未跟踪文件（worktree add 时不受影响，但需知悉） */
  untracked: readonly string[];
}

export function inspectWorktree(repoPath: string): DirtyReport {
  const result = git(repoPath, ["status", "--porcelain"]);
  if (result.exit_code !== 0) {
    throw new Error(`无法读取工作区状态：${result.stderr.trim()}`);
  }
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === "??") untracked.push(path);
    else modified.push(path);
  }
  return { dirty: modified.length > 0, modified, untracked };
}

export interface PrepareWorktreeInput {
  /** 主仓库根目录（不含 worktree 子目录） */
  repo_root: string;
  /** worktree 存放根目录，例如 <repo>/.local/worktrees */
  worktree_root: string;
  /** 任务基线提交号，来自 VersionBinding.base_sha */
  base_sha: string;
  /** 任务 ID，用于生成稳定且可辨识的目录名 */
  task_id: string;
  /** 尝试 ID，同一任务重派时不得复用目录 */
  attempt_id: string;
  /** 分支名，形如 task/<TASK_ID>/<ATTEMPT_ID>（AGENTS.md 第 3.1 节） */
  branch: string;
}

export interface PreparedWorktree {
  /** worktree 绝对路径 */
  path: string;
  branch: string;
  base_sha: string;
}

/**
 * 校验目标路径确实位于给定根目录之下。
 *
 * 必须补路径分隔符再比较——否则 `"双端连接-sync"` 会被误判为
 * `"双端连接"` 的子目录（本机踩过的坑）。
 */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const withSep = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(withSep);
}

/**
 * 准备独立 worktree。
 *
 * 顺序刻意如此：
 * 1. 先确认基线提交在本地存在（否则 fetch 未完成就开工，会 checkout 失败）
 * 2. 再确认目标路径**不存在或为空**，绝不复用可疑目录
 * 3. 最后 `git worktree add`，失败即抛错，不降级为共用主工作区
 */
export function prepareWorktree(input: PrepareWorktreeInput): PreparedWorktree {
  const { repo_root, worktree_root, base_sha, attempt_id, branch } = input;

  const verify = git(repo_root, ["cat-file", "-e", `${base_sha}^{commit}`]);
  if (verify.exit_code !== 0) {
    throw new Error(
      `基线提交 ${base_sha} 在本地不存在。请先 fetch，不要用当前 HEAD 顶替。`,
    );
  }

  const targetPath = join(worktree_root, attempt_id);
  if (!isInside(worktree_root, targetPath)) {
    throw new Error(`worktree 目标路径越界：${targetPath} 不在 ${worktree_root} 之下`);
  }
  if (existsSync(targetPath)) {
    throw new Error(
      `worktree 目标路径已存在：${targetPath}。` +
        `为避免覆盖已有未提交内容，执行器不会清理或复用该目录，请人工确认后移除。`,
    );
  }
  if (!existsSync(worktree_root)) {
    mkdirSync(worktree_root, { recursive: true });
  }

  // 分支可能因上次尝试残留；先尝试新建，失败则说明已存在，交由调用方处理。
  const add = git(repo_root, ["worktree", "add", "-b", branch, targetPath, base_sha]);
  if (add.exit_code !== 0) {
    throw new Error(
      `创建 worktree 失败（分支 ${branch}，基线 ${base_sha}）：${add.stderr.trim()}`,
    );
  }

  return { path: targetPath, branch, base_sha };
}

/** 移除 worktree。用于任务结束后的清理，失败不抛错（清理不是关键路径）。 */
export function removeWorktree(repo_root: string, path: string, force = false): boolean {
  if (!isAbsolute(path)) return false;
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  return git(repo_root, args).exit_code === 0;
}

/** 列出当前仓库登记的所有 worktree 路径。 */
export function listWorktrees(repo_root: string): readonly string[] {
  const result = git(repo_root, ["worktree", "list", "--porcelain"]);
  if (result.exit_code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}
