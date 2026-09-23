# B5 交付报告：B4 评审返修（4×P0 + 2×P1）与真实链路测试

- **日期**：2026-09-23
- **分支**：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B5`
- **B5 基线**：`4804d2bbbe5720527666096372e1b2c0f3e361ee`（= B4 顶端，未改写、未强推 B4）
- **本报告对应的实现提交**：`92e47e4f52e5c4c9a1faa0b23a4d92857f7f26bb`
- **范围**：只改 `apps/executor/**`、`tests/executor/**`。未触碰
  `apps/coordinator/**`、`packages/protocol/**`、`.github/workflows/**`。

---

## 一、结论摘要

| 评审条目 | 状态 | 落点 |
| --- | --- | --- |
| P0-1 推送前删除 worktree | ✅ 已修 | `daemon.ts` 固定 `cleanup_worktree: false`；清理点唯一且在最末端 |
| P0-2 执行器不创建提交 | ✅ 已修 | 新增 `core/commit.ts`；`core/attempt.ts` 四道门后提交 |
| P0-3 只看退出码，不核对远端 | ✅ 已修 | `daemon.ts` `gitPushBranch` push 后 `ls-remote` 逐字核对 |
| P0-4 未推送仍报可整合 | ✅ 已修 | `daemon.ts` P0-4 分支，降级 `blocked_approval` / `UNAUTHORIZED_OPERATION` |
| P1-1 `still_mine` 后继续领取 | ✅ 已修 | `daemon.ts` 安全停止 `halt_still_mine`，不领取/不推送/不上报/不删记录 |
| P1-2 自动删除在途记录 | ✅ 已修 | `save_in_flight` 不再接受 `null`，存储层已无删除路径 |

评审单「B5 必须增加的 6 组真实测试」全部落地（见第三节）。此外，
**真实链路测试额外逼出 3 个 B 端缺陷 + 1 个 P3 阻塞事实**（第四节），
其中两个会让执行器在真实环境下**永久挂死**。

---

## 二、返修逐条对照

### P0-1：worktree 必须活到「提交 → 推送 → 远端核对 → 上报」之后

- `daemon.ts` 构造 `AttemptInput` 时**固定** `cleanup_worktree: false`
  （注释里写明这是评审单要求，且不再由 `options.cleanup_worktree ?? true` 决定）。
- `core/attempt.ts` 的 `finally` 只在 `input.cleanup_worktree === true` 时才清理，
  且推送到 `trace.lease_lost` 时不清理。
- 清理点收敛为 `daemon.ts` 的 `finalizeWorktree()`，位置固定在链路**最末端**
  （上报之后），且**默认不清理**（`options.cleanup_worktree !== true` 直接 return）。

证据：`real-chain.test.ts` §1 用真实 worktree 断言
`worktreeExistedAtPush[0] === true`（推送**当时**目录存在），
并在默认配置下断言运行结束后目录与 `git worktree list` 登记都还在。

### P0-2：由执行器创建提交，且只能在校验全绿后

新增 `apps/executor/src/core/commit.ts`：

- `stageAllChanges`（`git add -A`，参数数组）
- `listStagedFiles`（`git diff --cached --name-only`）
- `createTaskCommit`（`git commit -m <subject> -m <body>`）
- `readHeadSha`（`git rev-parse HEAD`）
- `buildCommitMessage`：标题 `<TASK_ID>: <简述>`（上限 200 字符），
  正文记录 `attempt` 与四项冻结版本

`core/attempt.ts` 的四道门（缺一不提交）：写入范围合规 → 无敏感文件 →
测试证据全绿（`exit_code === 0 && failed === 0`）→ 租约仍有效；
另加两项空产物保护（`diff.changed_files` 为空、暂存内容为空 → 不造空提交）。
**提交前对「暂存内容」再查一次**范围与敏感文件（`listStagedFiles`），
覆盖「两次查询之间文件又被改动」的窗口。

`head_sha` / `commit_shas` **只来自** `git rev-parse HEAD`（`readHeadSha`），
无任何假体预填路径；`head_sha === base_sha` 时 `commit_shas` 为空数组。

未通过时把原因写入 `trace.commit_skipped_reason`（可定位是哪一道门），
并交由归一化层如实降级。

证据：`real-chain.test.ts` §2 三个用例分别断言**没有创建提交**
（worktree HEAD 仍停在 `base_sha`、`local_commits` 为空）。

### P0-3：推送后必须核对远端 SHA

`daemon.ts` 的 `gitPushBranch` 现在的顺序是：

1. `git push <remote> refs/heads/<branch>:refs/heads/<branch>`
2. 读本地 `HEAD`
3. `git ls-remote <remote> refs/heads/<branch>`
4. **仅当两者逐字一致**才 `pushed: true`

其余情况一律 `pushed: false / PUSH_REJECTED`，并把
`local_sha` / `remote_sha` / 原因一并返回。`readRemoteBranchSha` 按 `/\s+/`
切分（`ls-remote` 是制表符分隔，按单空格切会让比较永远失败），
远端无该分支返回 `sha: null, error: null`（正常情况，非错误）。

证据：`real-chain.test.ts` §3 —— 构造「push 成功但远端不是这个提交」
（fetch 与 push 指向不同 bare 仓库），断言 `remote_sha === oldSha`、
`pushed === false`、`error_code === "PUSH_REJECTED"`，
并用**独立路径**（直接读 bare 仓库 ref）二次证实。

### P0-4：未推送不得声称可整合

`daemon.ts` 中 `ready_for_integration` 的处理改为：

- `wouldPush === false`（未开 `enable_push` 或无 `git_push` 能力）→
  `blocked_approval` / `UNAUTHORIZED_OPERATION`，note 写明「远端不存在对应提交」；
- 推送失败或核对不一致 → `failed` / `PUSH_REJECTED`，note 带原因。

即 `ready_for_integration` 现在以「远端存在且 SHA 核对一致」为**前提**。

证据：`real-chain.test.ts` §4（`enable_push=false` → `blocked_approval` /
`UNAUTHORIZED_OPERATION`，且远端确无该分支）、§3 第三例（核对不一致 → `failed`）。

### P1-1：`still_mine` 安全停止

恢复流程改为：服务端确认旧租约**仍归本机**（`resume`）时，
`markInFlight("halted_still_mine")` 后**立即返回**，
`stop_reason = "halt_still_mine"`；不领取、不推送、不上报、不删除记录。
只有 `abandon_expired` / `abandon_reassigned` / `abandon_unknown`
（服务端已确认不再归我）才继续进入领取循环。

证据：`daemon.test.ts` §8 断言查完归属之后 `events` 不再出现 `acquire`、
不出现 `push` / `report`、`report.attempts` 为空、记录被推进为
`halted_still_mine` 且 `state_updated_at` 为字符串。

### P1-2：在途记录不再自动删除

`fileInFlightStore.save_in_flight` 的签名从 `(record | null)` 收窄为
`(record: InFlightRecord)`——**类型层面就没有删除入口**。
结束一次 attempt 只能推进 `state`
（`in_flight` / `reported` / `failed_to_report` / `skipped_*` / `halted_still_mine` /
`abandoned_*` / `failed_orchestration`），文件始终保留。
需要清理时走显式动作 `clearInFlightRecord(repoRoot)`，它**不在**常驻入口的自动路径里。

证据：`daemon.test.ts` P1-2 用例断言「推进状态后文件仍存在」，
并单独断言显式清理才会移除文件。

---

## 三、评审单要求的 6 组真实测试

新增 `tests/executor/real-chain.test.ts`（12 例）：真实临时 Git 仓库 +
真实 worktree + 本地 bare remote。**唯一被替换的是 OpenCode 进程本身**
（不烧模型配额）；Git、worktree、暂存、提交、推送、`ls-remote`、
证据收集全部是真的。

| 评审要求 | 用例 | 关键断言 |
| --- | --- | --- |
| 1 真实链路「未提交改动 → 检查 → 提交 → 推送」 | §1（2 例） | 推送**当时** worktree 存在；本地 HEAD ≠ base_sha；远端 SHA = 本地 HEAD（并被独立路径二次证实）；提交消息与正文格式正确；报告过 `ResultReportSchema` |
| 2 远端不一致 / `ls-remote` 失败 → 不得可整合 | §3（3 例） | `PUSH_REJECTED`；常驻入口上报 `failed`；远端确实没有该提交 |
| 3 `enable_push=false` → 不得可整合 | §4 | 本地有真实提交、远端没有 → `blocked_approval` / `UNAUTHORIZED_OPERATION` |
| 4 `still_mine` 不进入领取循环并保留记录 | `daemon.test.ts` §8 | 见 P1-1 证据 |
| 5 默认不删除 worktree 与在途记录 | §5、§1 | 目录仍在、`git worktree list` 仍有登记、记录 `state === "reported"` |
| 6 真实链路不得绕过 diff / 敏感文件 / 租约 / 证据检查 | §2（3 例） | 越界 → `DIFF_OUT_OF_SCOPE`；`.env` → `SENSITIVE_FILE_DETECTED`；无证据 → `TESTS_FAILED`；三者**都不创建提交** |

---

## 四、真实链路逼出的缺陷（评审单未列）

| # | 缺陷 | 现象（实测） | 修复 |
| --- | --- | --- | --- |
| 1 | `core/process.ts` `runProcess` **无条件**空等满超时 | `collectEvidence` 每跑一次测试证据就白等 `test_timeout_ms`（默认 600 s）。实测 10 分钟 → 修复后 **367 ms** | 改为「退出 / 超时谁先到听谁的」，并清理悬挂定时器 |
| 2 | 假 agent **只注入到 `runAttempt`，没注入常驻入口** | 真实链路测试里 5 个走 `runDaemon` 的用例其实在真实 `spawn opencode` | `DaemonDeps` 增 `agent_runner` 并透传给 `AttemptDeps` |
| 3 | `spawn` 失败时子进程句柄**永不结束** | `error` 事件无监听者 → 升级为**进程级未捕获异常**；`exit_code` 永不兑现、`for await` 永不结束 → 执行器**永久死等**（实测 120 s 仍未返回） | `adapters/opencode.ts` 与 `core/process.ts` 增启动失败通道：立刻挂 `error` 监听，`exit_code` 按「未取得」返回（**不伪造 0**），并把失败文本并入 `stderr`；`process.ts` 另增 `spawn_failed` 字段 |

第 1、3 两条都**只能用真实链路测出来**：假实现里 `sleep`/`exit_code` 都是注入的，
等待时长与「句柄会不会结束」都不影响断言。这印证了评审单的判断——
「仅增加 mock 顺序断言不够」。

### 4.1 新增的 P3 阻塞事实：`opencode` 在 Windows 上以裸名 `spawn` 不到

实测（本机，Node 22.22.2）：

- `Get-Command opencode -All` → `opencode.cmd` / `opencode.ps1` / `opencode`
  位于 `C:\Users\lenovo\AppData\Roaming\npm\`（npm 全局安装的 shim）
- `spawnSync("opencode", ["--version"], { shell: false })` →
  `status = null, error = ENOENT`

即 **OpenCode 确已安装**，但 npm 在 Windows 上装的是 `.cmd`/`.ps1` shim，
而 Node 的 `spawn(..., { shell: false })` 只按 `PATHEXT` 之外的方式查找可执行文件，
**不会**解析 `.cmd`。当前适配器默认 `executable: "opencode"` +
`shell: false` 的组合，在真实链路上**必然 ENOENT**——与 B4 报告里
「OpenCode 已安装 1.18.31」并不矛盾，但意味着「已安装」不等于「能被执行器拉起」。

`real-chain.test.ts` §6 用这个真实形状取证：
`runOpenCodeTask` 对不可解析的可执行文件**立即**返回失败
（`exit_code: null`、`status: "failed"`、`error_code: "INTERNAL_ERROR"`、
`timed_out: false`，实测耗时远小于超时），常驻入口则如实降级上报
（`repair_pending` / `INTERNAL_ERROR`、不推送、不声称可整合）。

**修复方向待 A 端裁决**（B5 未擅自改动 `executable` 语义，因为 `shell: false`
是本项目明确的安全红线，改它属于契约变更）：

1. 由配置传入**真实可执行文件路径**（例如 `.cmd` 的实际入口或其内部的
   `node <cli.js>` 形式），保持 `shell: false`；
2. 或在适配器内显式解析 Windows `.cmd` shim 后再以 `cmd.exe /c` 启动——
   **这会引入 shell 语义**，需要 A 端确认是否可接受；
3. 或在环境准备阶段安装/暴露一个真正的 `.exe` 入口。

---

## 五、验证证据（实际执行，非声明）

环境：本机 Node **v22.22.2**（项目锁定 Node 22）、npm 10.9.7、
git 2.55.0.windows.3、Windows。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | 无错误 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` + 5 个样例全 PASS |
| `npm test` | `0` | **20 个文件：417 passed \| 1 skipped \| 0 failed（共 418）** |
| `npm run check` | `0` | typecheck → validate:protocol → test 全通过 |
| `git diff --check` | `0` | 无空白错误 |
| `git status --short` | `0` | 提交后工作区干净 |

- `tests/executor/real-chain.test.ts`：**12/12 通过**（81.7 s）
- `tests/executor/daemon.test.ts`：**42/42 通过**
- 1 个 skip 是既有的平台门控，**未删除任何断言、未跳过失败用例、未降低验收标准**。

**未执行**（不得写成成功）：未对真实 Worker 发起任何请求（无 Token）；
未做真实 OpenCode 模型调用；未做 P3 / P5；未做双机联调。
A 端在 Node 24 下 `windows-integration.test.ts` 的 2 个超时用例，
B 端全程使用 Node 22，该文件 **22 例通过 / 1 skip**，未复现超时。

---

## 六、遗留与待 A 端

1. 第一节 4.1 的 `opencode` 启动方式需要 A 端裁决（P3 前置）。
2. 仍需 A 端提供：`B-executor-token.p7m`、`PROJECT_ID`、
   `<TARGET_REPO_URL>`、最小任务图。
3. 上一轮 B4 报告提出的 5 处 HTTP 契约理解，A 端已核实通过，B5 未改动。
