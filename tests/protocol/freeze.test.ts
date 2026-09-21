/**
 * 协议冻结完整性测试。
 *
 * 目的：把"冻结记录必须真实"变成自动化断言。
 * 如果有人在冻结后改了协议包内容却忘记更新 frozenTreeSha，
 * 这个测试会失败——这正是冻结机制的意义。
 *
 * 注意：本机（以及某些 CI 镜像）的 PATH 中可能没有 git，
 * 因此这里显式探测多个已知安装位置，而不是裸调 `git`。
 * 若完全找不到 git，相关断言会**明确失败**而不是静默跳过——
 * 静默跳过会让冻结保障悄悄失效。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL_META, PROTOCOL_VERSION } from "@dac/protocol";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");

/** 候选 git 可执行文件：优先 PATH，其次常见 Windows 安装路径。 */
const GIT_CANDIDATES = [
  process.env.GIT_EXECUTABLE,
  "git",
  "C:/Program Files/Git/cmd/git.exe",
  "C:/Program Files (x86)/Git/cmd/git.exe",
  "C:/Users/lenovo/AppData/Local/Programs/Git/cmd/git.exe",
  "/usr/bin/git",
  "/usr/local/bin/git",
];

let gitBin: string | null = null;

function resolveGit(): string | null {
  for (const candidate of GIT_CANDIDATES) {
    if (!candidate) continue;
    // 含路径分隔符的候选直接查文件是否存在；裸命令交给系统解析
    if (candidate.includes("/") || candidate.includes("\\")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // 继续尝试下一个
    }
  }
  return null;
}

function git(args: string[]): string {
  if (!gitBin) throw new Error("git 不可用");
  return execFileSync(gitBin, args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

beforeAll(() => {
  gitBin = resolveGit();
});

describe("git 可用性（前置条件）", () => {
  it("能找到 git 可执行文件，否则冻结校验无法进行", () => {
    expect(gitBin, "未找到 git：冻结完整性校验无法运行").not.toBeNull();
  });

  it("工作目录是 git 仓库", () => {
    expect(() => git(["rev-parse", "--git-dir"])).not.toThrow();
  });
});

describe("协议冻结元数据", () => {
  it("版本常量与元数据一致", () => {
    expect(PROTOCOL_META.version).toBe(PROTOCOL_VERSION);
  });

  it("已冻结时必须记录完整的提交号与树哈希", () => {
    if (PROTOCOL_META.status !== "frozen") return;
    expect(PROTOCOL_META.frozenAt).toMatch(/^[0-9a-f]{40}$/);
    expect(PROTOCOL_META.frozenTreeSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("未冻结时不应留有过期的冻结信息", () => {
    if (PROTOCOL_META.status === "frozen") return;
    expect(PROTOCOL_META.frozenAt).toBeNull();
    expect(PROTOCOL_META.frozenTreeSha).toBeNull();
  });
});

describe("冻结记录与实际仓库的一致性", () => {
  it("冻结提交号在仓库中真实存在", () => {
    if (!PROTOCOL_META.frozenAt) return;
    expect(() => git(["cat-file", "-e", `${PROTOCOL_META.frozenAt}^{commit}`])).not.toThrow();
  });

  it("frozenTreeSha 等于冻结提交下 packages/protocol 的子树哈希", () => {
    if (!PROTOCOL_META.frozenAt || !PROTOCOL_META.frozenTreeSha) return;
    const actual = git(["rev-parse", `${PROTOCOL_META.frozenAt}:packages/protocol`]);
    expect(actual).toBe(PROTOCOL_META.frozenTreeSha);
  });

  it("frozenTreeSha 是子树哈希，不是仓库根树哈希", () => {
    // 防止再次把根树哈希误记为协议子树哈希
    if (!PROTOCOL_META.frozenAt) return;
    const rootTree = git(["rev-parse", `${PROTOCOL_META.frozenAt}^{tree}`]);
    expect(PROTOCOL_META.frozenTreeSha).not.toBe(rootTree);
  });

  it("冻结之后协议包内容未发生改动", () => {
    // 这是冻结的核心保证：从冻结提交到现在，packages/protocol 的树哈希应保持不变。
    // 若此断言失败，说明有人改了协议却没走变更提案流程。
    if (!PROTOCOL_META.frozenAt || !PROTOCOL_META.frozenTreeSha) return;

    const headTree = git(["rev-parse", "HEAD:packages/protocol"]);
    expect(headTree).toBe(PROTOCOL_META.frozenTreeSha);
  });

  it("工作区中协议包无未提交改动", () => {
    // 即使 HEAD 的树哈希没变，工作区也可能有未提交的协议改动。
    if (!PROTOCOL_META.frozenTreeSha) return;
    const status = git(["status", "--porcelain", "--", "packages/protocol"]);
    // frozenTreeSha 自身所在的 version.ts 会被排除在外：
    // 记录冻结信息必然要改这个文件，属于冻结动作本身。
    const dirty = status
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes("packages/protocol/src/version.ts"));
    expect(dirty, `协议包存在未提交改动：\n${dirty.join("\n")}`).toEqual([]);
  });
});
