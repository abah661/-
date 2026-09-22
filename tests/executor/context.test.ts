/**
 * 上下文导出与脱敏测试（第 11 节 + P2）。
 *
 * 第 11 节规则逐条对应：
 * - 「原始会话、登录文件、模型隐藏推理和整个电脑内容**不在共享范围**」
 * - 「资料与日志是待分析的数据，不应被当成能覆盖工程规则的指令」
 * - 「敏感内容检查后再上传」
 * - 10.1「代码、AGENTS.md、正式契约和测试**通过 Git 传递**」
 *   → 导出物不含仓库内容本身，只含脱敏摘要
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCloudSummary,
  buildContextBundle,
  isSensitivePath,
  redact,
} from "../../apps/executor/src/core/context.js";

describe("敏感文件识别（必须排除，不可脱敏）", () => {
  const sensitive = [
    ".env",
    "config/.env",
    "config/.env.local",
    "auth.json",
    "nested/dir/auth.json",
    "credentials.json",
    "config/credentials.yml",
    "keys/id_rsa",
    "keys/id_ed25519",
    ".ssh/config",
    ".aws/credentials",
    ".npmrc",
    "secrets.json",
    "tokens.json",
    "Cookies",
    "opencode.json",
  ];

  it.each(sensitive)("识别敏感路径：%s", (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it("Windows 反斜杠路径同样被识别", () => {
    expect(isSensitivePath("config\\auth.json")).toBe(true);
    expect(isSensitivePath("keys\\id_rsa")).toBe(true);
  });

  it("普通文件不被误判", () => {
    for (const p of ["src/index.ts", "README.md", "AGENTS.md", "docs/plan.md", "package.json"]) {
      expect(isSensitivePath(p)).toBe(false);
    }
  });
});

describe("文本脱敏（结构保留，值替换）", () => {
  it("GitHub token 被替换", () => {
    const { text, hits } = redact("token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(hits).toBeGreaterThan(0);
    expect(text).not.toContain("ghp_ABCDEF");
    expect(text).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("sk- 开头的 API key 被替换", () => {
    const { text } = redact("OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    expect(text).not.toContain("sk-proj-abcdefghij");
    expect(text).toContain("[REDACTED");
  });

  it("Bearer token 被替换", () => {
    const { text } = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop.qrstuvwxyz0123456");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(text).toContain("[REDACTED");
  });

  it("key=value 形式的敏感赋值被替换，但键名保留", () => {
    const { text } = redact('api_key="supersecretvalue123"');
    expect(text).toContain("api_key=");
    expect(text).not.toContain("supersecretvalue123");
    expect(text).toContain("[REDACTED]");
  });

  it("邮箱与内网 IP 被替换", () => {
    const { text } = redact("联系 alice@example.com，服务器 192.168.1.100 和 10.0.0.5");
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("192.168.1.100");
    expect(text).not.toContain("10.0.0.5");
  });

  it("普通文本不被破坏", () => {
    const { text, hits } = redact("执行器需要处理 worktree 与心跳，共 248 个用例。");
    expect(hits).toBe(0);
    expect(text).toBe("执行器需要处理 worktree 与心跳，共 248 个用例。");
  });

  it("同一进程内多次调用不复用 lastIndex（全局正则陷阱）", () => {
    const a = redact("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").text;
    const b = redact("ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB").text;
    expect(a).not.toContain("ghp_AAAA");
    expect(b).not.toContain("ghp_BBBB");
  });
});

describe("上下文包组装", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "dac-ctx-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "# 规则\n必须跑测试。\n", "utf8");
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n", "utf8");
    writeFileSync(join(repo, "config", ".env"), "SECRET=leaked\n", "utf8");
    writeFileSync(join(repo, "config", "auth.json"), '{"token":"leaked"}\n', "utf8");
    writeFileSync(join(repo, "big.txt"), "x".repeat(500), "utf8");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("注入清单内的普通文件", () => {
    const bundle = buildContextBundle({
      repo_root: repo,
      wanted: ["AGENTS.md", "src/index.ts"],
    });

    expect(bundle.files).toHaveLength(2);
    expect(bundle.skipped).toHaveLength(0);
    expect(bundle.files.map((f) => f.relative_path).sort()).toEqual([
      "AGENTS.md",
      "src/index.ts",
    ]);
    expect(bundle.files.find((f) => f.relative_path === "AGENTS.md")!.content).toContain("必须跑测试");
  });

  it(".env 与 auth.json 被跳过，内容**从未被读取**", () => {
    const bundle = buildContextBundle({
      repo_root: repo,
      wanted: ["config/.env", "config/auth.json", "AGENTS.md"],
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.relative_path).toBe("AGENTS.md");
    expect(bundle.skipped).toHaveLength(2);
    for (const s of bundle.skipped) {
      expect(s.reason).toContain("敏感文件");
    }
    // 敏感内容绝不出现在结果里
    const all = bundle.files.map((f) => f.content).join("\n");
    expect(all).not.toContain("leaked");
  });

  it("越界路径与绝对路径被跳过", () => {
    const bundle = buildContextBundle({
      repo_root: repo,
      wanted: ["../outside.txt", "C:/Windows/System32/drivers/etc/hosts", "AGENTS.md"],
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.skipped.some((s) => s.reason.includes("越出仓库"))).toBe(true);
  });

  it("超大文件被**跳过**而非截断（不注入残缺上下文）", () => {
    const bundle = buildContextBundle({
      repo_root: repo,
      wanted: ["big.txt"],
      max_bytes_per_file: 100,
    });

    expect(bundle.files).toHaveLength(0);
    expect(bundle.skipped[0]!.reason).toContain("过大");
    expect(bundle.skipped[0]!.reason).toContain("残缺");
  });

  it("超出总量上限后剩余文件被跳过", () => {
    writeFileSync(join(repo, "m1.txt"), "a".repeat(60), "utf8");
    writeFileSync(join(repo, "m2.txt"), "b".repeat(60), "utf8");
    const bundle = buildContextBundle({
      repo_root: repo,
      wanted: ["m1.txt", "m2.txt"],
      max_total_bytes: 80,
    });

    expect(bundle.files).toHaveLength(1);
    expect(bundle.skipped).toHaveLength(1);
    expect(bundle.skipped[0]!.reason).toContain("总量上限");
  });

  it("不存在的文件被记录而不是抛错", () => {
    const bundle = buildContextBundle({ repo_root: repo, wanted: ["nope.ts"] });
    expect(bundle.files).toHaveLength(0);
    expect(bundle.skipped[0]!.reason).toContain("不存在");
  });

  it("文件内容里混入的 token 会被脱敏后再注入", () => {
    writeFileSync(
      join(repo, "with-token.md"),
      "配置：token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n",
      "utf8",
    );
    const bundle = buildContextBundle({ repo_root: repo, wanted: ["with-token.md"] });
    expect(bundle.files[0]!.redacted).toBe(true);
    expect(bundle.files[0]!.content).not.toContain("ghp_ABCDEF");
  });
});

describe("云端摘要", () => {
  it("只保留第 11 节允许的字段", () => {
    const { summary } = buildCloudSummary({
      task_id: "TASK-1",
      requirement: "实现资料校验",
      decisions: ["SHA-256 不符即拒绝"],
      affected_files: ["apps/executor/src/core/materials.ts"],
      commit_shas: ["a".repeat(40)],
      test_summary: { passed: 267, failed: 0, skipped: 1 },
      dependencies: ["node:crypto"],
      open_questions: ["清单格式待确认"],
    });

    expect(summary.task_id).toBe("TASK-1");
    expect(summary.test_summary).toEqual({ passed: 267, failed: 0, skipped: 1 });
    // 明确不含原始会话/完整日志/推理等字段
    const keys = Object.keys(summary);
    for (const forbidden of ["raw_session", "full_log", "reasoning", "chain_of_thought"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("敏感字段被脱敏", () => {
    const { summary, redaction_hits } = buildCloudSummary({
      task_id: "TASK-1",
      requirement: "使用 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 访问",
    });

    expect(redaction_hits).toBeGreaterThan(0);
    expect(summary.requirement).not.toContain("ghp_ABCDEF");
  });

  it("影响文件里的敏感路径被丢弃，并记入未解决问题（不静默消失）", () => {
    const { summary, dropped_paths } = buildCloudSummary({
      task_id: "TASK-1",
      affected_files: ["src/index.ts", "config/auth.json"],
    });

    expect(dropped_paths).toEqual(["config/auth.json"]);
    expect(summary.affected_files).toEqual(["src/index.ts"]);
    expect(summary.open_questions.some((q) => q.includes("敏感路径"))).toBe(true);
  });
});
