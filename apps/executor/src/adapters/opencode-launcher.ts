/**
 * OpenCode 启动方式解析（B6-2，A 端裁定）。
 *
 * ## 要解决的问题（实测，不是推测）
 * 本机 `opencode` 由 npm 全局安装，PATH 上只有三个 shim：
 * `opencode.cmd` / `opencode.ps1` / `opencode`（Unix 风格无扩展名脚本）。
 * Node 在 `shell: false` 下**不解析 `.cmd` / `.ps1`**，于是：
 *
 * ```text
 * spawn("opencode", ["--version"], { shell: false })
 *   → { error: "ENOENT" }        // 实测（B5 真实链路测试暴露）
 * ```
 *
 * 而 A 端红线的要求是「保持 `shell: false`，不得经 `cmd.exe /c` 或拼接命令串」。
 * 二者合起来的唯一出路是：**先把 shim 解析成真实目标，再以绝对路径 + 参数数组启动**。
 *
 * ## 本机的真实形态与 A 端假设的差异（必须如实记录）
 * A 端指示的形态是「`node.exe` + CLI 的 JS 入口」。实测本机
 * `opencode-ai@1.18.31` 是**原生程序**，不是 JS：
 *
 * ```text
 * opencode.cmd → "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
 * package.json → "bin": { "opencode": "./bin/opencode.exe" }
 * bin/opencode.exe → 179 998 248 字节，文件头 "MZ"（PE 可执行）
 * 包内唯一的 .mjs 是 postinstall.mjs（安装脚本，不是 CLI 入口）
 * ```
 *
 * 实测结论：
 * ```text
 * spawn("<绝对路径>/opencode.exe", ["--version"], { shell: false })
 *   → status 0, stdout "1.18.31"
 * ```
 *
 * 因此本模块**按形态分派**，两种形态都支持，且**都不经 shell**：
 * - 目标是原生可执行文件 → `command = <绝对路径>`，`prefix_args = []`
 * - 目标是 JS 入口       → `command = <node.exe>`，`prefix_args = [<入口绝对路径>]`
 *
 * 这样既满足 A 端「`node.exe` + 入口」的形式（当环境里确有 JS 入口时），
 * 也覆盖本机的真实形态。两条路径都是「绝对路径 + 参数数组 + `shell: false`」。
 *
 * ## 不硬编码任何用户目录
 * 搜索范围**全部来自运行环境**：
 * - `PATH` 的各个目录；
 * - `npm_config_prefix` 环境变量；
 * - Windows 的 `%APPDATA%\npm`（由 `APPDATA` 推导，不是写死 `C:\Users\...`）；
 * - `opencode.cmd` 所在目录的同级 `node_modules/opencode-ai/`。
 *
 * A 端或 B 端的用户名目录都不会出现在代码里。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 启动方式来自哪里。用于日志与排障，不含敏感信息。 */
export type OpenCodeLaunchSource =
  /**
   * 调用方通过 `executable` 直接点名了可执行文件（**不经过探测**）。
   * 这条路径的存在本身就是一条约束：显式指定不得被自动探测覆盖。
   */
  | "explicit_executable"
  /** 显式配置的原生可执行文件 */
  | "explicit_exe"
  /** 显式配置的 JS 入口（配 node.exe 使用） */
  | "explicit_js_entry"
  /** PATH 上直接找到的原生可执行文件 */
  | "path_exe"
  /** npm 全局包的 `bin` 指向原生可执行文件 */
  | "npm_package_bin_exe"
  /** npm 全局包的 `bin` 指向 JS 入口（用 node.exe 启动） */
  | "npm_package_bin_js"
  /** 从 `.cmd` / `.ps1` shim 内容里解析出的原生可执行文件 */
  | "shim_exe"
  /** 从 `.cmd` / `.ps1` shim 内容里解析出的 JS 入口 */
  | "shim_js_entry";

/** 解析结果：启动什么、前缀参数是什么。 */
export interface OpenCodeLaunchSpec {
  /** 要 spawn 的可执行文件（原生程序，或启动 JS 入口时的 node.exe） */
  command: string;
  /** 置于 CLI 参数之前的固定前缀（JS 入口形态下就是入口路径本身） */
  prefix_args: readonly string[];
  source: OpenCodeLaunchSource;
  /** 人类可读的解析依据，便于日志与排障 */
  detail: string;
}

/**
 * 解析结果。**区分「没找到」与「找到了」**，而不是用 null 混为一谈：
 * 「没找到」时调用方需要把搜索过的目录报出来，否则排障只能靠猜。
 */
export type OpenCodeLaunchResolution =
  | { kind: "resolved"; spec: OpenCodeLaunchSpec }
  | { kind: "not_found"; searched: readonly string[] };

/** 显式配置（最高优先级）。全部为可选，缺省即走自动探测。 */
export interface OpenCodeLaunchConfig {
  /** 可直接 spawn 的可执行文件绝对路径（本机为 `...\opencode-ai\bin\opencode.exe`） */
  exe_path?: string;
  /** CLI 的 JS 入口绝对路径（存在 JS 入口的环境用）；须同时给 `node_path` */
  js_entry?: string;
  /** 启动 JS 入口用的 node 可执行文件绝对路径 */
  node_path?: string;
  /** PATH 之外额外搜索的目录（仍来自本地配置，不写死） */
  search_dirs?: readonly string[];
}

/* ------------------------------------------------------------------ *
 * 可注入的文件系统探测（便于纯函数测试）
 * ------------------------------------------------------------------ */

export interface LaunchProbe {
  /** 列出目录项；目录不存在或不可读时返回 null */
  listDir(dir: string): readonly string[] | null;
  /** 读取文本文件；失败返回 null */
  readTextFile(file: string): string | null;
  /** 是否为普通文件 */
  isFile(file: string): boolean;
  /** 启动 JS 入口时使用的 node 可执行文件 */
  nodeExecutable(): string;
  platform(): NodeJS.Platform;
  /** 环境变量 PATH 的分隔符 */
  delimiter(): string;
}

/** 默认探测：直接作用于真实文件系统与进程环境。 */
export function defaultLaunchProbe(): LaunchProbe {
  return {
    listDir: (dir) => {
      try {
        if (!statSync(dir).isDirectory()) return null;
        return readdirSync(dir);
      } catch {
        return null;
      }
    },
    readTextFile: (file) => {
      try {
        return statSync(file).isFile() ? readFileSync(file, "utf8") : null;
      } catch {
        return null;
      }
    },
    isFile: (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    // 用当前进程的 node：这是「运行本执行器的那个 node」，
    // 比去 PATH 里另找一个更不容易错配（版本与 ABI 都一致）。
    nodeExecutable: () => process.execPath,
    platform: () => process.platform,
    delimiter: () => (process.platform === "win32" ? ";" : ":"),
  };
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export interface ResolveOpenCodeLaunchInput {
  configured?: OpenCodeLaunchConfig;
  /** PATH 内容；缺省取 `process.env.PATH` */
  path_env?: string;
  /** 环境变量来源，用于推导 npm 全局目录；缺省取 `process.env` */
  env?: Readonly<Record<string, string | undefined>>;
  probe?: LaunchProbe;
}

/**
 * 解析出可用的启动方式。优先级：
 *
 * 1. 显式配置的 `exe_path`
 * 2. 显式配置的 `js_entry` + `node_path`
 * 3. PATH（含 `search_dirs`）里的 `opencode.exe` / `opencode`
 * 4. npm 全局包 `opencode-ai/package.json` 的 `bin` 指向
 * 5. shim（`.cmd` / `.ps1`）内容里解析出的目标
 */
export function resolveOpenCodeLaunch(
  input: ResolveOpenCodeLaunchInput = {},
): OpenCodeLaunchResolution {
  const probe = input.probe ?? defaultLaunchProbe();
  const configured = input.configured ?? {};
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const searched: string[] = [];

  /* --- 1. 显式 exe ------------------------------------------- */
  if (configured.exe_path !== undefined && configured.exe_path !== "") {
    const exe = configured.exe_path;
    searched.push(exe);
    if (probe.isFile(exe)) {
      return {
        kind: "resolved",
        spec: {
          command: exe,
          prefix_args: [],
          source: "explicit_exe",
          detail: `显式配置的原生可执行文件：${exe}`,
        },
      };
    }
    // 显式配置指到了不存在的文件：**不要**静默回退到裸命令，
    // 否则会退化成 ENOENT，反而掩盖配置错误。
    return { kind: "not_found", searched };
  }

  /* --- 2. 显式 js_entry + node_path -------------------------- */
  if (configured.js_entry !== undefined && configured.js_entry !== "") {
    const entry = configured.js_entry;
    const node = configured.node_path ?? probe.nodeExecutable();
    searched.push(entry);
    if (probe.isFile(entry)) {
      return {
        kind: "resolved",
        spec: {
          command: node,
          prefix_args: [entry],
          source: "explicit_js_entry",
          detail: `显式配置的 JS 入口：${entry}（node：${node}）`,
        },
      };
    }
    return { kind: "not_found", searched };
  }

  /* --- 3. PATH 上的直接可执行文件 ---------------------------- */
  const dirs = collectSearchDirs(input, probe, env);
  // 搜索过的目录也计入 `searched`：解析失败时这是最有用的排障线索。
  // （最终返回前会去重，所以多个循环重复添加无妨。）
  for (const dir of dirs) searched.push(dir);
  const isWindows = probe.platform() === "win32";
  const exeNames = isWindows ? ["opencode.exe"] : ["opencode"];

  for (const dir of dirs) {
    const entries = probe.listDir(dir);
    if (entries === null) continue;
    for (const name of exeNames) {
      if (!entries.includes(name)) continue;
      const full = join(dir, name);
      searched.push(full);
      if (probe.isFile(full)) {
        return {
          kind: "resolved",
          spec: {
            command: full,
            prefix_args: [],
            source: "path_exe",
            detail: `PATH 上的原生可执行文件：${full}`,
          },
        };
      }
    }
  }

  /* --- 4/5. npm 全局包元数据 与 shim 内容 -------------------- */
  // npm 全局布局：<prefix>/opencode.cmd 与 <prefix>/node_modules/opencode-ai/
  // 先读包元数据（最可靠），读不到再退回解析 shim 文本。
  const shimNames = isWindows ? ["opencode.cmd", "opencode.ps1"] : [];
  for (const dir of dirs) {
    const entries = probe.listDir(dir);
    if (entries === null) continue;

    for (const shimName of shimNames) {
      if (!entries.includes(shimName)) continue;
      const shimPath = join(dir, shimName);
      searched.push(shimPath);

      const fromPackage = resolveFromNpmPackage(dir, probe, searched);
      if (fromPackage !== null) return { kind: "resolved", spec: fromPackage };

      const fromShim = resolveFromShimText(shimPath, dir, probe, searched);
      if (fromShim !== null) return { kind: "resolved", spec: fromShim };
    }
  }

  return { kind: "not_found", searched: dedupe(searched) };
}

function dedupe(items: readonly string[]): readonly string[] {
  return [...new Set(items)];
}

/* ------------------------------------------------------------------ *
 * 内部
 * ------------------------------------------------------------------ */

/** 搜索目录：PATH + 显式 search_dirs + 由环境推导出的 npm 全局目录。 */
function collectSearchDirs(
  input: ResolveOpenCodeLaunchInput,
  probe: LaunchProbe,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const dirs: string[] = [];
  const push = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== "" && !dirs.includes(trimmed)) dirs.push(trimmed);
  };

  const pathEnv = input.path_env ?? env["PATH"] ?? env["Path"];
  for (const part of (pathEnv ?? "").split(probe.delimiter())) push(part);

  for (const extra of input.configured?.search_dirs ?? []) push(extra);

  // npm 全局目录：来自环境变量，不写死任何用户路径。
  push(env["npm_config_prefix"]);
  if (probe.platform() === "win32") {
    const appData = env["APPDATA"];
    if (appData !== undefined && appData.trim() !== "") push(join(appData, "npm"));
  }

  return dirs;
}

/**
 * 读 npm 全局包的 `package.json`，把 `bin` 指向解析成绝对路径。
 *
 * 这是最可靠的来源：shim 文本会随 npm 版本变化，而包元数据是 npm 自己写的。
 */
function resolveFromNpmPackage(
  prefixDir: string,
  probe: LaunchProbe,
  searched: string[],
): OpenCodeLaunchSpec | null {
  const pkgJson = join(prefixDir, "node_modules", "opencode-ai", "package.json");
  searched.push(pkgJson);
  const text = probe.readTextFile(pkgJson);
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const bin = (parsed as Record<string, unknown>).bin;
  const entry = pickBinEntry(bin);
  if (entry === null) return null;

  const entryPath = join(prefixDir, "node_modules", "opencode-ai", entry);
  searched.push(entryPath);
  if (!probe.isFile(entryPath)) return null;

  return specForTarget(entryPath, "npm_package_bin_exe", "npm_package_bin_js", probe, pkgJson);
}

/** `bin` 既可能是字符串，也可能是 `{ "opencode": "./bin/opencode.exe" }`。 */
function pickBinEntry(bin: unknown): string | null {
  if (typeof bin === "string" && bin !== "") return bin;
  if (bin !== null && typeof bin === "object") {
    const value = (bin as Record<string, unknown>)["opencode"];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * 从 `.cmd` / `.ps1` shim 文本里解析目标。
 *
 * 本机的 `opencode.cmd` 形如：
 * ```text
 * "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
 * ```
 * npm 的 `.ps1` 形如：
 * ```text
 * & "$basedir/node_modules/opencode-ai/bin/opencode.exe" $args
 * ```
 * `%dp0%` / `%~dp0` / `$basedir` 都指 shim 自身所在目录。
 */
function resolveFromShimText(
  shimPath: string,
  shimDir: string,
  probe: LaunchProbe,
  searched: string[],
): OpenCodeLaunchSpec | null {
  const text = probe.readTextFile(shimPath);
  if (text === null) return null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("::") || line.startsWith("#")) continue;
    // 只看向外调用目标的行；跳过 SET/CALL/GOTO/标签等控制行。
    if (/^(SET|CALL|GOTO|IF|EXIT|@)/i.test(line)) continue;
    if (!/node_modules|\.exe|\.js|\.mjs|\.cjs/i.test(line)) continue;

    const candidate = extractTargetPath(line, shimDir);
    if (candidate === null) continue;
    searched.push(candidate);
    if (!probe.isFile(candidate)) continue;
    return specForTarget(candidate, "shim_exe", "shim_js_entry", probe, shimPath);
  }
  return null;
}

/** 从一行 shim 文本里取出目标路径，并展开 `%dp0%` / `$basedir`。 */
function extractTargetPath(line: string, shimDir: string): string | null {
  const quoted = line.match(/"([^"\r\n]+)"/);
  const candidate = quoted?.[1] ?? line.match(/(\S+\.(?:exe|js|mjs|cjs))\b/i)?.[1];
  if (candidate === undefined) return null;

  const expanded = candidate
    // npm 的 `.cmd` 写 `%dp0%`，`.ps1` 写 `$basedir`；两者都指 shim 自身目录。
    .replace(/%~?dp0%?/gi, `${shimDir}\\`)
    .replace(/\$basedir/gi, shimDir)
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "");
  return expanded === "" ? null : expanded;
}

/**
 * 按目标扩展名决定启动形态。
 *
 * **这里是 A 端 B6-2 与实测形态的交汇点**：A 端要求用 `node.exe` 启动 CLI 入口，
 * 而本机的 `bin` 是 `.exe`，不存在 JS 入口。两种都支持，都不经 shell。
 */
function specForTarget(
  targetPath: string,
  exeSource: OpenCodeLaunchSource,
  jsSource: OpenCodeLaunchSource,
  probe: LaunchProbe,
  detailFrom: string,
): OpenCodeLaunchSpec {
  if (/\.(?:js|mjs|cjs)$/i.test(targetPath)) {
    const node = probe.nodeExecutable();
    return {
      command: node,
      prefix_args: [targetPath],
      source: jsSource,
      detail: `JS 入口 ${targetPath}（node：${node}，来源：${detailFrom}）`,
    };
  }
  return {
    command: targetPath,
    prefix_args: [],
    source: exeSource,
    detail: `原生可执行文件 ${targetPath}（来源：${detailFrom}）`,
  };
}

/** 便于日志：把解析结果压成一行（不含敏感信息）。 */
export function describeLaunchResolution(resolution: OpenCodeLaunchResolution): string {
  if (resolution.kind === "resolved") {
    return `已解析 OpenCode 启动方式[${resolution.spec.source}]：${resolution.spec.detail}`;
  }
  const seen = resolution.searched.length > 0 ? resolution.searched.join(" | ") : "(无)";
  return `未解析出 OpenCode 启动方式；已搜索：${seen}`;
}
