# B → A：B6 完成回报（B5 评审返修）

## B 端阶段回报

- **阶段**：B6（B5 评审 B6-1 / B6-2 返修）
- **分支**：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6`
- **B6 基线**：`934db7b18d01dff5712b8919751e9ac23b5a223f`（= B5 顶端）
  — 未改写、未强推 B5；B5 远端仍是 `934db7b`
- **代码提交**：`7f44579a06a52098ac06cad356bfe5a38a4726f9`
  —— 本分支上**最后一次修改代码**的提交；其后各提交只追加文档
- **远端 SHA**：与本地 `git rev-parse HEAD` **逐字一致**
  —— `git ls-remote origin refs/heads/task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6`
  （本交接单自身也是提交，故此处不写死 SHA 以免自指矛盾）
- **`main` 未被改动**：远端仍为 `ae659a9f5bbf59c08c0c435b916a2eaa0a4ad25e`；
  未推送任何其他分支、未 force-push

### 本轮三个提交

| # | SHA | 内容 |
| --- | --- | --- |
| 1 | `35f95633c76e80466425c15dae9cfca1cc08ecdc` | B6-1 / B6-2 实现（8 文件，+1438/−75） |
| 2 | `f336f91d07f832d8b562f17273f3bfbe0bc32776` | 交付报告 `B6-B-executor-launch-and-records.md` |
| 3 | `7f44579a06a52098ac06cad356bfe5a38a4726f9` | **跨平台缺陷修复 + 回归用例 + 报告第六节** |
| 4 | `be9a74392f069814845c58ae7c41e3c0dff82aed` | B6 交接单（本文件） |

### 实际执行命令 / 退出码（Node v22.22.2，Windows 本机）

| 命令 | 退出码 |
| --- | --- |
| `npm run typecheck` | `0`（含 `--force` 全量重建，排除增量缓存掩盖） |
| `npm run validate:protocol` | `0`（5 个样例全 PASS） |
| `npm test` / `npm run check` | `0` |
| `git diff --check` | `0` |
| `git status --short` | `0`（提交后干净） |

### 测试数字

**21 个测试文件：441 passed | 1 skipped | 0 failed（共 442）**

- `tests/executor/opencode-launcher.test.ts`：**17/17**
- `tests/executor/real-chain.test.ts`：**17/17**
- `tests/executor/daemon.test.ts`：**44/44**
- 1 个 skip 是既有的平台门控；**未删除断言、未跳过失败用例、未降低标准**

---

## 一、B6-1：在途记录不再被后续任务覆盖（已在 `35f9563` 落地）

评审单指控属实（B 端核对过源码）：B5 的实现把所有 attempt 写进**同一个**
`.local/executor-in-flight.json`，领取新任务时整文件覆盖，
因此「终态记录可复查」在连续处理两个以上 attempt 时并不成立。

现在：`in_flight` 状态 → 每 attempt 一份
`.local/executor-attempts/<attempt_id>.json`（文件名经 `encodeURIComponent`，可逆）；
`load_in_flight()` 只返回仍为 `in_flight` 的记录；
**未新增任何自动清理逻辑**，`clearInFlightRecord` 收窄为单条粒度且只在显式动作里调用。

## 二、B6-2：OpenCode 启动方式（已在 `35f9563` 落地）

A 端裁定「保持 `shell: false`、不经 `cmd.exe /c`、不拼命令串」——**严格遵守**。

新增 `adapters/opencode-launcher.ts`：从 PATH / `npm_config_prefix` /
`%APPDATA%\npm`（由环境变量推导）/ npm 包元数据 `bin` / shim 文本解析真实目标，
以**绝对路径 + 参数数组 + `shell: false`** 启动。代码中不含任何写死的用户目录。

配置链路：`EXECUTOR_OPENCODE_EXE` / `..._JS_ENTRY` / `..._NODE` / `..._SEARCH_DIRS`
（四项全可选）→ `DaemonOptions.agent_launcher` → `AttemptDeps.agent_config` →
`runOpenCodeTask`。启动时打印一行 `[launch] …`；
`OpenCodeAdapterResult` 增 `launch_source` / `launch_detail` 两个可观测字段，
`bare_name` 是显式降级信号（不再埋在日志里）。

### 2.1 ⚠️ 需要 A 端确认：本机形态与指示不同（实测）

A 端指示解析「`node.exe` 路径 + CLI 的 **JS 入口**」。实测本机
（`opencode-ai@1.18.31`，Node v22.22.2）**不存在 JS 入口**：

| 检查项 | 实测结果 |
| --- | --- |
| `opencode.cmd` 内容 | `"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*` |
| `package.json` 的 `bin` | `{ "opencode": "./bin/opencode.exe" }` |
| `bin/opencode.exe` | **179 998 248 字节**，文件头 `MZ`（PE 原生可执行） |
| 包内 `.js/.mjs/.cjs` | 只有 `postinstall.mjs`（安装脚本，**不是** CLI 入口） |
| `spawn("opencode", …, { shell: false })` | `status=null, error=ENOENT` |
| `spawn("<绝对路径>/opencode.exe", …, { shell: false })` | **`status=0`，stdout `1.18.31`** |

因此实现**按形态分派**：原生 exe → 绝对路径直接启动；若环境里确有 JS 入口 →
`node.exe` + 入口启动。A 端描述的形式**已被完整支持**，只是本机走的是另一半。
两条路径都满足「绝对路径 + 参数数组 + `shell: false`」。
**请确认该等价实现可接受**；若要严格按「JS 入口」落地，需环境准备阶段先提供一个 JS 入口。

## 三、🔴 B 端引入的跨平台缺陷（CI 暴露，已修）

**必须如实上报：B6 的推送在 CI 上红过三次。**
其中两次（#17 / #18 的 `ubuntu-latest`）是 **B 端引入的真实缺陷**，
已修复并确认关闭（见 3.2）；另一次（#19 的 `windows-latest`）
**未能复现**（见 3.3）。两件事都不淡化。

### 3.1 CI 运行记录（逐条如实）

| 运行 | 提交 | `windows-latest` | `ubuntu-latest` |
| --- | --- | --- | --- |
| **#17** | `35f9563` | success（31 s） | **failure**（9 s） |
| **#18** | `f336f91` | success（29 s） | **failure**（11 s） |
| **#19** | `7f44579` | **failure**（182 s） | success（11 s） |
| **#20** | `be9a743` | success（28 s） | success（12 s） |

链接：#17 <https://github.com/abah661/-/actions/runs/36001118441>
· #19 <https://github.com/abah661/-/actions/runs/36004505007>
· #20 <https://github.com/abah661/-/actions/runs/36005310681>

### 3.2 #17 / #18 的 Ubuntu 失败：B 端引入的真实缺陷（已修）

根因：`extractTargetPath` 里 `.replace(/[\\/]+/g, "\\")` **无条件**把分隔符
统一成反斜杠。Windows 上 `join` 本就产反斜杠，看不出问题；Linux 上是 POSIX 语义，
于是拼出 `D:\npm-global\node_modules\...` —— 既非合法 POSIX 路径、
也不等于 `join` 的结果，`isFile()` 判定随之失败。

**B 端本地是 Windows，本地全绿无法发现它。** 修法：分隔符一律交给 `path.join`，
不再自己拼。`7f44579` 即该修复，并新增一条跨平台回归用例。
#19 的 Ubuntu **转为 success**，该缺陷确认关闭。

### 3.3 ⚠️ #19 的 Windows 失败：**未能复现**（提请 A 端知悉）

`check (windows-latest)` 在 `7f44579` 上失败，`Run project checks` 耗时
**182 s**；而同一作业在 #17 / #18 都是 success 且只用 29–31 s。

B 端已做的排除（均为实测，非推测）：

1. **本地全量**（本机装有 opencode）：`441 passed | 1 skipped | 0 failed`，25 s。
2. **本地模拟 CI 环境**：把 npm 全局目录移出 `PATH`、`APPDATA` 指向空目录，
   实测 `spawn("opencode")` 返回 `ENOENT`（与 CI 一致）后重跑：
   仍然 `441 passed | 1 skipped | 0 failed`，23 s。
3. 本次相对 #18 的改动只有两处：一个**纯逻辑**用例（假 probe，微秒级）
   与一处路径拼接实现；而在 CI 上（无 opencode）解析结果为 `not_found`，
   **根本不会进入被改动的分支**。

**对照结果**：#20 用的是**同一套代码**（`be9a743` 只在 `7f44579` 之上追加了
本交接单文件），`windows-latest` **success，且 `Run project checks` 只用 28 s**
（#19 为 182 s）。**#19 的失败因此未能复现。**

B 端据此**不把它记作代码缺陷**（不存在可复现路径），但也**不草草写成「偶发」**：
GitHub 对公开仓库的 job 日志端点需认证（B 端实测 HTTP 403）、`gh` CLI 不可用，
B 端自始至终**拿不到那 182 s 里的失败详情**。
若 A 端认为需要，可打开该作业日志给出失败用例名，B 端据此继续排查。

<https://github.com/abah661/-/actions/runs/36004505007/job/107649076274>

### 3.4 修复内容（`7f44579`）

`extractTargetPath` 改为：剥掉 `%dp0%` / `%~dp0` / `$basedir` 前缀得到相对路径，
shim 文本里的反斜杠先归一并交给平台 `join`；shim 内写死绝对路径时
（Windows 与 POSIX 两种都要认）不再前置 shim 目录。

验证三重：① 对照脚本证明修复前后两种语义下的差异；
② 本地把 `node:path` 换成 `path.posix` 模拟 Linux 后，
`opencode-launcher.test.ts` 在 **win32 与 posix 下均 17/17**；
③ 原生 Windows 全量 441 通过。

## 四、真实链路额外逼出的缺陷（B5 轮次，此处仅备案）

1. `runProcess` 无条件空等满超时（`collectEvidence` 实测 10 分钟 → 367 ms）
2. 假 agent 只注入 `runAttempt`、未注入常驻入口
3. `spawn` 失败时句柄永不结束 → 执行器永久死等
4. （B6 轮次）自动探测会**覆盖**显式 `executable` —— 已固定优先级
   「显式 `launcher` > 显式 `executable` > 自动解析」并加回归

## 五、未执行（不得写成成功）

- 未对真实 Worker 发起任何请求（仍无 Token / `PROJECT_ID`）
- 未做真实 OpenCode **模型调用**（§7 只做 `--version` 启动验证，
  未用版本检查冒充真实模型任务成功）
- 未做 P3 / P5、未做双机联调

## 六、仍等 A 端

1. `B-executor-token.p7m`（仅 `EXE-B-OPENCODE`）
2. `PROJECT_ID`
3. 独立目标业务仓库 `<TARGET_REPO_URL>`
4. 最小任务图
5. 第 2.1 节的形态差异确认（原生 `opencode.exe` 绝对路径启动是否接受为等价实现）

## 七、其他观察

CI 输出中有一条与本仓库无关的提示：`ubuntu-latest` 标签将于 2026-10-19
起迁移到 Ubuntu 26（GitHub 官方公告）。届时不需改代码，但
`.github/workflows/**` 属 A 端专属，提请 A 端知悉。
