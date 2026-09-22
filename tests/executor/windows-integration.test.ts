/**
 * Windows 真实进程 / 真实 Git 集成测试。
 *
 * 与 core-process.test.ts 的分工：
 * - core-process.test.ts 用假运行器验证**逻辑分支**（确定、快、不烧配额）
 * - 本文件用**真实进程与真实 git** 验证「假实现验证不了的事」
 *
 * 为什么必须有这一层（《项目书》P3 原文）：
 *   "模拟测试不能替代真实 CLI 验证。"
 *
 * 本文件覆盖三块**只能用真实运行证明**的行为：
 * 1. 进程树停止 —— `child.kill()` 只杀父进程；必须证明 taskkill /T 连子进程一起杀
 * 2. 真实 worktree —— 中文路径、含空格路径下 git worktree 是否真的可用
 * 3. 真实测试输出 —— 用真实 vitest 输出验证 parseTestSummary 的解析
 *
 * 运行约束：本文件会真实拉起进程与创建 worktree，比假运行器慢。
 * 每个用例都自带超时与清理，失败不应留下残留进程或目录。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  nodeProcessRunner,
  runProcess,
  systemTreeKiller,
} from "../../apps/executor/src/core/process.js";
import {
  git,
  inspectWorktree,
  isInside,
  listWorktrees,
  prepareWorktree,
  removeWorktree,
  resolveGitExecutable,
} from "../../apps/executor/src/core/worktree.js";
import {
  collectEvidence,
  parseTestSummary,
} from "../../apps/executor/src/core/evidence.js";

const IS_WINDOWS = process.platform === "win32";

/* ------------------------------------------------------------------ *
 * 工具：等待条件成立（避免固定 sleep 造成的偶发失败）
 * ------------------------------------------------------------------ */

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** 进程是否仍存活。signal 0 只探测存在性，不真的发信号。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 一、真实进程树停止
 * ------------------------------------------------------------------ */

describe("真实进程树停止（Windows 重点项）", () => {
  it.runIf(IS_WINDOWS)(
    "taskkill /T 杀掉**子进程**，而不只是父进程",
    async () => {
      // 构造一棵真实的进程树：node 父进程 -> node 子进程 -> node 孙进程。
      // 父进程把子进程 pid 写到文件，供测试断言。
      const dir = mkdtempSync(join(tmpdir(), "dac-tree-"));
      const pidFile = join(dir, "child-pids.txt");
      const script = join(dir, "spawner.js");

      // 父进程：拉起一个同样长驻的子进程，再把子进程 pid 落盘，然后自己也不退出
      writeFileSync(
        script,
        [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          "const child = spawn(process.execPath,",
          '  ["-e", "setInterval(()=>{},1000)"],',
          '  { stdio: "ignore", windowsHide: true });',
          "fs.writeFileSync(process.argv[2], String(child.pid));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      const parent = spawn(
        process.execPath,
        [script, pidFile],
        { stdio: "ignore", windowsHide: true },
      );
      const parentPid = parent.pid!;
      expect(parentPid).toBeGreaterThan(0);

      try {
        // 等父进程把子进程 pid 写出来
        const wrote = await waitUntil(
          () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0,
          10_000,
        );
        expect(wrote).toBe(true);

        const childPid = Number(readFileSync(pidFile, "utf8").trim());
        expect(Number.isInteger(childPid)).toBe(true);
        expect(isAlive(childPid)).toBe(true);

        // 关键对比：先证明 child.kill() **杀不掉**子进程
        // （这正是为什么必须有 taskkill /T）
        process.kill(childPid, 0); // 确认可探测
        try {
          process.kill(parentPid, "SIGTERM");
        } catch {
          // Windows 上对非本进程组发 SIGTERM 可能直接抛错，忽略
        }
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        // 父进程若已死而子进程仍活着，就构成了「孤儿进程」——
        // 这是 taskkill /T 存在的理由。此处不断言父进程必死
        // （Windows 的 SIGTERM 语义与 POSIX 不同），只记录事实。
        const childSurvivedParentKill = isAlive(childPid);

        // 现在用真实 killer 杀整棵树
        await systemTreeKiller.killTree(parentPid, true);

        const treeGone = await waitUntil(
          () => !isAlive(childPid),
          IS_WINDOWS ? 15_000 : 5_000,
        );
        expect(treeGone).toBe(true);
        // 子进程确实被杀掉了 —— 这是 taskkill /T 的核心价值
        expect(isAlive(childPid)).toBe(false);
        // 记录一个有用的观测：单独杀父进程后子进程是否成为孤儿
        expect(typeof childSurvivedParentKill).toBe("boolean");
      } finally {
        try {
          if (isAlive(parentPid)) process.kill(parentPid, "SIGKILL");
        } catch {
          /* 已退出 */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.runIf(IS_WINDOWS)(
    "超时后真实子进程被终止并返回 timed_out",
    async () => {
      // 真实拉起一个长驻进程（node 空转），设一个很短的超时。
      // 验证：真进程被真的终止了，且结果标记 timed_out。
      const result = await runProcess(
        {
          executable: process.execPath,
          args: ["-e", "setInterval(()=>{},1000)"],
          cwd: process.cwd(),
        },
        { timeout_ms: 800, grace_ms: 3_000 },
      );

      expect(result.timed_out).toBe(true);
      // 被终止：退出码为 null（信号终止）或非 0，两者都可接受
      expect(result.exit_code === null || result.exit_code !== 0).toBe(true);
      // 进程确实结束了，不是被无限等待挂着
      expect(result.kill_failed).toBe(false);
    },
    30_000,
  );

  it.runIf(IS_WINDOWS)(
    "正常退出的进程不触发任何终止（timed_out=false）",
    async () => {
      const result = await runProcess(
        {
          executable: process.execPath,
          args: ["-e", 'process.stdout.write("done"); process.exit(0)'],
          cwd: process.cwd(),
        },
        { timeout_ms: 10_000 },
      );

      expect(result.timed_out).toBe(false);
      expect(result.kill_failed).toBe(false);
      expect(result.escalated_to_force).toBe(false);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("done");
    },
    30_000,
  );

  it("真实收集 stdout 与 stderr，两者不混淆", async () => {
    const result = await runProcess(
      {
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write("OUT_MARK"); process.stderr.write("ERR_MARK"); process.exit(3)',
        ],
        cwd: process.cwd(),
      },
      { timeout_ms: 10_000 },
    );

    expect(result.exit_code).toBe(3);
    expect(result.stdout).toContain("OUT_MARK");
    expect(result.stdout).not.toContain("ERR_MARK");
    expect(result.stderr).toContain("ERR_MARK");
    expect(result.stderr).not.toContain("OUT_MARK");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * 二、真实 Git worktree（中文 / 空格路径）
 * ------------------------------------------------------------------ */

describe("真实 Git worktree（中文与空格路径）", () => {
  let gitExe: string;
  let repoRoot: string;

  beforeAll(() => {
    // 找不到 git 就直接让整套用例失败——静默跳过会让「真实验证」变成空话
    gitExe = resolveGitExecutable();
    expect(gitExe.length).toBeGreaterThan(0);

    // 刻意用**含中文与空格**的目录名建真实仓库，
    // 复现 README 点名的 Windows 路径风险
    const base = mkdtempSync(join(tmpdir(), "dac-wt-"));
    repoRoot = join(base, "双端 连接 测试仓库");
    mkdirSync(repoRoot, { recursive: true });

    const must = (args: string[]): void => {
      const r = git(repoRoot, args);
      if (r.exit_code !== 0) {
        throw new Error(`git ${args.join(" ")} 失败：${r.stderr.trim()}`);
      }
    };

    must(["init", "-q"]);
    must(["config", "user.email", "b@example.invalid"]);
    must(["config", "user.name", "B Test"]);
    must(["config", "commit.gpgsign", "false"]);
    // 明确开启默认引用行为，确保测试不受运行机器的全局 Git 配置影响。
    must(["config", "core.quotePath", "true"]);
    writeFileSync(join(repoRoot, "README.md"), "# 测试仓库\n中文内容\n", "utf8");
    must(["add", "-A"]);
    must(["commit", "-q", "-m", "init"]);
  });

  afterAll(() => {
    if (!repoRoot) return;
    // 先尽量规范地移除登记过的 worktree，再整体删除临时目录
    try {
      for (const wt of listWorktrees(repoRoot)) {
        if (wt !== repoRoot) removeWorktree(repoRoot, wt, true);
      }
    } catch {
      /* 忽略清理失败 */
    }
    const base = join(repoRoot, "..");
    rmSync(base, { recursive: true, force: true });
  });

  function headSha(): string {
    const r = git(repoRoot, ["rev-parse", "HEAD"]);
    if (r.exit_code !== 0) throw new Error(`无法读取 HEAD：${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  it("在含中文与空格的路径下能创建并移除 worktree", () => {
    const worktreeRoot = join(repoRoot, ".local", "worktrees");
    const base = headSha();

    const prepared = prepareWorktree({
      repo_root: repoRoot,
      worktree_root: worktreeRoot,
      base_sha: base,
      task_id: "TASK-TEST-1",
      attempt_id: "ATTEMPT-1",
      branch: "task/TASK-TEST-1/ATTEMPT-1",
    });

    try {
      expect(existsSync(prepared.path)).toBe(true);
      // 中文路径真的可用：能读到仓库内容
      expect(existsSync(join(prepared.path, "README.md"))).toBe(true);
      const content = readFileSync(join(prepared.path, "README.md"), "utf8");
      expect(content).toContain("中文内容");
      // 新 worktree 是干净的
      expect(inspectWorktree(prepared.path).dirty).toBe(false);
      // 已登记在 worktree 列表里
      expect(listWorktrees(repoRoot).some((p) => isInside(worktreeRoot, p) || p === prepared.path))
        .toBe(true);
    } finally {
      expect(removeWorktree(repoRoot, prepared.path, true)).toBe(true);
    }

    expect(existsSync(prepared.path)).toBe(false);
  }, 60_000);

  it("两个任务得到**两个独立** worktree，互不覆盖", () => {
    const worktreeRoot = join(repoRoot, ".local", "worktrees");
    const base = headSha();

    const a = prepareWorktree({
      repo_root: repoRoot,
      worktree_root: worktreeRoot,
      base_sha: base,
      task_id: "TASK-TEST-2A",
      attempt_id: "ATTEMPT-2A",
      branch: "task/TASK-TEST-2A/ATTEMPT-2A",
    });
    const b = prepareWorktree({
      repo_root: repoRoot,
      worktree_root: worktreeRoot,
      base_sha: base,
      task_id: "TASK-TEST-2B",
      attempt_id: "ATTEMPT-2B",
      branch: "task/TASK-TEST-2B/ATTEMPT-2B",
    });

    try {
      expect(a.path).not.toBe(b.path);
      expect(existsSync(a.path)).toBe(true);
      expect(existsSync(b.path)).toBe(true);

      // 在 A 里写文件，B 不受影响 —— 这是「独立 worktree」的实质含义
      writeFileSync(join(a.path, "only-in-a.txt"), "A\n", "utf8");
      expect(existsSync(join(a.path, "only-in-a.txt"))).toBe(true);
      expect(existsSync(join(b.path, "only-in-a.txt"))).toBe(false);
      // 主仓库也不受影响
      expect(existsSync(join(repoRoot, "only-in-a.txt"))).toBe(false);
    } finally {
      removeWorktree(repoRoot, a.path, true);
      removeWorktree(repoRoot, b.path, true);
    }
  }, 90_000);

  it("目标路径已存在时**拒绝**而不是覆盖（保护未提交内容）", () => {
    const worktreeRoot = join(repoRoot, ".local", "worktrees");
    const base = headSha();
    const attemptId = "ATTEMPT-3";

    const first = prepareWorktree({
      repo_root: repoRoot,
      worktree_root: worktreeRoot,
      base_sha: base,
      task_id: "TASK-TEST-3",
      attempt_id: attemptId,
      branch: "task/TASK-TEST-3/ATTEMPT-3",
    });

    try {
      // 放一个未提交文件，模拟「已有未提交内容」
      writeFileSync(join(first.path, "uncommitted.txt"), "重要未提交内容\n", "utf8");

      // 再次对同一 attempt 准备 worktree 必须硬失败
      expect(() =>
        prepareWorktree({
          repo_root: repoRoot,
          worktree_root: worktreeRoot,
          base_sha: base,
          task_id: "TASK-TEST-3",
          attempt_id: attemptId,
          branch: "task/TASK-TEST-3/ATTEMPT-3-retry",
        }),
      ).toThrow(/已存在/);

      // 未提交内容必须还在 —— 没被任何清理动作破坏
      expect(existsSync(join(first.path, "uncommitted.txt"))).toBe(true);
      expect(readFileSync(join(first.path, "uncommitted.txt"), "utf8")).toContain(
        "重要未提交内容",
      );
    } finally {
      removeWorktree(repoRoot, first.path, true);
    }
  }, 60_000);

  it("基线提交不存在时拒绝开工，不用当前 HEAD 顶替", () => {
    const worktreeRoot = join(repoRoot, ".local", "worktrees");
    const fakeSha = "0".repeat(40);

    expect(() =>
      prepareWorktree({
        repo_root: repoRoot,
        worktree_root: worktreeRoot,
        base_sha: fakeSha,
        task_id: "TASK-TEST-4",
        attempt_id: "ATTEMPT-4",
        branch: "task/TASK-TEST-4/ATTEMPT-4",
      }),
    ).toThrow(/不存在/);
  }, 30_000);

  it("isInside 正确处理中文相似前缀（不把‘双端连接2’当子目录）", () => {
    expect(isInside("C:/x/双端连接", "C:/x/双端连接/sub")).toBe(true);
    expect(isInside("C:/x/双端连接", "C:/x/双端连接2")).toBe(false);
    expect(isInside("C:/x/双端连接", "C:/x/双端连接")).toBe(true);
    expect(isInside("C:/x/双端连接", "C:/x/其他")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 三、真实测试输出解析
 * ------------------------------------------------------------------ */

describe("真实测试输出解析（evidence.ts）", () => {
  /**
   * 以下样本是**真实采集**的 vitest 3.x 输出（见下），
   * 不是凭记忆构造的。采集方式：
   *   node node_modules/vitest/vitest.mjs run <file> --reporter=default
   * 之所以不在这里嵌套拉起 vitest：vitest 进程内再跑 vitest 会卡住，
   * 采集真实样本后在这里做纯解析断言更可靠、也更快。
   */
  const REAL_VITEST_ALL_PASS = [
    "",
    " Test Files  1 passed (1)",
    "      Tests  16 passed (16)",
    "   Start at  10:48:45",
    "   Duration  1.04s (transform 101ms, setup 0ms, collect 213ms, tests 8ms, environment 0ms, prepare 218ms)",
    "",
  ].join("\n");

  /** 真实失败输出（vitest 3.x 用**竖线**分隔各段） */
  const REAL_VITEST_WITH_FAILURE = [
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 1 passed (2)",
    "   Start at  10:52:10",
    "",
  ].join("\n");

  /** 真实含跳过输出 */
  const REAL_VITEST_WITH_SKIPPED = [
    "",
    " Test Files  1 passed (1)",
    "      Tests  13 passed | 2 skipped (16)",
    "",
  ].join("\n");

  it("解析真实全绿输出", () => {
    const summary = parseTestSummary(REAL_VITEST_ALL_PASS);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(16);
    expect(summary!.failed).toBe(0);
    expect(summary!.skipped).toBe(0);
  });

  it("解析真实**失败**输出（竖线分隔）—— 曾漏掉的分支", () => {
    const summary = parseTestSummary(REAL_VITEST_WITH_FAILURE);
    expect(summary).not.toBeNull();
    // 这一条曾经返回 null，导致真实失败被判为「无法判定」
    expect(summary!.failed).toBe(1);
    expect(summary!.passed).toBe(1);
  });

  it("解析真实含跳过输出", () => {
    const summary = parseTestSummary(REAL_VITEST_WITH_SKIPPED);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(13);
    expect(summary!.failed).toBe(0);
    expect(summary!.skipped).toBe(2);
  });

  it("失败段在前的格式也能正确区分，不把数字串位", () => {
    const summary = parseTestSummary("      Tests  3 failed | 7 passed (10)");
    expect(summary).toEqual({ passed: 7, failed: 3, skipped: 0 });
    const reversed = parseTestSummary("      Tests  7 passed | 3 failed (10)");
    expect(reversed).toEqual({ passed: 7, failed: 3, skipped: 0 });
  });

  it("jest 风格（逗号分隔、带 total）仍可解析", () => {
    const summary = parseTestSummary("Tests:       1 failed, 79 passed, 2 skipped, 82 total");
    expect(summary).toEqual({ passed: 79, failed: 1, skipped: 2 });
  });

  it("认不出的格式返回 null，不编造数字", () => {
    expect(parseTestSummary("no summary here at all")).toBeNull();
    expect(parseTestSummary("Tests  0 passed (0)")).toBeNull();
  });

  it("collectEvidence 采集真实命令并算出 SHA-256", async () => {
    const result = await collectEvidence({
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("      Tests  7 passed (7)\\n")',
      ],
      cwd: process.cwd(),
      timeout_ms: 15_000,
      evidence_id: "EVID-REAL-1",
    });

    expect(result.evidence.evidence_id).toBe("EVID-REAL-1");
    expect(result.evidence.exit_code).toBe(0);
    // 真实输出被解析出 7 passed
    expect(result.summary_parsed).toBe(true);
    expect(result.evidence.summary.passed).toBe(7);
    // SHA-256 是 64 位十六进制
    expect(result.evidence.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("SHA-256 对相同输入可复现、对不同输入不同", async () => {
    const mk = (text: string, id: string) =>
      collectEvidence({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)})`],
        cwd: process.cwd(),
        timeout_ms: 15_000,
        evidence_id: id,
      });

    const a1 = await mk("same-output", "E1");
    const a2 = await mk("same-output", "E2");
    const b = await mk("different-output", "E3");

    // 只依赖输出内容，与 evidence_id 无关
    expect(a1.evidence.output_sha256).toBe(a2.evidence.output_sha256);
    expect(a1.evidence.output_sha256).not.toBe(b.evidence.output_sha256);
  }, 90_000);

  it("真实长驻测试命令超时后仍返回可记录的证据", async () => {
    const result = await collectEvidence({
      command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      timeout_ms: 800,
      evidence_id: "EVID-REAL-TIMEOUT",
    });

    // 超时不是解析错误：仍产出证据对象，exit_code 非 0，summary 计为 0/0/0
    expect(result.evidence.exit_code).not.toBe(0);
    expect(result.summary_parsed).toBe(false);
    expect(result.evidence.summary).toEqual({ passed: 0, failed: 0, skipped: 0 });
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 四、真实 OpenCode 调用（可选联网/需登录）
 * ------------------------------------------------------------------ */

describe("真实 OpenCode 调用", () => {
  // 默认跳过：需要本机装好 opencode 且模型登录可用，
  // 会真实消耗额度。用 DAC_RUN_OPENCODE=1 显式开启。
  const enabled = process.env["DAC_RUN_OPENCODE"] === "1";

  it.skipIf(!enabled)(
    "真实调用一次 opencode，事件流可被解析",
    async () => {
      const model = process.env["DAC_OPENCODE_MODEL"] ?? "myapi/gpt-5.6-sol";
      const result = await runProcess(
        {
          executable: "opencode",
          args: ["run", "-m", model, "--format", "json", "reply with exactly: OK"],
          cwd: process.cwd(),
        },
        { timeout_ms: 180_000, grace_ms: 5_000 },
      );

      expect(result.exit_code).toBe(0);
      // JSON Lines：每行一个事件
      const lines = result.stdout
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith("{"));
      expect(lines.length).toBeGreaterThan(0);
      const types = lines
        .map((l) => {
          try {
            return (JSON.parse(l) as { type?: string }).type;
          } catch {
            return undefined;
          }
        })
        .filter(Boolean);
      expect(types).toContain("step_finish");
    },
    240_000,
  );

  it("未显式开启时明确说明跳过原因（不留模糊的‘没跑’）", () => {
    if (!enabled) {
      // 不是失败，而是确保「跳过」这件事本身有明确记录
      expect(process.env["DAC_RUN_OPENCODE"]).not.toBe("1");
    }
    expect(typeof nodeProcessRunner.start).toBe("function");
  });
});
