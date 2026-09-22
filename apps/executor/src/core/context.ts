/**
 * 上下文导出（《项目书》第 11 节 + P2「上下文导出和资料校验」）。
 *
 * 规则来源：
 * - 11「默认共享需求、决策摘要、影响文件、提交号、测试摘要、依赖及未解决问题。
 *   原始会话、登录文件、模型隐藏推理和整个电脑内容**不在共享范围**。」
 * - 11「资料与日志是**待分析的数据**，不应被当成能覆盖工程规则的指令。」
 * - 11「敏感内容检查后再上传。」
 * - 10.1「仅同步 … 以及经过**脱敏**的上下文导出。代码、AGENTS.md、
 *   正式契约和测试**通过 Git 传递**。」→ 导出物不得包含仓库内容本身。
 *
 * 两个用途：
 * 1. **给 agent 的任务输入**（对应 `opencode run --file` 注入）
 * 2. **给云端的摘要**（只放摘要与引用，不放原文）
 *
 * 因此本模块的核心不是"拼字符串"，而是**边界控制**：
 * 哪些字段允许出去、哪些必须被脱敏或拒绝。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/* ------------------------------------------------------------------ *
 * 敏感内容识别
 * ------------------------------------------------------------------ */

/**
 * 命中即**拒绝导出**的文件名/路径特征（不可脱敏，只能排除）。
 *
 * 与 diff-check.ts 的 `SENSITIVE_PATH_PATTERNS` 区分：
 * - 那边是**glob 字符串**，用于判断改动是否越界触碰敏感文件（SENSITIVE_FILE_DETECTED）
 * - 这边是**正则**，用于上下文导出时排除不该外传的文件
 * 两者目的不同，故各有其名，不合并。
 */
export const EXPORT_EXCLUDE_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])\.env(\..*)?$/i,
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])credentials?(\.json|\.yml|\.yaml)?$/i,
  /(^|[\\/])id_rsa(\.pub)?$/i,
  /(^|[\\/])id_ed25519(\.pub)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])secrets?(\.json|\.yml|\.yaml|\.txt)?$/i,
  /(^|[\\/])token(s)?(\.json|\.txt)?$/i,
  /(^|[\\/])Cookies([\\/]|$)/i,
  /(^|[\\/])Login Data$/i,
  /(^|[\\/])opencode\.json$/i,
];

/** 命中即被**替换为占位符**的内容模式（值本身敏感，但上下文结构有用）。 */
export const REDACTION_PATTERNS: readonly { pattern: RegExp; replace: string }[] = [
  // 常见 token / key 形态
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED_GITHUB_TOKEN]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: "[REDACTED_API_KEY]" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: "[REDACTED_API_KEY]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replace: "Bearer [REDACTED_TOKEN]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "[REDACTED_JWT]" },
  // 形如 key=value 的赋值
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|secret|password|passwd|pwd|client[_-]?secret)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi,
    replace: "$1=[REDACTED]",
  },
  // 邮箱与内网地址
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replace: "[REDACTED_EMAIL]" },
  { pattern: /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g, replace: "[REDACTED_PRIVATE_IP]" },
];

/** 判断某路径是否属于敏感文件（**必须排除**，不可脱敏）。 */
export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return EXPORT_EXCLUDE_PATTERNS.some((re) => re.test(normalized));
}

/** 对一段文本做脱敏。返回脱敏后的文本与命中的规则数。 */
export function redact(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const { pattern, replace } of REDACTION_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, (...args) => {
      hits += 1;
      // 支持 $1 之类的分组引用
      return replace.replace(/\$(\d)/g, (_m, i: string) => String(args[Number(i)] ?? ""));
    });
  }
  return { text: out, hits };
}

/* ------------------------------------------------------------------ *
 * 输入侧：给 agent 的上下文包
 * ------------------------------------------------------------------ */

/** 一个待注入的上下文文件。 */
export interface ContextFile {
  /** 仓库内相对路径（用于上报与日志，**不使用绝对路径**） */
  relative_path: string;
  /** 已脱敏的内容 */
  content: string;
  /** 本次注入是否发生脱敏 */
  redacted: boolean;
}

/** 被跳过的文件及原因。 */
export interface SkippedFile {
  relative_path: string;
  reason: string;
}

export interface BuildContextInput {
  /** 仓库根目录，用于解析相对路径 */
  repo_root: string;
  /** 希望注入的文件（仓库内相对路径） */
  wanted: readonly string[];
  /**
   * 单文件内容上限（字节）。超出则**跳过并记录**，
   * 不静默截断——截断过的上下文会让 agent 基于残缺信息决策。
   */
  max_bytes_per_file?: number;
  /** 总字节上限；累计超出后剩余文件全部跳过 */
  max_total_bytes?: number;
}

export interface ContextBundle {
  files: readonly ContextFile[];
  skipped: readonly SkippedFile[];
  total_bytes: number;
}

const DEFAULT_MAX_FILE = 256 * 1024;
const DEFAULT_MAX_TOTAL = 1024 * 1024;

/** 路径是否留在仓库内（防目录穿越）。 */
function staysInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (r === c) return false;
  const withSep = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(withSep);
}

/**
 * 组装给 agent 的上下文包。
 *
 * 顺序刻意如此：**先做安全判定，再做大小判定，最后才读文件**——
 * 敏感文件与越界路径绝不能被读取，哪怕只是为了看大小。
 */
export function buildContextBundle(input: BuildContextInput): ContextBundle {
  const maxFile = input.max_bytes_per_file ?? DEFAULT_MAX_FILE;
  const maxTotal = input.max_total_bytes ?? DEFAULT_MAX_TOTAL;

  const files: ContextFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  for (const wanted of input.wanted) {
    const normalized = wanted.replace(/\\/g, "/");

    // 1) 敏感文件：直接排除，不读（第 11 节）
    if (isSensitivePath(normalized)) {
      skipped.push({ relative_path: normalized, reason: "敏感文件，不在共享范围" });
      continue;
    }

    // 2) 绝对路径或越界：仓库外的内容不在共享范围（第 11 节「整个电脑内容」）
    if (isAbsolute(wanted) || !staysInside(input.repo_root, resolve(input.repo_root, wanted))) {
      skipped.push({ relative_path: normalized, reason: "路径越出仓库或为绝对路径" });
      continue;
    }

    const absolute = resolve(input.repo_root, wanted);
    if (!existsSync(absolute)) {
      skipped.push({ relative_path: normalized, reason: "文件不存在" });
      continue;
    }

    let size: number;
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) {
        skipped.push({ relative_path: normalized, reason: "不是普通文件" });
        continue;
      }
      size = stat.size;
    } catch {
      skipped.push({ relative_path: normalized, reason: "无法读取文件属性" });
      continue;
    }

    // 3) 大小限制：跳过而非截断
    if (size > maxFile) {
      skipped.push({
        relative_path: normalized,
        reason: `文件过大（${size} > ${maxFile} 字节），为避免注入残缺上下文而跳过`,
      });
      continue;
    }
    if (totalBytes + size > maxTotal) {
      skipped.push({
        relative_path: normalized,
        reason: `超出上下文总量上限（${maxTotal} 字节）`,
      });
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(absolute, "utf8");
    } catch {
      skipped.push({ relative_path: normalized, reason: "读取失败（可能为二进制或权限不足）" });
      continue;
    }

    const { text, hits } = redact(raw);
    files.push({ relative_path: normalized, content: text, redacted: hits > 0 });
    totalBytes += Buffer.byteLength(text, "utf8");
  }

  return { files, skipped, total_bytes: totalBytes };
}

/* ------------------------------------------------------------------ *
 * 输出侧：给云端的摘要
 * ------------------------------------------------------------------ */

/**
 * 云端摘要允许的字段（第 11 节逐条对应）。
 *
 * 刻意**不含**：原始会话、完整日志、模型推理、绝对路径、凭据。
 */
export interface CloudSummary {
  task_id: string;
  /** 需求摘要 */
  requirement: string | null;
  /** 决策摘要 */
  decisions: readonly string[];
  /** 影响文件（相对路径） */
  affected_files: readonly string[];
  /** 提交号 */
  commit_shas: readonly string[];
  /** 测试摘要：只放计数，不放日志原文 */
  test_summary: { passed: number; failed: number; skipped: number } | null;
  /** 依赖 */
  dependencies: readonly string[];
  /** 未解决问题 */
  open_questions: readonly string[];
}

export interface CloudSummaryDraft {
  task_id: string;
  requirement?: string | null;
  decisions?: readonly string[];
  affected_files?: readonly string[];
  commit_shas?: readonly string[];
  test_summary?: { passed: number; failed: number; skipped: number } | null;
  dependencies?: readonly string[];
  open_questions?: readonly string[];
}

/**
 * 生成可上传的云端摘要。
 *
 * 对每个自由文本字段做脱敏；路径字段做敏感过滤（命中即丢弃并记入
 * `open_questions`，避免"悄悄少了个文件"）。
 */
export function buildCloudSummary(draft: CloudSummaryDraft): {
  summary: CloudSummary;
  redaction_hits: number;
  dropped_paths: readonly string[];
} {
  let hits = 0;
  const red = (text: string): string => {
    const r = redact(text);
    hits += r.hits;
    return r.text;
  };

  const droppedPaths: string[] = [];
  const affected: string[] = [];
  for (const p of draft.affected_files ?? []) {
    if (isSensitivePath(p)) {
      droppedPaths.push(p);
      continue;
    }
    affected.push(red(p));
  }

  const openQuestions = [...(draft.open_questions ?? [])].map(red);
  for (const p of droppedPaths) {
    openQuestions.push(`影响文件中的敏感路径已从摘要中移除：${p}`);
  }

  return {
    summary: {
      task_id: red(draft.task_id),
      requirement: draft.requirement ? red(draft.requirement) : null,
      decisions: (draft.decisions ?? []).map(red),
      affected_files: affected,
      commit_shas: [...(draft.commit_shas ?? [])],
      test_summary: draft.test_summary ?? null,
      dependencies: (draft.dependencies ?? []).map(red),
      open_questions: openQuestions,
    },
    redaction_hits: hits,
    dropped_paths: droppedPaths,
  };
}
