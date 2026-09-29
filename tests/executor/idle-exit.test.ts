/**
 * B14：常驻入口「空闲退出」必须在时限内自然结束，并给出退出码。
 *
 * ## 为什么必须用子进程来断言
 * A 端 P3 首轮真实运行（2026-09-29）现场：
 * ```text
 * [exit] stop_reason=idle_limit polls=6 attempts=1 registered=true
 * { ... 完整报告已打印 ... }
 * ```
 * 报告打印完之后，Node 主进程仍然活着，CPU 为 0，**>14 分钟**不退出，
 * 最后被人工结束 —— 因此这一轮**从未给出退出码**。
 *
 * 根因（实测定位，见 docs/reports/B14-*.md）：
 * `adapters/opencode.ts` 里
 * `Promise.race([exitedPromise, spawnFailure, new Promise(r => setTimeout(r, timeout + KILL_GRACE_MS))])`
 * 的**兜底定时器从未被清理**（紧随其后的 `clearTimeout(killTimer)` 清的是另一个
 * 定时器）。agent 超时默认 1_800_000 ms，于是一次**正常完成**的 agent 调用也会
 * 在事件循环里留下一个 30 分钟的 **ref 定时器**。
 *
 * 这类缺陷在 vitest 进程内是看不见的 —— vitest 自己会退出，残留定时器不会让
 * 任何断言失败。所以本文件把「跑完整常驻入口」这一段放进**子进程**，
 * 用「时限 + 退出码」来断言：进程必须自己退出，且退出码必须是数字。
 *
 * `fixtures/idle-exit-driver.ts` 里 agent 与测试命令都是**真子进程**，
 * 仓库/工作树/提交/推送/远端核对全部真实；只有协调器 HTTP 传输是内存夹具。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** 允许驱动器完成的最长时间。修复前实测是「十几分钟不退出」，远超此界。 */
const EXIT_DEADLINE_MS = 90_000;

/**
 * 找到 tsx 的 CLI 入口。
 *
 * 之所以用 tsx 而不是构建产物 `apps/executor/dist`：`dist/` 被 gitignore，
 * 而且 `npm test` 单跑时可能是旧的 —— 那会让本用例测到一个与源码不符的东西。
 * tsx 已是 devDependency（`validate:protocol` 就用它），随 `npm install` 必然存在。
 */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 tsx CLI（node_modules/tsx/dist/cli.mjs）：无法启动驱动器子进程");
}

/** 子进程环境：去掉代理变量，避免测试与网络/代理行为耦合。 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "NODE_USE_ENV_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
  ]) {
    delete env[key];
  }
  return env;
}

describe("B14 常驻入口空闲退出：进程必须自己在时限内退出并给出退出码", () => {
  it(
    "跑完一个真实 attempt 后收口为 idle_limit，子进程在时限内自然退出（退出码 0）",
    () => {
      const driver = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "idle-exit-driver.ts");
      const start = Date.now();

      const result = spawnSync(process.execPath, [resolveTsxCli(), driver], {
        cwd: process.cwd(),
        env: childEnv(),
        encoding: "utf8",
        timeout: EXIT_DEADLINE_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });

      const elapsed = Date.now() - start;
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      /* --- 第一件事：它到底退出了没有 --------------------------------- */
      // 超时的话 spawnSync 会杀掉子进程并把 signal 置上、status 留空。
      // 这正是修复前的现象：进程不退出，永远拿不到退出码。
      expect(
        {
          timed_out_or_signalled: result.signal !== null,
          error: result.error === undefined ? null : String(result.error.message),
        },
        `子进程未在 ${EXIT_DEADLINE_MS} ms 内自然退出。stdout 尾部：\n${stdout.slice(-2000)}\nstderr 尾部：\n${stderr.slice(-2000)}`,
      ).toEqual({ timed_out_or_signalled: false, error: null });

      /* --- 第二件事：必须是**数字**退出码，而不是 null ------------------ */
      expect(result.status).toBe(0);

      /* --- 第三件事：证明它真的跑完了整条链路（否则「退出」没有意义）--- */
      expect(stdout).toContain("DRIVER_DONE");

      const reportLine = stdout.split(/\r?\n/).find((line) => line.startsWith("DRIVER_REPORT="));
      expect(reportLine, "驱动器没有打印 DRIVER_REPORT").toBeDefined();
      const report = JSON.parse(reportLine!.slice("DRIVER_REPORT=".length)) as {
        stop_reason: string;
        attempts: Array<{ result: string; pushed: boolean }>;
        reports: number;
      };
      expect(report.stop_reason).toBe("idle_limit");
      expect(report.attempts).toHaveLength(1);
      // attempt 真的跑通了（提交 + 推送 + 上报），不是「起不来所以退出很快」
      expect(report.attempts[0]!.pushed).toBe(true);
      expect(report.attempts[0]!.result).toBe("reported");
      expect(report.reports).toBe(1);

      // 顺带记一条上界：正常完成应在数十秒内，而不是「恰好卡在时限上」
      expect(elapsed).toBeLessThan(EXIT_DEADLINE_MS);
    },
    // vitest 自身的超时要宽于子进程时限，否则失败原因会被 vitest 的超时掩盖
    EXIT_DEADLINE_MS + 30_000,
  );

  it("对照：本用例的判定方式确实能识别「不退出」（否则上面的断言是空的）", () => {
    const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
      encoding: "utf8",
      timeout: 3_000,
      windowsHide: true,
    });

    // 故意留一个 10 分钟的 ref 定时器 → 必须被判定为「超时未退出」。
    // 这条断言保证：假如驱动器将来重新引入残留定时器，上面的用例一定会失败。
    expect(result.status).toBeNull();
    expect(result.signal).not.toBeNull();
    expect(result.error).toBeDefined();
  }, 30_000);
});
