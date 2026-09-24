/**
 * OpenCode 启动方式解析的单元测试（B6-2）。
 *
 * ## 为什么这些用例值得单独存在
 * `resolveOpenCodeLaunch` 的输入是**本机环境**（PATH、npm 全局目录、
 * shim 文件内容），一旦写错就只能在 Windows 上以 `ENOENT` 的形式暴露，
 * 而 Linux CI 永远看不到。因此这里把文件系统探测替换成假 probe，
 * 把五种形态全部钉死在单元测试里：
 *
 * | 形态 | 触发条件 |
 * | --- | --- |
 * | 显式原生可执行文件 | `EXECUTOR_OPENCODE_EXE` |
 * | 显式 `node` + JS 入口 | `EXECUTOR_OPENCODE_JS_ENTRY`（A 端 B6-2 描述的形式） |
 * | npm 包 `bin` → `.exe` | 本机的**真实**形态 |
 * | npm 包 `bin` → `.js` | 其它环境可能出现的形态 |
 * | 从 shim 文本解析 | 包元数据读不到时的兜底 |
 *
 * 另外两条「不许静默降级」的约束也在此锁定：找不到时返回 `not_found`
 * 并列出搜索路径；显式配置指到不存在的文件时**明确失败**，
 * 而不是退回裸命令名去撞 `ENOENT`。
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultLaunchProbe,
  describeLaunchResolution,
  resolveOpenCodeLaunch,
} from "../../apps/executor/src/adapters/opencode-launcher.js";
import type { LaunchProbe } from "../../apps/executor/src/adapters/opencode-launcher.js";

/* ------------------------------------------------------------------ *
 * 假 probe：把「本机环境」完全交给用例定义
 * ------------------------------------------------------------------ */

interface ProbeFixture {
  /** 目录 → 目录项 */
  dirs?: Record<string, readonly string[]>;
  /** 存在的文件 → 内容（`isFile` 只认这里出现过的路径） */
  files?: Record<string, string>;
  node?: string;
  platform?: NodeJS.Platform;
}

function makeProbe(fixture: ProbeFixture = {}): LaunchProbe {
  const dirs = fixture.dirs ?? {};
  const files = fixture.files ?? {};
  const platform = fixture.platform ?? "win32";
  return {
    listDir: (dir) => dirs[dir] ?? null,
    readTextFile: (file) => files[file] ?? null,
    isFile: (file) => Object.prototype.hasOwnProperty.call(files, file),
    nodeExecutable: () => fixture.node ?? join("D:", "node", "node.exe"),
    platform: () => platform,
    delimiter: () => (platform === "win32" ? ";" : ":"),
  };
}

/**
 * 一个**明显是假的** npm 全局前缀。
 *
 * 刻意用 `D:\npm-global` 而不是任何真实用户目录——用例本身也要证明
 * 「解析不依赖写死的路径」。
 */
const NPM_PREFIX = join("D:", "npm-global");
const NODE = join("D:", "node", "node.exe");
const PKG_DIR = join(NPM_PREFIX, "node_modules", "opencode-ai");
const PKG_JSON = join(PKG_DIR, "package.json");

/* ------------------------------------------------------------------ *
 * 显式配置优先
 * ------------------------------------------------------------------ */

describe("B6-2 显式配置优先", () => {
  it("exe_path 优先于一切自动探测，且不加任何前缀参数", () => {
    const exe = join("E:", "tools", "opencode.exe");
    const probe = makeProbe({ files: { [exe]: "MZ" } });

    const r = resolveOpenCodeLaunch({
      configured: { exe_path: exe },
      path_env: NPM_PREFIX,
      probe,
    });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
    expect(r.spec.prefix_args).toEqual([]);
    expect(r.spec.source).toBe("explicit_exe");
  });

  it("js_entry + node_path → 用 node 启动入口（A 端 B6-2 描述的形式）", () => {
    const entry = join("E:", "tools", "opencode.js");
    const probe = makeProbe({ files: { [entry]: "console.log(1)" } });

    const r = resolveOpenCodeLaunch({
      configured: { js_entry: entry, node_path: NODE },
      path_env: "",
      probe,
    });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(NODE);
    expect(r.spec.prefix_args).toEqual([entry]);
    expect(r.spec.source).toBe("explicit_js_entry");
  });

  it("显式配置指到不存在的文件时**明确失败**，不退回裸命令名", () => {
    const missing = join("E:", "nope", "opencode.exe");
    const probe = makeProbe({ files: {} });

    const r = resolveOpenCodeLaunch({ configured: { exe_path: missing }, path_env: "", probe });

    expect(r.kind).toBe("not_found");
    if (r.kind !== "not_found") return;
    // 排障线索里必须出现那个错的路径，否则只能靠猜
    expect(r.searched).toContain(missing);
  });
});

/* ------------------------------------------------------------------ *
 * 自动探测：npm 全局包的 bin
 * ------------------------------------------------------------------ */

describe("B6-2 从 npm 全局包元数据解析", () => {
  it("bin 指向 .exe → 直接用绝对路径（本机真实形态）", () => {
    const exe = join(PKG_DIR, "bin", "opencode.exe");
    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.cmd", "opencode.ps1", "opencode"] },
      files: {
        [PKG_JSON]: JSON.stringify({ name: "opencode-ai", bin: { opencode: "./bin/opencode.exe" } }),
        [exe]: "MZ",
      },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
    expect(r.spec.prefix_args).toEqual([]);
    expect(r.spec.source).toBe("npm_package_bin_exe");
    // 这正是修复的核心：不再把裸 `opencode` 交给 spawn
    expect(r.spec.command).not.toBe("opencode");
  });

  it("bin 指向 JS 入口 → 改用 node 启动", () => {
    const entry = join(PKG_DIR, "bin", "opencode.js");
    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.cmd"] },
      files: {
        [PKG_JSON]: JSON.stringify({ name: "opencode-ai", bin: { opencode: "./bin/opencode.js" } }),
        [entry]: "#!/usr/bin/env node",
      },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(NODE);
    expect(r.spec.prefix_args).toEqual([entry]);
    expect(r.spec.source).toBe("npm_package_bin_js");
  });

  it("bin 为字符串形式时同样能解析", () => {
    const exe = join(PKG_DIR, "bin", "opencode.exe");
    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.cmd"] },
      files: {
        [PKG_JSON]: JSON.stringify({ name: "opencode-ai", bin: "./bin/opencode.exe" }),
        [exe]: "MZ",
      },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
  });
});

/* ------------------------------------------------------------------ *
 * 自动探测：PATH 上的直接可执行文件 与 shim 文本
 * ------------------------------------------------------------------ */

describe("B6-2 从 PATH 与 shim 文本解析", () => {
  it("PATH 上直接有 opencode.exe 时优先用它", () => {
    const dir = join("D:", "bin");
    const exe = join(dir, "opencode.exe");
    const probe = makeProbe({ dirs: { [dir]: ["opencode.exe"] }, files: { [exe]: "MZ" } });

    const r = resolveOpenCodeLaunch({ path_env: dir, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
    expect(r.spec.source).toBe("path_exe");
  });

  it("包元数据缺失时，从 `.cmd` 文本解析并展开 `%dp0%`", () => {
    const exe = join(PKG_DIR, "bin", "opencode.exe");
    const cmd = join(NPM_PREFIX, "opencode.cmd");
    // 与 npm 1.18.31 生成的真实 shim 同形（含 %~dp0 与 %dp0%）
    const shim = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
      "",
    ].join("\r\n");

    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.cmd"] },
      files: { [cmd]: shim, [exe]: "MZ" },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
    expect(r.spec.prefix_args).toEqual([]);
    expect(r.spec.source).toBe("shim_exe");
  });

  it("`.ps1` 里的 `$basedir` 同样能展开", () => {
    const entry = join(PKG_DIR, "bin", "opencode.js");
    const ps1 = join(NPM_PREFIX, "opencode.ps1");
    const shim = ['#!/usr/bin/env pwsh', '& "$basedir/node_modules/opencode-ai/bin/opencode.js" $args', ""].join(
      "\n",
    );

    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.ps1"] },
      files: { [ps1]: shim, [entry]: "#!/usr/bin/env node" },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(NODE);
    expect(r.spec.prefix_args).toEqual([entry]);
    expect(r.spec.source).toBe("shim_js_entry");
  });

  it("类 Unix 环境按无扩展名的 `opencode` 查找", () => {
    const dir = join("/usr", "local", "bin");
    const bin = join(dir, "opencode");
    const probe = makeProbe({
      dirs: { [dir]: ["opencode"] },
      files: { [bin]: "#!/usr/bin/env node" },
      platform: "linux",
    });

    const r = resolveOpenCodeLaunch({ path_env: dir, probe });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(bin);
    expect(r.spec.source).toBe("path_exe");
  });
});

/* ------------------------------------------------------------------ *
 * 解析失败与排障信息
 * ------------------------------------------------------------------ */

describe("B6-2 解析失败时不静默降级", () => {
  it("什么都没找到：返回 not_found，并列出搜索过的目录", () => {
    const empty = join("D:", "empty-bin");
    const probe = makeProbe({ dirs: { [empty]: [] }, files: {} });

    const r = resolveOpenCodeLaunch({ path_env: empty, probe });

    expect(r.kind).toBe("not_found");
    if (r.kind !== "not_found") return;
    expect(r.searched).toContain(empty);
    expect(describeLaunchResolution(r)).toContain("未解析出");
  });

  it("shim 存在但目标文件不存在：仍然 not_found（不假装成功）", () => {
    const cmd = join(NPM_PREFIX, "opencode.cmd");
    const probe = makeProbe({
      dirs: { [NPM_PREFIX]: ["opencode.cmd"] },
      // 只给 shim，不给它指向的 exe
      files: { [cmd]: '@ECHO off\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\n' },
    });

    const r = resolveOpenCodeLaunch({ path_env: NPM_PREFIX, probe });
    expect(r.kind).toBe("not_found");
  });

  it("`search_dirs` 允许把额外目录纳入搜索（仍来自本地配置）", () => {
    const extra = join("E:", "custom-tools");
    const exe = join(extra, "opencode.exe");
    const probe = makeProbe({ dirs: { [extra]: ["opencode.exe"] }, files: { [exe]: "MZ" } });

    const r = resolveOpenCodeLaunch({
      configured: { search_dirs: [extra] },
      path_env: "",
      probe,
    });

    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.spec.command).toBe(exe);
    expect(r.spec.source).toBe("path_exe");
  });

  it("解析成功时 describeLaunchResolution 给出方式与依据", () => {
    const exe = join("E:", "tools", "opencode.exe");
    const probe = makeProbe({ files: { [exe]: "MZ" } });
    const r = resolveOpenCodeLaunch({ configured: { exe_path: exe }, path_env: "", probe });
    if (r.kind !== "resolved") throw new Error("应当解析成功");
    const line = describeLaunchResolution(r);
    expect(line).toContain("explicit_exe");
    expect(line).toContain(exe);
  });
});

/* ------------------------------------------------------------------ *
 * 默认探测（真实文件系统）
 * ------------------------------------------------------------------ */

describe("B6-2 默认探测不抛异常", () => {
  it("defaultLaunchProbe 对不存在的路径返回 safe 值", () => {
    const probe = defaultLaunchProbe();
    const ghost = join("D:", "definitely-not-here-9f3a", "x.exe");
    expect(probe.isFile(ghost)).toBe(false);
    expect(probe.readTextFile(ghost)).toBeNull();
    expect(probe.listDir(join("D:", "definitely-not-here-9f3a"))).toBeNull();
    expect(probe.nodeExecutable().length).toBeGreaterThan(0);
  });

  it("用真实环境解析（不崩；结果交给 §7 真实启动用例验证）", () => {
    const r = resolveOpenCodeLaunch();
    expect(r.kind === "resolved" || r.kind === "not_found").toBe(true);
    if (r.kind === "resolved") {
      expect(r.spec.command.length).toBeGreaterThan(0);
    } else {
      expect(Array.isArray(r.searched)).toBe(true);
    }
  });
});
