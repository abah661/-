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
 *
 * ## 关于"自引用"的处理（重要）
 *
 * 冻结记录就写在 `packages/protocol/src/version.ts` 里，而它本身又在被冻结的
 * 子树之内。于是"完整子树哈希在冻结点与 HEAD 之间必须相等"这条断言**必然**
 * 不成立：把冻结信息写进去的那一刻，子树哈希就已经变了。
 *
 * 解决办法是把校验拆成两件事：
 *
 * 1. `frozenTreeSha` 是**冻结点自身子树**的哈希——这是一个可复核的历史事实，
 *    断言它等于 `git rev-parse <frozenAt>:packages/protocol` 即可。
 * 2. "冻结后有没有人偷偷改协议"则改用**逐文件 blob 比对**，把
 *    `version.ts`（冻结记录载体）排除在外，其余每个文件都必须与冻结点逐字节相同。
 *
 * 这样既保住了冻结的真实保障，又不会因为记录冻结这个动作本身而自我否定。
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

/**
 * 冻结记录载体：记录冻结动作必然修改此文件，因此它不能参与
 * "冻结后内容未变"的比对。仓库内以 `packages/protocol/` 为前缀的相对路径。
 */
const FREEZE_RECORD_PATH = "packages/protocol/src/version.ts";

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

/**
 * 一次性取回某个提交下 `packages/protocol` 的「路径 → blob 哈希」映射。
 *
 * 用 `git ls-tree -r` 一次拿全，而不是对每个文件各调一次 `git rev-parse`：
 * 后者会为十几个文件起十几个子进程，在本机 Windows 上足以把测试拖过 5s 超时。
 */
function protocolSnapshot(commit: string): Map<string, string> {
  const raw = git(["ls-tree", "-r", commit, "--", "packages/protocol"]);
  const snapshot = new Map<string, string>();
  for (const line of raw.split("\n")) {
    // 格式：<mode> <type> <sha>\t<path>
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tabIndex = trimmed.indexOf("\t");
    if (tabIndex === -1) continue;
    const meta = trimmed.slice(0, tabIndex).split(/\s+/);
    const path = trimmed.slice(tabIndex + 1);
    const sha = meta[2];
    if (sha) snapshot.set(path, sha);
  }
  return snapshot;
}

beforeAll(() => {
  gitBin = resolveGit();
});

/**
 * 本机（Windows + 非 PATH 的 git）每次 spawn git 约需 200–300ms，
 * 而下面几条用例会调用多次 git。默认 5s 超时太紧，显式放宽到 30s。
 */
const GIT_TEST_TIMEOUT = 30_000;

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
  /** 冻结提交与 HEAD 的协议包快照，只取一次，供下面多条用例复用。 */
  let frozenSnapshot: Map<string, string>;
  let headSnapshot: Map<string, string>;

  beforeAll(() => {
    if (!gitBin || !PROTOCOL_META.frozenAt) return;
    frozenSnapshot = protocolSnapshot(PROTOCOL_META.frozenAt);
    headSnapshot = protocolSnapshot("HEAD");
  });

  it("冻结提交号在仓库中真实存在", () => {
    if (!PROTOCOL_META.frozenAt) return;
    expect(() => git(["cat-file", "-e", `${PROTOCOL_META.frozenAt}^{commit}`])).not.toThrow();
  });

  it("frozenTreeSha 等于冻结提交下 packages/protocol 的子树哈希", () => {
    if (!PROTOCOL_META.frozenAt || !PROTOCOL_META.frozenTreeSha) return;
    const actual = git(["rev-parse", `${PROTOCOL_META.frozenAt}:packages/protocol`]);
    expect(actual).toBe(PROTOCOL_META.frozenTreeSha);
  }, GIT_TEST_TIMEOUT);

  it("frozenTreeSha 是子树哈希，不是仓库根树哈希", () => {
    // 防止再次把根树哈希误记为协议子树哈希
    if (!PROTOCOL_META.frozenAt) return;
    const rootTree = git(["rev-parse", `${PROTOCOL_META.frozenAt}^{tree}`]);
    expect(PROTOCOL_META.frozenTreeSha).not.toBe(rootTree);
  }, GIT_TEST_TIMEOUT);

  it("冻结之后协议包内容未发生改动（逐文件比对，排除冻结记录载体）", () => {
    // 这是冻结的核心保证：从冻结提交到现在，协议包的实质内容应保持不变。
    // 若此断言失败，说明有人改了协议却没走变更提案流程。
    //
    // 为什么不直接比子树哈希？因为冻结记录就在 packages/protocol/src/version.ts 里，
    // 记录冻结这个动作本身就会改变子树哈希，自引用会导致断言永远无法成立。
    // 因此这里逐文件比 blob 哈希，并把 version.ts 排除在外。
    if (!gitBin || !PROTOCOL_META.frozenAt || !PROTOCOL_META.frozenTreeSha) return;
    expect(frozenSnapshot.size, "冻结点协议包内应至少有一个文件").toBeGreaterThan(0);

    const changed: string[] = [];
    for (const [path, sha] of frozenSnapshot) {
      if (path === FREEZE_RECORD_PATH) continue;
      const now = headSnapshot.get(path);
      if (now !== sha) {
        changed.push(`${path}  (${sha.slice(0, 12)} → ${now ? now.slice(0, 12) : "已删除"})`);
      }
    }
    expect(
      changed,
      `以下协议文件在冻结后被改动（应走变更提案流程）：\n${changed.join("\n")}`,
    ).toEqual([]);
  });

  it("协议包内没有新增文件（排除冻结记录载体）", () => {
    // 逐文件比对只能发现"改"与"删"，发现不了"增"。这里补上新增检查。
    if (!gitBin || !PROTOCOL_META.frozenAt) return;
    const added = [...headSnapshot.keys()].filter(
      (path) => !frozenSnapshot.has(path) && path !== FREEZE_RECORD_PATH,
    );
    expect(added, `冻结后协议包新增了文件（应走变更提案流程）：\n${added.join("\n")}`).toEqual([]);
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
  }, GIT_TEST_TIMEOUT);
});
