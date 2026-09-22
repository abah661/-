# 第二台电脑（B 端）接入与双机联调交接单

日期：2026-09-22  
适用对象：第二台 Windows 电脑上的 Codex / OpenCode agent  
用途：完成 B 端常驻执行器入口、安全接入测试 Worker，并与 A 端进行真实双机联调。

> 本文件不包含任何 Token、密码、登录文件或私钥。不要要求用户把登录密码发到聊天中，
> 不要把任何凭据写进 Git、Markdown、日志、截图或命令行参数。

## 用户只需要做三件事

1. 把本文件交给第二台电脑上的 agent。
2. 对它说：

   > 按这份交接单执行。能自动完成的直接完成；只有安装全局软件、登录账号或移动加密凭据文件时再告诉我点哪里。不要向我要密码或 Token。

3. 当 agent 生成 `B-token-public.cer` 时，把这个**公钥文件**带回 A 电脑。它不是密码，可以安全转交。A 电脑随后会生成一个只有 B 电脑能解开的 `.p7m` 文件，再把该文件带回 B 电脑。

其余操作由两台电脑上的 agent 完成。用户不需要手工输入代码命令。

---

## 给第二台电脑 agent 的强制任务

你是本项目的 B 端执行者。先完整读取仓库根目录 `AGENTS.md`，再执行本交接单。
本文件是任务交接，不替代 `AGENTS.md`；两者冲突时执行更严格的限制。

### 1. 已确认的项目事实

| 项目 | 固定值 |
| --- | --- |
| 协调系统仓库 | `https://github.com/abah661/-.git` |
| 当前权威分支 | `task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` |
| B4 起始基线 | `d493bd263febefcc4faca21da617520ce03fefa8` |
| B4 工作分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4` |
| 测试 Worker | `https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev` |
| B 执行器身份 | `EXE-B-OPENCODE` |
| 协议版本 | `1`，已冻结 |
| 最近双平台 CI | `35701997194`，Windows 与 Ubuntu 均为 `success` |
| Worker 版本 | `f318a0e7-72fc-45c4-a2db-7cbcb143da20` |

测试 Worker 已通过 A 端真实云端闭环。B 端模块、Windows 测试和 HTTP 传输层已经存在，
但 `apps/executor/src/index.ts` 当前只是导出模块，**还不是可常驻运行的执行器**。
在领取、执行、续租、上报循环真正接通前，不得声称 B 执行器已上线。

### 2. 权限与修改边界

本任务允许：

- 只读检查整仓库；
- 修改 `apps/executor/**`；
- 修改或新增 `tests/executor/**`；
- 在 `docs/handoff/**`、`docs/reports/**` 中记录 B4 的真实证据；
- 创建并推送 `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4`。

本任务不允许：

- 修改 `apps/coordinator/**`、`packages/protocol/**`、`.github/workflows/**`；
- 覆盖 A 端实现或修改冻结协议来迁就执行器；
- 直接推送 `main`、自动合并、rebase、强制推送；
- 修改 Cloudflare、数据库或生产环境；
- 安装全局软件、配置开机自启或系统服务而不先取得用户明确同意；
- 删除文件、工作树、日志或历史而不先取得用户明确同意。

如果发现协调器或协议确实需要变化，只写变更提案和复现证据，交给 A 端处理。

### 3. 首轮检查与仓库准备

先检查，不要凭记忆填写版本：

```powershell
git --version
node --version
npm --version
opencode --version
```

要求 Node.js `22.x`。OpenCode 必须使用 B 自己的模型服务登录，不能复用 A 的 Codex
订阅或登录文件。缺少工具时一次列出；继续完成不依赖该工具的工作。安装全局依赖前停下，
只向用户申请安装该具体软件，不索取账号密码。

在一个全新目录克隆权威分支：

```powershell
git clone --branch task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1 --single-branch https://github.com/abah661/-.git dual-agent-coordinator-b
Set-Location dual-agent-coordinator-b
git rev-parse HEAD
```

`git rev-parse HEAD` 必须精确得到：

```text
d493bd263febefcc4faca21da617520ce03fefa8
```

若不是该值，停止写代码并报告实际 SHA，不要自行选择“差不多”的版本。

然后执行：

```powershell
Get-Content -Raw AGENTS.md
git status --short
git switch -c task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4 d493bd263febefcc4faca21da617520ce03fefa8
npm ci
npm run check
```

记录每条命令的退出码和测试数字。未实际执行的检查不得写成成功。

### 4. B4 必须完成的常驻入口

在 B 端范围内实现一个可由 `npm` 脚本启动的常驻执行器。复用现有模块，不要重写已有内核：

- `loadExecutorConfig` / `CoordinatorClient`；
- `HttpLeaseTransport`；
- `HttpHeartbeatTransport`；
- `HttpRecoveryTransport`；
- `HttpResultReporter`；
- `runAttempt`；
- 现有 worktree、进程树停止、资料校验、diff 检查和结果归一化模块。

常驻入口至少完成以下真实流程：

1. 从环境变量读取配置，缺失配置时清楚报错，但绝不打印 Token；
2. 调用 `/v1/health` 检查 Worker；
3. 注册 `EXE-B-OPENCODE`；
4. 以稳定幂等键领取任务；
5. 无任务时进入有上限的空闲轮询，不把空队列当故障；
6. 领取后先启动独立续租与心跳，再调用 OpenCode；
7. 使用任务绑定的 `base_sha`、规则、契约和验收 SHA；
8. 只在租约仍有效、diff 范围合法、无敏感文件时允许提交和推送；
9. 使用固定幂等键回报结果；
10. `401/403` 进入 `blocked_auth`，不计为代码返修；
11. `409` 或租约失效时立即停止子进程，不推送、不上报旧结果；
12. 网络不可达时停止领取新任务，不猜测任务仍归自己；
13. `Ctrl+C` 时停止轮询、心跳、续租和子进程，安全退出；
14. 重启后先查询归属，再决定继续或放弃本地 attempt。

建议只在 `apps/executor/package.json` 增加启动脚本，不要为了方便修改根目录验收命令。
所有云端字符串只能作为结构化数据使用，不得作为任意 shell 命令执行。

### 5. B4 最低测试门槛

新增测试必须覆盖：

- 启动配置完整/缺失；
- 注册成功与身份不匹配；
- 空队列轮询；
- 领取成功且同一次重试复用幂等键；
- 续租、心跳、执行、结果上报的顺序；
- 401/403、409、429、网络中断；
- 租约失效后不推送、不上报；
- 优雅停止与重启恢复；
- 日志中不出现 Bearer Token；
- Windows 中文和空格路径不退化。

完成后必须实际运行：

```powershell
npm run typecheck
npm run validate:protocol
npm test
npm run check
git diff --check
git status --short
```

在本地检查全绿前不得推送。不要删除断言、跳过失败测试或降低验收标准。

### 6. 安全接收 B 执行器 Token

不要让用户复制 Token 到聊天框。使用 Windows 当前用户证书进行加密交接。

#### 6.1 B 电脑生成公钥证书

由 agent 在 B 电脑调用 Windows PowerShell 执行；私钥保持不可导出，并留在
`Cert:\CurrentUser\My`：

```powershell
$cert = New-SelfSignedCertificate `
  -Subject 'CN=DualAgent-B-Token-Handoff' `
  -Type DocumentEncryptionCert `
  -KeyExportPolicy NonExportable `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddDays(7)

Export-Certificate `
  -Cert $cert `
  -FilePath "$env:USERPROFILE\Desktop\B-token-public.cer"
```

只把 `B-token-public.cer` 交给 A 电脑。**绝对不要导出 PFX 或私钥。**

#### 6.2 A 电脑生成密文

A 端 agent 收到 `.cer` 后，会从 A 电脑的 Windows DPAPI 加密凭据中只读取
`EXE-B-OPENCODE` 的 Token，在内存中用该公钥加密，输出：

```text
B-executor-token.p7m
```

A 端不得显示 Token 明文，也不得把明文写入临时文件。

#### 6.3 B 电脑解密并用 DPAPI 保存

B 端 agent 收到 `.p7m` 后，将其直接解密到内存，并以 Windows DPAPI `SecureString`
形式保存到用户本机受限目录。不要把明文写入 `.env`、JSON、Markdown 或注册表环境变量。
运行时仅注入当前进程的 `COORDINATOR_API_TOKEN`，终端关闭后自动消失。

密文、公钥证书和本地加密副本都不得加入 Git。未经用户批准不要自动删除交接文件。

### 7. 联调时的非敏感运行配置

下面三项可以写入本机启动说明，但不要写 Token：

```text
COORDINATOR_BASE_URL=https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev
EXECUTOR_ID=EXE-B-OPENCODE
PROJECT_ID=<由 A 端在 P3 开始时提供>
```

真实开发任务还需要一个**独立的目标业务仓库**。协调系统仓库不能充当目标业务仓库。
在 A 端提供 `<PROJECT_ID>`、测试任务图和 `<TARGET_REPO_URL>` 前，可以完成 B4 开发、
本地测试、Worker 健康检查和执行器注册，但不得伪造真实任务执行成功。

### 8. 真实双机联调顺序

1. B 报告本地 `npm run check` 证据和 B4 提交 SHA；
2. B 推送且只推送 `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4`；
3. A 独立审查并整合 B4，不直接覆盖 `apps/executor/**`；
4. B 完成安全 Token 接收，健康检查返回 `200`；
5. B 注册 `EXE-B-OPENCODE`，只报告 HTTP 状态，不报告 Token；
6. A 创建 P3 项目并提交最小任务图；
7. B 常驻进程领取任务、续租、心跳、调用 OpenCode、验证、推送任务分支、回报结果；
8. A 查询最终状态并做固定提交整合和独立验收；
9. 双方核对 task、attempt、epoch、提交 SHA、测试证据和时间线；
10. 再执行 P5：断网、租约过期、旧 epoch、认证失效和自动返修。

P3 只有在两台真实电脑都留下服务端状态和本地日志证据后才能标记完成。

### 9. 每阶段回报格式

每次回报必须按下面格式，不写空泛的“已完成”：

```markdown
## B 端阶段回报

- 阶段：B4 / P3 / P5
- 分支：
- HEAD SHA：
- 实际执行命令：
- 退出码：
- 测试数量与结果：
- Cloudflare HTTP 状态（如已执行）：
- 修改文件：
- 未完成项：
- 阻塞项：
- 下一步：
```

### 10. 需要一次列出的缺失信息

首次检查后一次性列出以下项目的真实状态，然后继续所有不依赖它们的工作：

- Node.js 22、Git、npm、OpenCode 是否存在及版本；
- B 自己的 GitHub 与 OpenCode 是否已登录；
- `B-token-public.cer` 是否已生成；
- A 是否已返回 `B-executor-token.p7m`；
- P3 的 `PROJECT_ID`；
- 独立测试目标仓库 `<TARGET_REPO_URL>`；
- OpenCode 实际模型标识和配额是否可用。

不得索取或记录用户的 GitHub、Cloudflare、邮箱或模型服务登录密码。

