# 给第二台电脑的交接单：B7 修复与双机联调准备

版本：2026-09-26 发布验证补充版（基于 2026-09-25 A 端审计）。本版取代 2026-09-22 的 B4 接入单。
用途：交给第二台 Windows 电脑上的 agent；用户无需手工写代码或传登录密码。

## 用户现在要做什么

把本文件发给 B 电脑的 agent，并说：

> 按这份最新交接单继续 B7。先检查现有仓库与未提交内容，不要重新从 B4 搭建。
> 在 B 的范围修复、测试并按既有授权推送 B7 任务分支。缺失信息一次列出。
> 已批准范围不要重复询问；需要本人登录时告诉我具体页面。
> 不要索取密码、明文 Token、PFX、私钥或整个登录文件。

B 完成后，回传阶段报告和仅含公钥的 `B-token-public.cer`。
B7 的修复、本地测试不依赖目标业务仓库或 Token，先完成这些工作。

## 1. 已核实的事实与基线

| 项目 | 值 / 状态 |
| --- | --- |
| 协调系统远端 | https://github.com/abah661/-.git |
| A 任务分支 | `task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` |
| A 本轮审计起点 | `c2f5f0247c0f5dc1bdadf77d8177e2281cb22727`，当时尚未推送；不是本轮修复后的 SHA |
| A 已推送修复代码 | `e7304ad982efbb6ad23d54407139084ba15d7ebc`；后续可能有纯文档提交 |
| A 修复代码 CI | [36119639710](https://github.com/abah661/-/actions/runs/36119639710)，Windows/Ubuntu success，2026-09-26 已回查 |
| B6 远端分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6` |
| B7 必须包含的 B6 基线 | `aa2837408cb98f10b0d619d223c9094b096a1fcd` |
| B7 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7` |
| B6 双平台 CI 历史证据 | run `36005891915`；不能冒充 B7 CI |
| Worker | https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev |
| 测试 Worker 已部署版本 | `ec2d6195-93d2-44a6-a6c4-b584d7679656`，包含 A 本轮接口修复 |
| 部署后接口烟测 | `AUDIT-20260926001014`，21 项 HTTP 检查通过；仅 API 夹具，不是真双机 |
| B 身份 | `EXE-B-OPENCODE` |
| 协议 | v1 已冻结；不修改 `packages/protocol/**` |
| B7 远端状态 | A 在 2026-09-25 本轮检查时尚未发现该分支；执行前再次核实 |
| 独立目标仓库 | A 本地夹具已建，远端 URL 尚未确定 |
| 双机验收 | P3/P5 尚未完成 |

B4 常驻入口与 B5/B6 修复已经存在。不要照旧说明重新实现常驻入口。
A 接受 B6 的分 attempt 留档、绝对路径原生 `opencode.exe` 无 shell 启动。
B6 尚未整合：进程终止和检查失败时错误放行等问题仍需修复。

A 本轮已修复协调器、Codex 适配器和整合检查，并完成上表中的发布验证。
**本地已修复、远端已推送、测试 Worker 已部署是三个不同状态。**
先从 A 的最新审计报告确认代码 SHA、CI 和 Worker 版本；未来若有新版本仍需重新核对。
B7 可以先基于 B6 修复自身代码，A 会在独立验收后进行受控组合。

## 2. 文件归属和授权

B 可修改 `apps/executor/**`、`tests/executor/**`，并在
`docs/handoff/**`、`docs/reports/**` 写证据。
B 任务分支的修复和推送已有用户授权；按照授权表核对具体范围。

A 负责 `apps/coordinator/**`、`packages/codex-adapter/**`、
`packages/integration/**`、管理 CLI、冻结协议及 CI。
不要覆盖 A 代码、改冻结协议、修改 CI、操作 Cloudflare、迁移数据库、推送 main。
自动合并、生产部署、全局安装、自启、删除及历史重写不在本次范围内。

先读适用父级及仓库 `AGENTS.md`。现有文件和未提交工作必须保留。
源码不能携带凭据，验证日志也不能含凭据。

## 3. 继续现有仓库，不从头开始

先执行只读检查，记录退出码：

```powershell
git status --short
git branch --show-current
git log -5 --oneline
git remote -v
node --version
npm --version
git --version
opencode --version
```

使用 Node 22.x。B6 报告的 OpenCode 为 1.18.31；实际版本以本机输出为准。
不要为了更新版本主动安装全局依赖。模型登录只由 B 用户在 B 电脑完成。

获取 B6 分支，在**新的隔离 worktree**创建 B7；以下在已有协调系统仓库执行：

```powershell
git fetch origin task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6
git cat-file -t aa2837408cb98f10b0d619d223c9094b096a1fcd
git worktree add ../dual-agent-b7 -b task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7 aa2837408cb98f10b0d619d223c9094b096a1fcd
```

若 B7 分支或目录已存在，先查看其状态并继续已有工作，不能删除、reset 或强行覆盖。
若 B6 远端前进了，先报告差异；保留新提交，不盲目退回旧点。
切入新 worktree 后，读取规则并执行 `npm ci`、`npm run check`。
已有有效依赖时不必反复安装。

## 4. B7 必修问题和验收要求

### B7-1：进程终止必须有等待上限

B6 的 `core/process.ts` 在强杀失败后仍无界等待 stdout/stderr。
`SystemTreeKiller.killTree()` 对 taskkill 的等待也无上限。

修复必须覆盖进程、两个输出流、终止工具自身。最终宽限结束仍未退出时，
返回失败，保留 `kill_failed`，停止当前执行器接新任务并要求处理残留进程。
不得因无法终止而继续提交、推送或报告成功。

测试：永不退出、流永不关闭、killer 抛错/失败/卡住、继承管道的子进程；
断言有限时间内返回和无提交/推送副作用。另跑真实 Windows 进程树测试。

### B7-2：Git 检查失败必须拒绝，而不是合规

A 对精确 B6 源码的实际复现：不存在的仓库调用 `checkDiffScope()`，返回
`{"changed_files":[],"violations":[],"ok":true,"has_uncommitted":false}`。

必须检查所有 diff、status、ls-files、staged 检查的退出码。无效 SHA、仓库不存在、
Git 不可用、权限错误和部分检查失败都必须阻止提交/推送。
检查输出使用 NUL 分隔的路径（`-z`），避免中文引号转义、空格和换行文件名误判。
重命名必须核对旧路径和新路径，不能漏掉禁止目录中的删除。

测试至少覆盖：无效仓库/基线、单条 Git 命令失败、中文和空格路径、重命名跨范围。
提交前再次核对真正暂存的 diff；通过测试的提交与最终推送 SHA 必须一致。

### B7-3：敏感文件及环境变量边界

A 对 B6 的实际复现：
`findSensitiveTouches([".env",".ENV","B-token-public.cer",".codex/config.toml"])`
只命中 `.env`。

Windows 上按大小写不敏感检查敏感路径，覆盖 `.env*`、auth/credentials、
`.codex/**`、私钥以及 `.cer/.pem/.key/.pfx/.p12/.p7m` 等本项目禁止提交的文件。
公钥虽然不是密码，仍不应进入代码仓库。

子进程环境须移除协调器管理/执行器 Token、Cloudflare 部署和 GitHub 写入凭据。
HTTP 传输在父进程使用 Token；不能让目标仓库测试或模型生成的代码继承它。
模型自身必需的登录按本机配置处理，不向对方导出。

增加回归测试证明禁止文件不会被提交、进程和日志不包含测试用凭据。
不要用真实 Token 当测试夹具。

### B7-4：执行器身份必须对应实际适配器

B6 的 CLI 允许声明 codex/mock，但 `runAttempt()` 实际调用 OpenCode。
在未实现相应适配器路由前，B 的启动入口只能接受 opencode；
遇到 codex/mock 配置应明确拒绝，不能登记一种身份却执行另一种工具。
A 的 Codex 常驻接入由 A 负责，不能由 B 擅自改 A 适配器。

### B7-5：与 A 修复后的接口对齐

A 本轮收紧的行为（以已部署版本为准）：

- 执行器 Token 不能提交任务图、创建整合批次或向 GitHub 事件入口写数据，返回 403。
- 同一执行器最多一个活动租约；冲突范围的任务不会并行分配。
- 新一次轮询使用新幂等键；同一次网络重试复用原键。
- 过期领取/续约/心跳的旧键不能恢复所有权，返回 409。
- 注册时间变化允许重启注册；活动租约期间不允许改变执行器配置。
- 成功报告必须有真实通过用例，证据 ID 一致，commit_shas 包含 head_sha，
  agent_kind 匹配租约，声明的 changed_files 在范围内。
- 登录/配额/授权错误按错误码阻塞；fatal 不当作代码返修。
  retryable 当前保守进入 needs_input，自动重派/退避尚未实现。

401 是认证失效；403 可能是权限或身份问题，不能全部解释成“重新登录”。
409 也需读取结构化错误码；不能无限重试、重注册或忽略错误继续推送。
最终以服务端接受的状态为准，保留原始非敏感错误码。

### B7-6：测试命令配置必须真正可运行

B6 的 `loadDaemonOptions()` 只判断 `EXECUTOR_TEST_COMMAND` 是否非空，
无论内容是什么都改成 `npm run check`；不设置时又不提供测试命令。
这会让本次只有 `npm test` 的目标仓库无法通过真实测试。
在本地受信任配置中明确测试程序和参数数组；Windows 上 npm 包装器也应使用
Node + npm-cli.js 的绝对路径或其他可靠原生入口，不为方便开启 shell。
缺少受信任测试命令时启动即拒绝，不先消耗模型额度。
测试覆盖 `npm test`、配置缺失、未知命令和中文路径。

## 5. B 的交付门槛

实际执行并记录输出摘要：

```powershell
npm run check
git diff --check
git status --short
git rev-parse HEAD
```

本地全绿后，按已有授权只推送 B7 分支，再核对 `git ls-remote` 的完整 SHA
与 GitHub Actions 的 Windows/Ubuntu job。网络失败就标记推送未完成。
重试有明确上限，失败不得通过删断言或跳过测试掩盖。

另提交 `docs/reports/P2-B7-executor-fixes.md`，逐项对应 B7-1 至 B7-6：
复现、修改文件、测试命令、退出码、用例数量、未验证项。
A 需要代码和证据，两者缺一不可。

## 6. Token 安全交接：先检查已有证书

旧流程已让 B 生成公钥。先查是否存在且未过期；**不要每次重新生成**。
证书的 Subject、指纹和有效期需由 B 确认，并与 A 收到的文件核对。
旧证书设置了 7 天有效期，过期后不能继续用于新交接。

仅缺少有效证书时，按既有测试凭据授权在 B 当前用户证书库创建不可导出的私钥：

```powershell
$handoffCert = New-SelfSignedCertificate -Subject 'CN=DualAgent-B-Token-Handoff' -Type DocumentEncryptionCert -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(7)
Export-Certificate -Cert $handoffCert -FilePath "$env:USERPROFILE\Desktop\B-token-public.cer"
```

不要覆盖已有同名文件；已有文件先验证或选择新文件名。
只转交 `.cer` 和证书指纹，不导出 PFX、私钥或密码。

A 收到公钥后，在内存中读取已批准的 B 测试 Token，用公钥生成
`B-executor-token.p7m`。B 在自己的 Windows 用户下解密到内存，再用 DPAPI 保存。
A 的 DPAPI XML 不能直接给 B 解密。

不得打印 Token，不落明文临时文件、不写 .env、不写入持久环境变量。
启动时仅注入受控父进程；依 B7-3 过滤子进程继承。
密文、公钥和加密副本均不进 Git，不自动删除。

## 7. 真双机联调的启动条件

当前缺失信息一次列出，不反复问用户：

1. B7 通过本地测试、双平台 CI 和 A 独立验收的完整 SHA；
2. A 修复提交的远端 SHA、测试 Worker 实际部署版本；
3. 独立业务目标仓库远端 URL，以及双方可访问的基线：
   `a9434a87f6f2513e7c32185a8f9a6e365162e253`；
4. B 公钥、密文接收与本机解密状态；
5. A 提供的 PROJECT_ID 和实际提交的任务图；
6. B 本机模型标识、登录和配额状态；A 的 Codex 执行循环接入状态。

目标仓库是小型 user-profile 示例，不能把协调系统当作目标仓库。
A 端 `P3-demo-task-graph.json` 目前只是候选图，未提交到 Cloudflare。
目标基线只提供 `npm test`，没有 `npm run check`；
B 的测试命令配置应准确映射到目标仓库受信任的验收命令。
不要把任意云端字符串当成 shell 命令。

基本配置（非敏感）：

```text
COORDINATOR_BASE_URL=https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev
EXECUTOR_ID=EXE-B-OPENCODE
COORDINATOR_AGENT_KIND=opencode
PROJECT_ID=<A 提供的已创建项目>
EXECUTOR_REPO_ROOT=<B 本地独立目标仓库>
OPENCODE_MODEL=<B 本机实际模型标识>
```

目标仓库的推送范围另按准确仓库与任务分支核对，不能把协调系统推送授权扩展过去。
不要在新条件未满足时重建 Worker、数据库或强行领取示例任务。

## 8. 联调完成的证据

P3：两台真实电脑分别启动、领取、真实模型调用、提交、验证、结果回报；
记录 task_id、attempt_id、epoch、绑定 SHA、实际 head、命令退出码和时间线。

P5：实际出现并行重叠；注入组合接口错误；独立验收拒绝；返修后重新验收。
还须验证断网、过期租约、旧 epoch、认证过期、强杀失败。
当前 A 的独立 CI 来源回查、批次终结与自动返修派发仍未接完，
本地 JSON 的通过文案不能作为 P5 证据。

## 9. 回传模板

- 阶段与本版交接单日期：
- B7 分支、基线、HEAD 完整 SHA：
- B7-1 至 B7-6：逐项修复与测试结果：
- 本地 Node/OpenCode 版本：
- 实际命令、退出码、通过/失败/跳过数量：
- 推送结果及远端 SHA：
- CI run URL 与两个平台结果：
- 公钥文件名、证书指纹与有效期（无私钥）：
- 尚未完成、阻塞与下一步：
- 真实双机/真实模型调用是否执行：

未执行写“未执行”；网络不通写“网络阻塞”；仅假进程测试通过写“单元测试通过”。
