# B 端当前状态与待办清单

日期：2026-09-22
维护者：B（OpenCode / abah）

本文件回答两个问题：**B 端还有什么要做**、**还有什么需要 A 端确认**。

---

## 一、总体进度

| 阶段 | A 端 | B 端 |
| --- | --- | --- |
| P0 初始化环境 | ✅ | ✅ |
| P1 冻结协议 v1 | ✅ 冻结锚点 `a577d66` | ✅ 可实现性核对完成，无阻塞 |
| P2 双方开发组件 | ⚠️ 已推送任务分支，**基线为冻结点前**（见 §4.5） | ✅ 已完成（含传输层），已推 main |
| P3 离线与本地集成 | ⏸️ 未开始 | ⏸️ 依赖 A 端协调器可用 |
| P4 接通 Cloudflare / GitHub | ⏸️ 未开始 | ⏸️ 依赖 A 端部署 |
| P5 验收自动并行与返修 | ⏸️ 未开始 | ⏸️ 依赖 P4 |
| P6 可选同步 | — | ✅ Syncthing 已配置 |

---

## 二、B 端已完成（有证据）

### 2.1 P2 全部三项 + 传输层

| 提交 | 内容 |
| --- | --- |
| `5bc8048` | 执行器公共内核、OpenCode 适配器、结果归一化 |
| `ec27bda` | 按 A 端答复 v1 对齐传输契约（HTTP 客户端 + 4 个适配器 + 编排层） |
| `23be27d` | B→A CP-0001 确认回执 |
| `16b1869` | B 端状态与待办清单 |

以上 6 个提交已推送至 `origin/main`，`git ls-remote origin main` 与本地 HEAD 完全一致。

对应《项目书》第 P2 节 B 端五项：

| P2 要求 | 状态 | 落点 |
| --- | --- | --- |
| 执行器公共内核 | ✅ | `apps/executor/src/core/` |
| Git/worktree、心跳、进程控制和恢复 | ✅ | `worktree.ts` / `heartbeat.ts` / `process.ts` / `recovery.ts` |
| OpenCode 适配器独立模块 | ✅ | `adapters/opencode.ts` |
| 结果归一化 | ✅ | `result/normalize.ts` |
| 上下文导出和资料校验 | ⚠️ **部分** | 见 §三.1 |
| Windows 与两种适配器兼容性测试 | ⚠️ **部分** | 见 §三.2 |

### 2.2 验证证据

| 检查 | 结果 |
| --- | --- |
| `tsc -b` | EXIT=0 |
| `vitest run` | **248/248 通过**（11 个测试文件） |
| `validate:protocol` | EXIT=0，5/5 样例 |
| `packages/protocol` | 零改动（与 A 端维护边界一致） |

### 2.3 Syncthing（P6 部分）

已安装运行 v2.1.5，发布/接收目录已建，同步根目录在 Git 仓库之外。
设备 ID：`IB4BOBV-WEUPNU4-FK62OF4-2B6VIUU-NZV4FUG-IMUB6RK-WKVPRWR-KYRCEQL`

---

## 三、B 端待完成

### 3.1 上下文导出与资料校验（P2 第五项，未做）

《项目书》第 P2 节要求 B 端"结果归一化、**上下文导出和资料校验**"。
目前只完成了结果归一化，后两项未实现。

**上下文导出**：把任务需要的上下文（规则文件、契约、目标仓库结构）整理成
agent 可用的输入（对应 `opencode run --file` 注入）。

**资料校验**（第 10.2 节 + 验收 V15/V16）：
- 同步资料必须先记录 SHA-256 并核对
- 不完整的资料包不得作为任务输入（V16）
- 只能在清单范围内读取，不能覆盖活动源码

**依赖**：需要 A 端明确「资料清单」的格式与存放位置（见 §四.4）。

### 3.2 Windows 真实进程集成测试（P2 第五项 + P3）

当前 248 个用例中，涉及进程与 agent 调用的部分**全部使用假运行器**。
这是刻意的（保证测试确定、不烧配额），但《项目书》P3 明确要求：
> "模拟测试不能替代真实 CLI 验证。"

需要补的真实验证：
- 真实拉起 OpenCode 进程，验证中文路径与含空格路径
- 真实进程树停止（`taskkill /T` 对 agent 拉起的子进程是否生效）
- 真实测试命令采集证据（`collectEvidence` 对真实 vitest 输出的解析）

**依赖**：需要 A 端协调器可用（否则拿不到租约，`runAttempt` 无法走完整流程）。
也可先绕过租约做单项验证 —— 见 §五。

### 3.3 常驻进程入口（`src/index.ts` 的常驻循环）

当前 `apps/executor/src/index.ts` 导出的是**可组合模块**，
`core/attempt.ts` 是**单次尝试的编排**，但**常驻循环**（领取 → 执行 → 上报 → 循环）
未接。

**阻塞原因**：缺少「领取任务」的 HTTP 端点契约。A 端答复 v1 覆盖了
续租/心跳/归属/上报，但**没有描述「领取任务」的请求与应答形状**
（参见 `apps/coordinator/README.md` 里的 `lease-task.ts`，尚未实现）。

### 3.4 开机自启

`docs/authorization.md` 已注明需**另行批准**（属授权表"系统安装、自启"项）。
未申请、未实施。

---

## 四、需要 A 端确认

按重要性排序。**第 1、2 条是硬阻塞**。

### 4.1 ⛔ 领取任务的端点契约（硬阻塞 3.3）

A 端答复 v1 未包含此项。B 端需要知道：

| 问题 | 具体内容 |
| --- | --- |
| 路径与方法 | `POST /v1/projects/<project_id>/tasks/lease`？还是别的形状 |
| 请求体 | 是否带 `executor_id`、能力声明（支持的 `agent_kind`）、`write_scope`？ |
| 应答体 | 是否 `{task, lease}` 与续租同形？无任务可领时返回什么（`204`？`200 {task: null}`？） |
| 幂等键 | scope 名是什么？重试时同一键是否保证**不产生两个租约**（验收 V02） |
| 竞争语义 | 两个执行器同时领取时，服务端如何保证只产生一个有效领取 |

### 4.2 ⛔ CP-0001 的两点履约说明（硬阻塞联调）

B 端在 `docs/proposals/CP-0001-executor-http-transport.md` §3 提了两点，
需要 A 端确认服务端行为**一致**：

**① 401/403 与 409 走不同分支**

| 状态码 | B 端理解 | B 端动作 |
| --- | --- | --- |
| `409` | 服务端已判定「你不再是持有者」 | 返回 `lost` → 立即停子进程 |
| `401/403` | 只是「无法证明我是持有者」 | 上抛 → 归一化为 `blocked`，**不计返修** |

若服务端在 token 过期时**也**返回 409，那么 B 端会错误地停掉子进程并上报丢租约 ——
这是行为不一致，需要在联调前对齐。

**② 心跳幂等键必须每次不同**

B 端的心跳键每次递增（`heartbeat:<executor_id>:<序号>:<时间戳>`）。
如果服务端按 scope 对心跳做**幂等去重**，重复键会导致心跳不被记录，
协调器会**误判执行器失联**。

请确认：心跳端点是否对 `idempotency_key` 做去重？若做，是否只对同键的
**短时间窗口内重复请求**去重（这才是合理语义）？

### 4.3 ⚠️ 接口路径核对（阻塞联调）

B 端按以下路径实现，若与 A 端实际部署不一致请指出：

| 用途 | B 端实现的路径 |
| --- | --- |
| 健康 | `GET /v1/health`（免认证） |
| 续租 | `POST /v1/projects/<project_id>/tasks/<task_id>/lease/renew` |
| 心跳 | `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat` |
| 归属查询 | `POST /v1/projects/<project_id>/tasks/<task_id>/ownership` |
| 结果上报 | `POST /v1/projects/<project_id>/tasks/<task_id>/attempts/<attempt_id>/result` |

### 4.4 ⚠️ 资料清单格式（阻塞 3.1）

《项目书》第 10.2 节要求同步资料按清单校验。需要确认：

- 清单文件的路径与格式（JSON？相对同步根目录还是仓库？）
- 每个条目是否含 `sha256` 与 `size`？
- 校验失败时的期望行为（B 端倾向：拒绝将该包作为任务输入并报 `needs_input`）

### 4.5 ⛔ 协调器分支基线分叉（已核实，硬阻塞联调）

网络恢复后 B 端已完成核实，**结论比原先严重**。详见
`docs/handoff/B-to-A-remote-integration-check.md`。摘要：

| 事实 | 值 |
| --- | --- |
| A 分支 | `refs/heads/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` = `67e72da` |
| 该分支独有提交 | 4 个（`fb9202f` / `88ff82d` / `2f1e4d5` / `67e72da`） |
| 与 main 的共同祖先 | `a577d66`（= **冻结锚点**，status 当时仍为 `draft`） |
| main 是它的祖先吗 | ❌ NO |
| 它是 main 的祖先吗 | ❌ NO → **两侧已分叉** |
| 它对 `packages/protocol` 的改动 | 空（未主动改，只是**沿用了冻结点前的旧快照**） |
| 它上面的 `version.ts` | `status: "draft"`、`frozenAt: null`、**无 `frozenTreeSha`** |

也就是说 A 的协调器代码**跑在协议冻结之前的世界里**。冻结动作（`00a1acf` 写入
`frozenTreeSha`）与冻结守卫修复（`bbd57fd`）都只在 main 上。

好消息是**没有文件级冲突**（A 动 `apps/coordinator` / `packages/codex-adapter` /
`packages/integration` / `tools/cli`，B 动 `apps/executor` / `tests/executor` /
`docs`），唯一重叠的 `version.ts` 是"A 整侧落后"而非双向修改。

**A 端请决策**：

1. 这 4 个提交是 **在 `a577d66` 上 rebase 到当前 main**，还是先 merge main 再合回？
   （建议 rebase —— `version.ts` 与 `tools/validate-protocol` 会自然取到 main 的冻结版本。）
2. `package-lock.json` 由谁重新生成？（建议 A 在 rebase 后于 main 侧统一 `npm install`。）
3. A 的 `.github/workflows/ci.yml` 是否已包含 `apps/executor` 的 typecheck / test？

---

## 五、B 端可自行推进、不等 A 端的工作

以下三项不依赖 A 端答复，B 端可以立即开始：

### 5.1 绕过租约的真实进程集成测试

`core/attempt.ts` 的编排依赖租约，但下列模块**不依赖**：

- `core/process.ts` —— 三级停止链的真实验证（真实拉起一个会挂起的进程，
  验证 `taskkill /T` 是否杀掉子进程树）
- `core/worktree.ts` —— 真实 `git worktree add` / `remove`，
  验证中文路径与含空格路径
- `core/evidence.ts` —— 用真实 vitest 输出验证 `parseTestSummary` 的解析
- `adapters/opencode.ts` —— **真实调用一次 OpenCode**
  （`opencode run -m myapi/gpt-5.6-sol --format json`），
  验证事件流解析对准真实输出

### 5.2 上下文导出与资料校验的**本地部分**

资料校验的 SHA-256 计算、清单比对、不完整包判定，都可先实现，
清单格式待 A 端确认后调整（用可替换的解析入口）。

### 5.3 Windows 路径边界测试补强

已覆盖中文/空格路径，可再补：路径长度接近 260 限制、UNC 路径、
盘符大小写差异。

---

## 六、阻塞与风险

### 6.1 ✅ 推送已完成（原阻塞已解除）

代理恢复后 B 端已完成推送：

| 项 | 值 |
| --- | --- |
| `git push` 结果 | `16b1869..ad1d15d main -> main`，退出码 0 |
| `git ls-remote origin main` | `ad1d15d9d8cb2e0b07e42ef37057b7c0bbce6086` |
| 本地 HEAD | `ad1d15d9d8cb2e0b07e42ef37057b7c0bbce6086` |
| 一致性 | ✅ 逐字一致 |

历史诊断（已解决，留档备查）：

1. `git config` 写死 `http.proxy`/`https.proxy` = `127.0.0.1:7897`，当时端口关闭
2. 环境变量另有 `127.0.0.1:58759`，但 **git 优先用自身配置，不看环境变量**
3. 覆盖为可用端口重试 → `CONNECT tunnel failed, response 502`
4. 直连 `github.com:443` → `Connection was reset`

**排障经验（稳定结论）**：`git push` 在 PowerShell 工具里**输出被完全吞掉**
（只回 `EXIT=128`，无任何 stdout/stderr），且 `cmd /c` 被工具安全策略拦截。
**改用 Bash 工具执行 push** 即可拿到完整输出。

### 6.2 ⛔ A 端未把协调器合入 main，且基线分叉

原文已由 §4.5 取代 —— 核实结果比"未合入"更严重：A 的任务分支基线是
冻结锚点 `a577d66`（冻结点**之前**），与 main 已分叉。详见 §4.5 与
`docs/handoff/B-to-A-remote-integration-check.md`。

**影响**：B 端的 `CoordinatorClient` 需要真实且与 main 同源的 `apps/coordinator`
才能端到端验证；A 端 rebase/merge 到位前，P3 无法开始。

### 6.3 ⚠️ 两端从未做过一次真实联调

截至目前，B 端所有验证都是**本机单向的**（248 个用例 + 类型检查 + 协议校验）。
《项目书》第 15 节的完成定义要求 **V01–V14 有真实双机证据**，
这一项**尚未开始**。

---

## 七、明确不属于本项目要求的事（避免混淆）

以下是我在推进中自行引入的外部工具，**不是项目书要求**，已记录来源以便区分：

- **Cloudflare MCP 服务器 / Skills**：来自 Cloudflare 官方 agent-setup 指引
  （`https://developers.cloudflare.com/agent-setup/prompt.md`），
  该指引**没有 WorkBuddy 分支**。项目书第 4.1 节 B 端工具清单只有
  Node.js / Git / npm / OpenCode CLI。
- **wrangler CLI**：全仓库检索 `wrangler` **0 处命中**，项目书亦无。
  Worker 部署归 A 端（资源所有者负责部署）。

---

## 八、一句话总结

**B 端 P2 主体已完成且有证据，且已全部推送至 `origin/main`。**
要继续推进必须先解决两件事 ——
① A 端确认「领取任务端点」与「CP-0001 两点履约说明」；
② A 端把协调器 rebase/merge 到与 main 同源的基线，并在 `main` 上可用，
才能开始 P3 真实双机联调。

在等待期间，B 端可自行推进 §五 的三项（真实进程集成测试、资料校验本地部分、
Windows 路径边界补强），均不依赖 A 端。
