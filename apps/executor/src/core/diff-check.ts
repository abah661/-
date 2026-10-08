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
 *
 * ## B8：核对失败必须 fail-closed（A 端 B7 评审 B7-2）
 *
 * 原实现对每一条 Git 命令都是「失败就跳过」：
 * - `git diff --name-only` 失败 → 当作「没有变更」，`violations` 为空；
 * - `git status --porcelain` 失败 → 当作「没有未提交内容」；
 * - 于是**在一个根本不是仓库的路径上调用 `checkDiffScope()` 会返回
 *   `ok: true`、`violations: []`** —— A 端已复现。
 *
 * 这不是「检查通过」，而是**根本没检查**。现在：
 * - 任何一条 Git 命令非零退出 → 立即返回 `ok: false` 并带上 `error`，
 *   调用方据此**阻止提交与推送**；
 * - 路径解析一律走 `-z`（NUL 分隔），避免 `core.quotePath` 把非 ASCII
 *   路径转义成 `"\344\270\255"` 这种形式，从而绕过写入范围比对；
 * - 变更列表用 `--name-status -M`，**重命名的源与目标都要查**——
 *   否则「把越界文件改名成允许范围内的名字」就能溜过检查。
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
  // B8：**大小写不敏感**（`i`）。
  // 两条理由：
  // 1. Windows 与 macOS 的默认文件系统不区分大小写，`.ENV` 与 `.env`
  //    是同一个文件——区分大小写会让 `.ENV` 绕过敏感检查（A 端 B7-3 已复现）；
  // 2. `deny` 是硬边界（规则 3），宁可比对得更宽，不可更窄。
  return new RegExp(out, "i");
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
  /** 合规为 true；有 violations 或 `error` 非空即为 false */
  ok: boolean;
  /** 是否存在未提交改动（有则说明尚未 commit，需先提交再看） */
  has_uncommitted: boolean;
  /**
   * 核对过程本身失败时的说明（B8）。**非 null 时 `ok` 必为 false**。
   *
   * 覆盖：worktree 不是 Git 仓库、基线提交不存在、任意一条 Git 命令非零退出。
   * 语义是「**无法确认**是否越界」，而不是「确认没有越界」——
   * 调用方必须按未通过处理，不得据此提交或推送。
   */
  error: string | null;
}

/** 一次 Git 列表调用的结果；`error` 非空表示**核对失败**而非「结果为空」。 */
interface ChangedListResult {
  files: readonly string[];
  error: string | null;
}

/** 供测试注入 Git 行为；缺省用真实 `git()`。 */
export type GitRunner = (repoPath: string, args: readonly string[]) => {
  exit_code: number;
  stdout: string;
  stderr: string;
};

/**
 * 两个路径是否指向同一位置。
 *
 * 必须做两步归一化，否则会把正确的路径判成不一致：
 * 1. `realpathSync.native` —— 本机 `%TEMP%` 可能是 8.3 短路径，而 Git 返回长路径；
 * 2. 分隔符统一为正斜杠；Windows 上再忽略大小写（文件系统本就不区分）。
 *
 * 解析失败（路径不存在）时退回 `resolve`，此时比较的是「同一个字符串的
 * 同一种解析结果」，仍能正确区分「同一路径」与「父仓库路径」。
 */
export function sameRepoPath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      real = resolve(p);
    }
    const slashed = real.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/**
 * 确认 `worktree_path` **自己**就是 Git 工作区根目录（B8）。
 *
 * 为什么不能省：
 * - 路径不是仓库时，`git rev-parse --show-toplevel` 直接失败 → 明确报错；
 * - 更隐蔽的情况是「worktree 的 `.git` 指针坏了，但它在主仓库目录树内」——
 *   此时 Git 会向上找到**主仓库**并正常回答，于是核对的是**另一个仓库**，
 *   结论看似合理却与本次任务无关。那种「错误的通过」比失败更危险。
 * 因此这里要求 toplevel 与目标路径指向同一位置。
 */
function verifyWorktreeRoot(worktreePath: string, runGit: GitRunner): string | null {
  const result = runGit(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (result.exit_code !== 0) {
    return `worktree 不是可用的 Git 工作区：${failureDetail(result)}（${worktreePath}）`;
  }
  const top = result.stdout.trim();
  if (top === "") return `无法确定 worktree 的 Git 工作区根目录（${worktreePath}）`;
  if (!sameRepoPath(top, worktreePath)) {
    return (
      `worktree 路径与 Git 工作区根目录不一致：期望 ${worktreePath}，` +
      `实际 ${top}。核对对象不对，拒绝据此判定写入范围。`
    );
  }
  return null;
}

function failureDetail(result: { exit_code: number; stderr: string }): string {
  const stderr = result.stderr.trim().split(/\r?\n/)[0] ?? "";
  return stderr.slice(0, 200) || `退出码 ${result.exit_code}`;
}

/**
 * 解析 `git diff --name-status -z` 的输出。
 *
 * `-z` 下记录的形态是：
 * - 普通变更： `<状态>\0<路径>\0`
 * - 重命名/复制：`<状态>\0<源路径>\0<目标路径>\0`（状态形如 `R100` / `C075`）
 *
 * 重命名**两侧都返回**：只看目标会让「把 `apps/coordinator/x.ts` 改名成
 * `apps/executor/x.ts`」被判为合规，而它实际改动了 A 端专属目录。
 */
export function parseNameStatusZ(output: string): readonly string[] {
  const files: string[] = [];
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === "") continue;
    // 兼容带制表符的形态（万一 `-z` 未被接受），避免把状态码当成路径。
    if (token.includes("\t")) {
      const parts = token.split("\t");
      for (const part of parts.slice(1)) if (part !== "") files.push(part);
      continue;
    }
    if (/^[RC]/.test(token)) {
      const source = tokens[i + 1];
      const target = tokens[i + 2];
      i += 2;
      if (source !== undefined && source !== "") files.push(source);
      if (target !== undefined && target !== "") files.push(target);
      continue;
    }
    if (/^[A-Z]/.test(token)) {
      const path = tokens[i + 1];
      i += 1;
      if (path !== undefined && path !== "") files.push(path);
      continue;
    }
    // 不是状态码：按路径处理（防御性，宁可多查一个也不静默丢弃）
    files.push(token);
  }
  return files;
}

/** 列出 `git diff --name-status -z -M <args...>` 命中的文件（含重命名两侧）。 */
function listNameStatus(
  worktreePath: string,
  args: readonly string[],
  runGit: GitRunner,
): ChangedListResult {
  const result = runGit(worktreePath, ["diff", "--name-status", "-z", "-M", ...args]);
  if (result.exit_code !== 0) {
    return { files: [], error: `git diff ${args.join(" ")} 失败：${failureDetail(result)}` };
  }
  return { files: parseNameStatusZ(result.stdout), error: null };
}

/**
 * 列出 base_sha 与当前 HEAD（或工作区）之间的变更文件。
 *
 * **任何一条 Git 命令失败都会让整次核对失败**（B8）：区分「命令说没有变更」
 * 与「命令没跑成」是这一步的全部意义。
 */
export function listChangedFiles(
  worktreePath: string,
  baseSha: string,
  runGit: GitRunner = git,
): ChangedListResult {
  const names = new Set<string>();

  // 已提交部分：base..HEAD
  const committed = listNameStatus(worktreePath, [`${baseSha}..HEAD`], runGit);
  if (committed.error !== null) return { files: [], error: committed.error };
  for (const path of committed.files) names.add(path);

  // 未提交部分：相对 HEAD 的改动 + 暂存区
  for (const args of [["HEAD"], ["--cached"]]) {
    const part = listNameStatus(worktreePath, args, runGit);
    if (part.error !== null) return { files: [], error: part.error };
    for (const path of part.files) names.add(path);
  }

  // 未跟踪文件（`ls-files` 没有 --name-status 形态，单独走 NUL 解析）
  const others = runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (others.exit_code !== 0) {
    return { files: [], error: `git ls-files 失败：${failureDetail(others)}` };
  }
  for (const path of others.stdout.split("\0")) {
    if (path !== "") names.add(path);
  }

  return {
    files: [...names].map((path) => path.replace(/\\/g, "/")).sort(),
    error: null,
  };
}

/**
 * 用实际 diff 与声明范围核对。
 *
 * 注意：**新增文件也算变更**。只在「已跟踪文件」上做比对会漏掉
 * 「偷偷新建一个越界文件」这类越界（与冻结守卫那次「逐文件比对发现不了增」
 * 是同一类疏漏，已在此显式处理）。
 *
 * B8 起还有一条更强的语义：**核对本身失败 = 未通过**。
 */
export function checkDiffScope(
  input: DiffCheckInput,
  runGit: GitRunner = git,
): DiffCheckResult {
  const rootProblem = verifyWorktreeRoot(input.worktree_path, runGit);
  if (rootProblem !== null) {
    return {
      changed_files: [],
      violations: [],
      ok: false,
      has_uncommitted: false,
      error: rootProblem,
    };
  }

  const listed = listChangedFiles(input.worktree_path, input.base_sha, runGit);
  if (listed.error !== null) {
    return {
      changed_files: [],
      violations: [],
      // 关键：不是「没有越界」，而是「无法确定」。因此一律 ok: false。
      ok: false,
      has_uncommitted: false,
      error: listed.error,
    };
  }

  const changed = listed.files;
  const violations = changed.filter((path) => !isPathAllowed(path, input.scope));

  const status = runGit(input.worktree_path, ["status", "--porcelain", "-z"]);
  if (status.exit_code !== 0) {
    // 「读不出工作区状态」与「工作区干净」必须区分（B7-2）。
    return {
      changed_files: changed,
      violations,
      ok: false,
      has_uncommitted: false,
      error: `git status 失败：${failureDetail(status)}`,
    };
  }
  // `-z` 形态下条目以 NUL 分隔，每条形如 "XY <path>"（无引号转义）。
  const hasUncommitted = status.stdout
    .split("\0")
    .some((entry) => entry.trim() !== "" && !entry.startsWith("??"));

  return {
    changed_files: changed,
    violations,
    ok: violations.length === 0,
    has_uncommitted: hasUncommitted,
    error: null,
  };
}

/**
 * 是否触碰了敏感文件（错误码 SENSITIVE_FILE_DETECTED，需授权介入）。
 *
 * ## B8：从「只认 `.env`」扩到真实会出现的凭据载体（A 端 B7-3）
 * A 端实测：`.env`、`.ENV`、`B-token-public.cer`、`.codex/config.toml`
 * 四个样例里**只有 `.env` 命中**。原因是模式既缺项、又区分大小写。
 * 现在补齐三类：
 *
 * 1. **大小写变体**：`.ENV` 与 `.env` 在同一文件系统上是同一个文件（见 `globToRegExp`）。
 * 2. **凭据容器扩展名**：`.cer` 是本项目 Token 交接的第一棒
 *    （交接单 §6.1 生成 `B-token-public.cer`，§6.3 明确「公钥证书和本地加密
 *    副本都不得加入 Git」），另有 `.p7m` / `.pfx` / `.p12` / `.jks`。
 * 3. **agent 本地会话与云厂商凭据目录**：`.codex/`（AGENTS.md 第 7 节点名）、
 *    `.ssh/`、`.aws/`，以及 `.npmrc` / `.netrc`。
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/auth.json",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/credentials.json",
  "**/.credentials.json",
  // 凭据容器（B5 新增）
  "**/*.pfx",
  "**/*.p12",
  "**/*.p7m",
  // 凭据容器与证书（B8 新增）
  "**/*.cer",
  "**/*.crt",
  "**/*.der",
  "**/*.p7b",
  "**/*.jks",
  "**/*.keystore",
  // 本地凭据目录（B8 新增）
  "**/.codex/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.npmrc",
  "**/.netrc",
  "**/Cookies",
  "**/Login Data",
  // 通用凭据命名（B8 新增）。刻意**不**用 `**/*secret*`：
  // 那会把 `redact-secret.test.ts` 这类正常源文件也判为敏感，
  // 而敏感命中会直接把结果降级为 blocked_approval（阻断提交），
  // 误报的代价是「正常任务被人为卡住」。宁可精确到「文件名就是凭据容器」。
  "**/secrets.*",
  "**/*.secret",
];

export function findSensitiveTouches(changedFiles: readonly string[]): readonly string[] {
  return changedFiles.filter((path) => matchesAny(path, SENSITIVE_PATH_PATTERNS));
}
