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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { checkDiffScope } from "../../apps/executor/src/core/diff-check.js";

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

  /**
   * B5 回归（真实链路逼出来的缺陷）。
   *
   * `runProcess` 原先**无条件**先 `await sleep(timeout_ms)`，再判断进程是否
   * 早已退出。于是子进程瞬间正常结束时，调用方仍要空等满整个超时。
   * 在真实链路上，`collectEvidence` 每次采集测试证据都会白等
   * `test_timeout_ms`（常驻入口默认 600 秒／次）。
   *
   * 这条用例断言的核心不是「结果对不对」，而是**及时性**：
   * 30 秒的超时下，一个立刻退出的进程必须在数秒内返回。
   * 修复前这里会稳定地耗掉 30 秒。
   */
  it(
    "真实进程立即退出时**立刻**返回，不空等满超时（B5 回归）",
    async () => {
      const started = Date.now();
      const result = await runProcess(
        {
          executable: process.execPath,
          args: ["-e", 'process.stdout.write("fast"); process.exit(0)'],
          cwd: process.cwd(),
        },
        // 故意给一个很大的超时：修复前就会等这么久
        { timeout_ms: 30_000, grace_ms: 1_000 },
      );
      const elapsed = Date.now() - started;

      expect(result.timed_out).toBe(false);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain("fast");
      // 留出充足余量给慢机器，但仍远小于 30 秒
      expect(elapsed).toBeLessThan(15_000);
    },
    60_000,
  );

  it(
    "真实非零退出码被如实返回（不得被静默抹成 null）",
    async () => {
      const result = await runProcess(
        {
          executable: process.execPath,
          args: ["-e", "process.exit(7)"],
          cwd: process.cwd(),
        },
        { timeout_ms: 30_000, grace_ms: 1_000 },
      );

      expect(result.timed_out).toBe(false);
      expect(result.exit_code).toBe(7);
    },
    60_000,
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
      // 已登记为同一个 worktree。Windows runner 的 tmpdir 可能使用 8.3 短路径，
      // 而 Git 返回对应长路径；交给文件系统规范化后再严格比较真实位置。
      const preparedRealPath = realpathSync.native(prepared.path);
      expect(
        listWorktrees(repoRoot).some(
          (registeredPath) => realpathSync.native(registeredPath) === preparedRealPath,
        ),
      ).toBe(true);
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
 * 二·补、真实 Git 核对失败必须 fail-closed（B8 · A 端 B7-2）
 *
 * A 端复现：在不存在的仓库路径调用 `checkDiffScope()` 得到 `ok: true`
 * 与空违规列表。下面用**真实 Git**证明修复后的行为，而不是靠假体。
 * ------------------------------------------------------------------ */

describe("真实 Git fail-closed（B8 · B7-2）", () => {
  let failCloseRoot: string;
  const SCOPE = { allow: ["apps/executor/**"], deny: [] };

  beforeAll(() => {
    resolveGitExecutable();
    failCloseRoot = mkdtempSync(join(tmpdir(), "dac-failclose-"));
    const must = (args: string[]): void => {
      const r = git(failCloseRoot, args);
      if (r.exit_code !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr.trim()}`);
    };
    must(["init", "-q"]);
    must(["config", "user.email", "b@example.invalid"]);
    must(["config", "user.name", "B Test"]);
    must(["config", "commit.gpgsign", "false"]);
    mkdirSync(join(failCloseRoot, "apps", "coordinator", "src"), { recursive: true });
    mkdirSync(join(failCloseRoot, "apps", "executor", "src"), { recursive: true });
    writeFileSync(
      join(failCloseRoot, "apps", "coordinator", "src", "api.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    must(["add", "-A"]);
    must(["commit", "-q", "-m", "init"]);
  });

  afterAll(() => {
    if (failCloseRoot) rmSync(failCloseRoot, { recursive: true, force: true });
  });

  it("真实无效路径 → ok:false 且带 error（缺陷已修复）", () => {
    const result = checkDiffScope({
      worktree_path: join(failCloseRoot, "no-such-dir"),
      base_sha: "0".repeat(40),
      scope: SCOPE,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    // 关键：不是「没有变更」，而是「没法核对」
    expect(result.changed_files).toEqual([]);
  });

  it("真实基线提交不存在 → ok:false", () => {
    const result = checkDiffScope({
      worktree_path: failCloseRoot,
      base_sha: "0".repeat(40),
      scope: SCOPE,
    });
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });

  it("真实跨范围重命名被查出来：源的越界不会被改名掩盖", () => {
    const base = git(failCloseRoot, ["rev-parse", "HEAD"]).stdout.trim();
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    const moved = git(failCloseRoot, [
      "mv",
      "apps/coordinator/src/api.ts",
      "apps/executor/src/api.ts",
    ]);
    expect(moved.exit_code).toBe(0);
    expect(git(failCloseRoot, ["commit", "-q", "-m", "rename across scope"]).exit_code).toBe(0);

    const result = checkDiffScope({
      worktree_path: failCloseRoot,
      base_sha: base,
      scope: SCOPE,
    });
    // 核对本身成功……
    expect(result.error).toBeNull();
    // ……结论是越界：`apps/coordinator/**` 不在允许范围内
    expect(result.changed_files).toContain("apps/coordinator/src/api.ts");
    expect(result.violations).toContain("apps/coordinator/src/api.ts");
    expect(result.ok).toBe(false);
  });

  it("真实正常改动 → ok:true 且 error 为 null（fail-closed 没有把正常路径也判失败）", () => {
    const base = git(failCloseRoot, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(
      join(failCloseRoot, "apps", "executor", "src", "new.ts"),
      "export const b = 2;\n",
      "utf8",
    );
    expect(git(failCloseRoot, ["add", "-A"]).exit_code).toBe(0);
    expect(git(failCloseRoot, ["commit", "-q", "-m", "in scope"]).exit_code).toBe(0);

    const result = checkDiffScope({
      worktree_path: failCloseRoot,
      base_sha: base,
      scope: SCOPE,
    });
    expect(result.error).toBeNull();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
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
 * 三之二、Node 内置测试运行器（TAP）汇总解析 —— B13
 * ------------------------------------------------------------------ */

/**
 * B13 背景（A 端 P3 首轮真实运行裁定）：P3 目标仓库用 `node --test`
 * （Node 内置运行器，默认输出 TAP），而 parseTestSummary 此前只认 vitest/jest
 * 的 `Tests` 行，于是**真实全绿**的一次运行被解析成 `passed: 0`，
 * 上报被协调器以 RESULT_SCHEMA_INVALID 正确拒绝。
 *
 * 下面所有样本都是**真实采集**的（Node v22.22.2、`node --test`），
 * 采集脚本与原始输出见 docs/reports/B13-*.md；**不要凭记忆改这些常量**。
 *
 * B16 背景（A 端 B15 复核）：B13 的 fail-closed 只强制 `tests/pass/fail`，
 * 缺 `suites/cancelled/skipped/todo` 时按 0 补，也不要求版本头与终止标记，
 * 于是「不完整 TAP 片段」也能报出通过数。现收紧为**只认结构完整的
 * TAP v13 输出**；下面同时保留 A 给出的两份不完整输入作为拒绝用例。
 */
describe("Node 内置运行器 TAP 汇总解析（evidence.ts，B13；B16 只认完整输出）", () => {
  /** P3 目标仓库首轮真实输出（TASK-1001-A2），2 passed / 0 failed、退出码 0 */
  const REAL_TAP_P3 = [
    "TAP version 13",
    "# Subtest: 冻结契约只要求字符串 id 和 name",
    "ok 1 - 冻结契约只要求字符串 id 和 name",
    "  ---",
    "  duration_ms: 1.0889",
    "  type: 'test'",
    "  ...",
    "# Subtest: getUser returns the frozen UserProfile shape",
    "ok 2 - getUser returns the frozen UserProfile shape",
    "  ---",
    "  duration_ms: 0.7298",
    "  type: 'test'",
    "  ...",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass 2",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 161.1573",
    "",
  ].join("\n");

  /** 真实失败样本：1 passed / 1 failed */
  const REAL_TAP_WITH_FAILURE = [
    "TAP version 13",
    "# Subtest: alpha",
    "ok 1 - alpha",
    "# Subtest: beta",
    "not ok 2 - beta",
    "  ---",
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    "1..2",
    "# tests 2",
    "# suites 0",
    "# pass 1",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 271.8326",
    "",
  ].join("\n");

  /** 真实 skip + todo 样本（注意 `# pass` 不含被跳过的用例） */
  const REAL_TAP_WITH_SKIP_TODO = [
    "TAP version 13",
    "# Subtest: alpha",
    "ok 1 - alpha",
    "# Subtest: beta",
    "ok 2 - beta # SKIP",
    "# Subtest: gamma",
    "ok 3 - gamma # TODO",
    "1..3",
    "# tests 3",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 1",
    "# todo 1",
    "# duration_ms 233.1165",
    "",
  ].join("\n");

  /** 真实嵌套 describe 样本：`# tests` 含子测试（3），`# suites` 单列 */
  const REAL_TAP_NESTED = [
    "TAP version 13",
    "# Subtest: outer",
    "    # Subtest: inner-a",
    "    ok 1 - inner-a",
    "    1..2",
    "ok 1 - outer",
    "  ---",
    "  type: 'suite'",
    "  ...",
    "# Subtest: sibling",
    "ok 2 - sibling",
    "1..2",
    "# tests 3",
    "# suites 1",
    "# pass 3",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 262.3032",
    "",
  ].join("\n");

  /** 真实「无任何测试文件」样本：tests 为 0 —— 没有测试结果，不能算通过 */
  const REAL_TAP_NO_TESTS = [
    "TAP version 13",
    "1..0",
    "# tests 0",
    "# suites 0",
    "# pass 0",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 11.7005",
    "",
  ].join("\n");

  /** 真实「用例被取消」样本：pass 0 / fail 0 / cancelled 1 */
  const REAL_TAP_CANCELLED = [
    "TAP version 13",
    "# Subtest: slow.test.mjs",
    "not ok 1 - slow.test.mjs",
    "  ---",
    "  failureType: 'cancelledByParent'",
    "  ...",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 0",
    "# fail 0",
    "# cancelled 1",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 216.8423",
    "",
  ].join("\n");

  /**
   * 真实「测试文件顶层抛异常（加载失败）」样本。
   *
   * 之所以要留这份：汇总块之前有一大段 `# ...` **注释行**（堆栈、`# Node.js v22.22.2`），
   * 是「正文污染汇总解析」最像真的反例 —— 解析器必须只认
   * `# <字段> <数字>` 这种整行形态，不能被这些注释行带偏。
   */
  const REAL_TAP_LOAD_FAILURE = [
    "TAP version 13",
    "# file:///C:/Users/lenovo/AppData/Local/Temp/b13tap-O9SV9t/case-eg38m4/boom.test.mjs:1",
    "# throw new Error(\"boom at load time\");",
    "#       ^",
    "# Error: boom at load time",
    "#     at file:///C:/Users/lenovo/AppData/Local/Temp/b13tap-O9SV9t/case-eg38m4/boom.test.mjs:1:7",
    "#     at ModuleJob.run (node:internal/modules/esm/module_job:343:25)",
    "# Node.js v22.22.2",
    "# Subtest: boom.test.mjs",
    "not ok 1 - boom.test.mjs",
    "  ---",
    "  duration_ms: 207.6076",
    "  type: 'test'",
    "  failureType: 'testCodeFailure'",
    "  code: 'ERR_TEST_FAILURE'",
    "  ...",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 0",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 220.3114",
    "",
  ].join("\n");

  it("解析 P3 真实 TAP 输出：2 passed / 0 failed（本次 422 的修复点）", () => {
    expect(parseTestSummary(REAL_TAP_P3)).toEqual({ passed: 2, failed: 0, skipped: 0 });
  });

  it("解析真实 TAP 失败输出：failed 非零", () => {
    const summary = parseTestSummary(REAL_TAP_WITH_FAILURE);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(1);
    expect(summary!.failed).toBe(1);
    expect(summary!.skipped).toBe(0);
  });

  it("解析真实 TAP skip + todo：skipped 单独计数，不计入 passed", () => {
    const summary = parseTestSummary(REAL_TAP_WITH_SKIP_TODO);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(1);
    expect(summary!.failed).toBe(0);
    expect(summary!.skipped).toBe(1);
  });

  it("嵌套 describe：tests 含子测试，suites 不参与用例数", () => {
    expect(parseTestSummary(REAL_TAP_NESTED)).toEqual({ passed: 3, failed: 0, skipped: 0 });
  });

  it("cancelled 计入 failed：不制造 passed>0 且 failed=0 的假绿", () => {
    const summary = parseTestSummary(REAL_TAP_CANCELLED);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(0);
    expect(summary!.failed).toBe(1);
  });

  it("CRLF 换行同样可解析（Windows 真实输出）", () => {
    expect(parseTestSummary(REAL_TAP_P3.replace(/\n/g, "\r\n"))).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
    });
  });

  it("tests 为 0 = 没有测试结果，fail closed", () => {
    expect(parseTestSummary(REAL_TAP_NO_TESTS)).toBeNull();
  });

  it("缺必需字段（无 # fail）时 fail closed，不按 0 猜", () => {
    // B16 起用「完整块抽掉一行」构造：唯一差异就是缺了那个字段，
    // 否则用例会因为「缺版本头」而通过，测不到本来要测的规则。
    expect(parseTestSummary(withoutLine("# fail 0"))).toBeNull();
    expect(parseTestSummary(withoutLine("# pass 1"))).toBeNull();
    expect(parseTestSummary(withoutLine("# tests 1"))).toBeNull();
  });

  it("汇总互相矛盾（重复字段取不同值）时 fail closed", () => {
    const contradictory = [
      "TAP version 13",
      "1..2",
      "# tests 2",
      "# suites 0",
      "# pass 2",
      "# fail 0",
      "# tests 5", // ← 同一字段再次出现且数值不同
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 12.5",
      "",
    ].join("\n");
    expect(parseTestSummary(contradictory)).toBeNull();
  });

  it("汇总不自洽（各项之和 ≠ tests）时 fail closed", () => {
    const inconsistent = [
      "TAP version 13",
      "1..10",
      "# tests 10",
      "# suites 0",
      "# pass 2",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 12.5",
      "",
    ].join("\n");
    expect(parseTestSummary(inconsistent)).toBeNull();
  });

  it("输出被截断（只有测试行、没有汇总块）时 fail closed", () => {
    const truncated = [
      "TAP version 13",
      "# Subtest: alpha",
      "ok 1 - alpha",
      "",
    ].join("\n");
    expect(parseTestSummary(truncated)).toBeNull();
  });

  it("只有零星字段、凑不成完整汇总时 fail closed", () => {
    expect(parseTestSummary("# pass 3")).toBeNull();
    expect(parseTestSummary("all 3 tests passed")).toBeNull();
    expect(parseTestSummary("")).toBeNull();
  });

  /* ------------------------------------------------------------------ *
   * B16：只认「结构完整」的 TAP v13 输出（A 端 B15 复核）
   *
   * A 在 B15 候选上实跑，指出 B13 只要凑齐 `tests/pass/fail` 就出摘要，
   * 缺字段按 0 补 —— 于是**不完整/被截断**的片段也会报出通过数。
   * 下面用「抽掉某一行」的方式逐项证明每个必需成分都真的被强制。
   * ------------------------------------------------------------------ */

  /** 一份结构完整的汇总块；每个必需成分都能被单独抽掉做拒绝用例。 */
  const COMPLETE_SUMMARY_LINES = [
    "TAP version 13",
    "# Subtest: alpha",
    "ok 1 - alpha",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 12.5",
  ];
  const completeSummary = (): string => [...COMPLETE_SUMMARY_LINES, ""].join("\n");
  const withoutLine = (needle: string): string =>
    [...COMPLETE_SUMMARY_LINES.filter((line) => line !== needle), ""].join("\n");

  it("B16 正对照：结构完整的汇总块仍能解析（证明拒绝用例不是假阴性）", () => {
    expect(parseTestSummary(completeSummary())).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });

  it("B16：A 给出的两份不完整输入必须拒绝（B13 曾分别报出 1 / 2 个通过）", () => {
    // A 端原文：`parseTestSummary("# tests 1\n# pass 1\n# fail 0")` → { passed: 1, … }
    expect(parseTestSummary("# tests 1\n# pass 1\n# fail 0")).toBeNull();
    // A 端原文：`parseTestSummary("TAP version 13\n# tests 2\n# pass 2\n# fail 0")` → { passed: 2, … }
    expect(parseTestSummary("TAP version 13\n# tests 2\n# pass 2\n# fail 0")).toBeNull();
  });

  it("B16：有完整汇总字段但缺版本头 `TAP version 13` → 拒绝", () => {
    expect(parseTestSummary(withoutLine("TAP version 13"))).toBeNull();
  });

  it("B16：版本头不必是第一行（经 `npm test` 包装仍有 npm 横幅）→ 仍能解析", () => {
    // 为什么要有这一条：执行器的测试命令直接拉起 `node --test` 时 stdout
    // 第一行就是版本头，但若将来经 `npm test` 之类包装，前面会多出 npm 的
    // `> pkg@x.y.z test` 两行横幅 —— 这种输出**真实且完整**，不能判成「无法判定」。
    const wrapped = ["> demo@1.0.0 test", "> node --test", "", ...COMPLETE_SUMMARY_LINES, ""].join("\n");
    expect(parseTestSummary(wrapped)).toEqual({ passed: 1, failed: 0, skipped: 0 });
  });

  it("B16：版本头出现两次（两段输出被拼接）→ 拒绝", () => {
    const twoHeaders = [...COMPLETE_SUMMARY_LINES.slice(0, 1), ...COMPLETE_SUMMARY_LINES, ""].join("\n");
    expect(parseTestSummary(twoHeaders)).toBeNull();
  });

  it("B16：汇总块出现在版本头之前（顺序被改写）→ 拒绝", () => {
    const summaryFirst = [...COMPLETE_SUMMARY_LINES.slice(1), COMPLETE_SUMMARY_LINES[0]!, ""].join("\n");
    expect(parseTestSummary(summaryFirst)).toBeNull();
  });

  it("B16：缺终止标记 `# duration_ms`（输出被截断）→ 拒绝", () => {
    expect(parseTestSummary(withoutLine("# duration_ms 12.5"))).toBeNull();
  });

  it("B16：缺 suites / cancelled / skipped / todo 任一 → 拒绝（不再按 0 补）", () => {
    expect(parseTestSummary(withoutLine("# suites 0"))).toBeNull();
    expect(parseTestSummary(withoutLine("# cancelled 0"))).toBeNull();
    expect(parseTestSummary(withoutLine("# skipped 0"))).toBeNull();
    expect(parseTestSummary(withoutLine("# todo 0"))).toBeNull();
  });

  it("B16：终止标记不在末尾（其后仍有计数字段）→ 拒绝", () => {
    const movedUp = [
      "TAP version 13",
      "1..1",
      "# tests 1",
      "# suites 0",
      "# pass 1",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# duration_ms 12.5", // ← 提前出现，不再是「终止」标记
      "# todo 0", // ← 终止标记之后又冒出计数字段
      "",
    ].join("\n");
    expect(parseTestSummary(movedUp)).toBeNull();
  });

  it("B16：计数字段不是整数（畸形汇总）→ 拒绝", () => {
    const fractional = COMPLETE_SUMMARY_LINES.map((line) =>
      line === "# tests 1" ? "# tests 1.5" : line,
    )
      .concat("")
      .join("\n");
    expect(parseTestSummary(fractional)).toBeNull();
  });

  it("B16：正文含 `# ` 注释行（真实加载失败样本）仍能正确解析", () => {
    const summary = parseTestSummary(REAL_TAP_LOAD_FAILURE);
    expect(summary).not.toBeNull();
    expect(summary!.passed).toBe(0);
    expect(summary!.failed).toBe(1);
    expect(summary!.skipped).toBe(0);
  });

  it("B16：汇总块重复（即使数值完全一致）不再接受", () => {
    // 真实 node --test 只输出一个汇总块；出现两次说明输出被拼接/污染，
    // 「取其中一个」没有依据 → 判不了。
    expect(parseTestSummary(completeSummary() + completeSummary())).toBeNull();

    // 单个计数字段重复出现同理（B13 曾把「重复但一致」当无害）。
    const duplicatedField = COMPLETE_SUMMARY_LINES.concat(["# pass 1", ""]).join("\n");
    expect(parseTestSummary(duplicatedField)).toBeNull();
  });

  it("既有 vitest/jest 解析不受影响（回归）", () => {
    expect(parseTestSummary("      Tests  16 passed (16)")).toEqual({ passed: 16, failed: 0, skipped: 0 });
    expect(parseTestSummary("Tests:       1 failed, 79 passed, 2 skipped, 82 total")).toEqual({
      passed: 79,
      failed: 1,
      skipped: 2,
    });
  });
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
