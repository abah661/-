# B6-B：在途记录与 OpenCode 启动方式返修报告

- 日期：2026-09-24
- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6`
- B6 基线：`934db7b18d01dff5712b8919751e9ac23b5a223f`（= B5 顶端；未改写、未强推 B5）
- 实现提交：`35f95633c76e80466425c15dae9cfca1cc08ecdc`（8 文件，+1438/−75）
- 对应评审：`A-to-B-B5-review.md`（B6-1 / B6-2）

## 结论

评审单两项**均已落地**。其中 B6-2 存在一处**与 A 端指示形态不同**的地方：
A 端要求「解析出 `node.exe` 路径与 CLI 的 JS 入口文件路径，用 `node.exe` 启动」，
但实测本机 OpenCode **不存在 JS 入口**——它是原生可执行文件。
实现按 A 端的两条**硬约束**（保持 `shell: false`、绝不经 shell）落地为等价方案，
并在第二节给出逐条实测依据。**请 A 端确认该等价实现**，若要严格按「JS 入口」形态
落地，需要先由环境准备阶段提供一个真正的 JS 入口。

---

## 一、B6-1：在途记录不再被后续任务覆盖

### 1.1 先核实指控（不凭信任）

评审单说「`markInFlight(newRecord, "in_flight")` 会对同一路径再次写入，直接覆盖
上一条终态记录」。核对 B5 源码，**属实**：

- `apps/executor/src/daemon.ts` 的 `fileInFlightStore()` 把所有 attempt 写进
  **同一个** `.local/executor-in-flight.json`；
- `save_in_flight` 用 `writeFileSync(file, ...)` 整文件覆盖；
- 领取新任务时 `markInFlight(flightRecord, "in_flight")` 落到同一路径。

即：B5 只做到了「不删除」，没有做到「不被覆盖」——「终态记录可复查」在
连续处理两个以上 attempt 时并不成立。评审判定准确。

### 1.2 落点

| # | 要求 | 实现 |
| --- | --- | --- |
| 1 | 每 attempt 一份、互不覆盖 | `.local/executor-attempts/<attempt_id>.json`（`inFlightRecordPath`，`attempt_id` 经 `encodeURIComponent` 后作文件名，编码可逆） |
| 2 | 重启只加载 `in_flight` | `load_in_flight()` 先全量扫描目录，再 `filter(isActiveInFlightRecord)`；**只有 `in_flight` 算活动**（B4 旧记录缺 `state` 字段时按保守原则仍视为 `in_flight`——「不知道」不等于「已终结」） |
| 3 | 终态记录保持原样 | `markInFlight` 只写**自己那一份**文件，不可能触达别的 attempt |
| 4 | 指针可更新、记录不得覆盖 | **未引入「当前 attempt 指针」**。扫描目录即可得到活动记录，少一个可变状态就少一处可能撒谎的地方 |
| 5 | 不增加自动清理逻辑 | 存储层仍**没有任何删除路径**；`clearInFlightRecord(repo_root, attempt_id)` 是显式动作，且收窄为**单条**粒度（「清空整个目录」不在其能力范围内） |

新增导出（便于测试与人工排查）：`inFlightDir` / `inFlightRecordPath` /
`listInFlightRecords`（含终态）/ `isActiveInFlightRecord`。
原 `inFlightPath(repoRoot)` 已移除。

### 1.3 锁定测试

- `tests/executor/daemon.test.ts`
  - 「每 attempt 一份文件，结束只推进状态、不删除」——同时断言
    **终态记录不再被 `load_in_flight()` 返回**，但文件仍在；
  - 「连续两个 attempt 的记录都在，且只恢复 `in_flight` 的那一份」——
    两份文件路径都 `existsSync` 为真，第二个 attempt 的写入**没有**覆盖第一个；
  - 「磁盘上只有终态记录时，重启**不做**恢复查询」——断言 `report.recovery === null`
    且 `events` 中**从未出现** `query_ownership`。
- `tests/executor/real-chain.test.ts` §8：**真实链路**连跑两个 attempt
  （真 worktree / 真提交 / 真在途文件），逐个读回两份记录并断言各自 `state === "reported"`。

---

## 二、B6-2：OpenCode 启动方式

### 2.1 A 端裁定（严格遵守）

> 保持 `shell: false`，不采用 `cmd.exe /c`，也不拼接命令字符串。

**已严格遵守。** 实现中没有任何 shell 介入，参数一律以数组传递。

### 2.2 实测形态（关键差异）

A 端指示解析「`node.exe` 路径 + CLI 的 JS 入口文件路径」。实测本机
（`opencode-ai@1.18.31`，Node v22.22.2）——**不存在 JS 入口**：

| 检查项 | 实测结果 |
| --- | --- |
| PATH 上的 shim | `%APPDATA%\npm\opencode.cmd`、`opencode.ps1`、`opencode`（Unix 风格脚本） |
| `opencode.cmd` 内容 | `"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*` |
| `package.json` 的 `bin` | `{ "opencode": "./bin/opencode.exe" }` |
| `bin/opencode.exe` | **179 998 248 字节**，文件头 `MZ`（PE 原生可执行） |
| 包内 `.js/.mjs/.cjs` | 只有 `postinstall.mjs`（安装脚本，**不是** CLI 入口） |
| `spawn("opencode", ["--version"], { shell: false })` | `status=null, error=ENOENT` |
| `spawn("<绝对路径>/opencode.exe", ["--version"], { shell: false })` | **`status=0`，stdout `1.18.31`** |

结论：本机的正确启动串第一段是 **`.exe` 绝对路径**，不是 `node.exe`。
「用 `node.exe` 启动」这一形式在本机**没有可指的目标**。

### 2.3 实现：按形态分派（两条硬约束都满足）

新增 `apps/executor/src/adapters/opencode-launcher.ts`：

- **原生可执行文件** → `command = <绝对路径>`，`prefix_args = []`
- **JS 入口** → `command = <node.exe>`，`prefix_args = [<入口绝对路径>]`

即：A 端描述的「`node.exe` + 入口」形式**已被完整支持**，只要环境里存在 JS 入口；
本机走的是同一条路线的另一半。两者都是「绝对路径 + 参数数组 + `shell: false`」。

解析来源（**全部来自运行环境，不含任何写死的用户目录**）：

1. 显式配置的 `exe_path` / `js_entry` + `node_path`；
2. PATH 上直接存在的 `opencode.exe`（Windows）/ `opencode`（类 Unix）；
3. npm 全局包元数据 `<prefix>/node_modules/opencode-ai/package.json` 的 `bin`；
4. `.cmd` / `.ps1` shim 文本（展开 `%dp0%` / `%~dp0` / `$basedir`）作为兜底。

搜索目录来自 `PATH`、`npm_config_prefix`、`%APPDATA%\npm`（由环境变量推导），
以及可选的 `search_dirs`。**`C:\Users\...` 这类路径一次都没出现在代码里。**

### 2.4 配置如何「一路传到 `runOpenCodeTask`」

| 层 | 载体 |
| --- | --- |
| 环境变量 | `EXECUTOR_OPENCODE_EXE` / `EXECUTOR_OPENCODE_JS_ENTRY` / `EXECUTOR_OPENCODE_NODE` / `EXECUTOR_OPENCODE_SEARCH_DIRS`（**四项全可选**；全不给即自动解析） |
| 常驻入口 | `DaemonOptions.agent_launcher` → 注入 `AttemptDeps.agent_config = { launcher }` |
| 编排 | `core/attempt.ts` 把 `deps.agent_config` 作为 `runOpenCodeTask` 的 config 参数传入 |
| 适配器 | `runOpenCodeTask` 调 `resolveOpenCodeLaunch` 得到 `command` + `prefix_args`，再 `runner.start(command, [...prefix_args, ...cliArgs], cwd)` |

启动时日志打印一行 `[launch] …`（解析方式 + 依据；失败时列出搜索过的路径）。
`OpenCodeAdapterResult` 新增 `launch_source` / `launch_detail` 两个可观测字段；
`bare_name` 表示「没解析出目标、退回裸命令名」——那正是 Windows 上必然 ENOENT 的形态，
因此它是一个**显式降级信号**，不再埋在日志里。

### 2.5 一处由真实测试逼出的缺陷（已修 + 回归锁定）

最初的实现无条件自动探测，导致 `{ executable: <不存在的路径> }` 被**自动探测替换**
成本机真实的 `opencode.exe` 并**真的启动了它**——B5 §6 那条「起不来要快速失败」
的回归用例因此拿到 `exit_code = 1` 而不是 `null`。

现修正为明确的优先级：**显式 `launcher` > 显式 `executable` > 自动解析**。
「调用方点名了哪个文件就用哪个文件」是硬约束，新增用例
「显式 executable 不被自动探测覆盖」锁定。

### 2.6 锁定测试

- `tests/executor/opencode-launcher.test.ts`（新增，**16 例**）：用假 probe 把五种形态
  （显式 exe / 显式 js+node / npm bin→exe / npm bin→js / shim 文本）与两类失败
  （什么都没找到、shim 目标不存在）全部钉死；含 `%dp0%`、`$basedir` 展开。
- `tests/executor/real-chain.test.ts` §7（**4 例**）：
  1. 从本机环境解析出**绝对路径**目标（断言 `command !== "opencode"` 且 `isAbsolute`）；
  2. **真实 `spawn` 解析出的目标并运行 `--version`**，断言无 `spawn_error`、
     `exit_code === 0`、stdout 匹配版本号 —— 即 A 端要求的「不返回 ENOENT」；
  3. 适配器确实用解析结果作为 `command`，且提示词仍是最后一个位置参数；
  4. 显式 `executable` 不被自动探测覆盖。

> 口径说明：§7 验证的是**启动方式**。真实 OpenCode **模型调用未执行**，
> 也没有用版本检查冒充「真实模型任务成功」。

---

## 三、实际执行的校验与退出码

环境：Node v22.22.2（Windows）

| 命令 | 退出码 |
| --- | --- |
| `npm run typecheck` | `0` |
| `npm run validate:protocol` | `0`（5 个样例全 PASS） |
| `npm test` | `0` |
| `npm run check` | `0` |
| `git diff --check` | `0` |
| `git status --short` | `0`（提交后干净） |

**21 个测试文件：440 passed | 1 skipped | 0 failed（共 441）**

- 新增 `tests/executor/opencode-launcher.test.ts`：**16/16**
- `tests/executor/real-chain.test.ts`：**17/17**（含新增 §7 四例、§8 一例）
- `tests/executor/daemon.test.ts`：**44/44**
- 1 个 skip 是既有的平台门控；**未删除断言、未跳过失败用例、未降低标准**

## 四、未执行（不得写成成功）

- 未对真实 Worker 发起任何请求（仍无 Token / `PROJECT_ID`）
- 未做真实 OpenCode **模型调用**（仅做 `--version` 启动验证）
- 未做 P3 / P5、未做双机联调

## 五、仍等 A 端

1. `B-executor-token.p7m`（仅 `EXE-B-OPENCODE`）
2. `PROJECT_ID`
3. 独立目标业务仓库 `<TARGET_REPO_URL>`
4. 最小任务图
5. **2.2 节的形态差异确认**（原生 `opencode.exe` 的绝对路径启动是否接受为
   B6-2 的等价实现）
