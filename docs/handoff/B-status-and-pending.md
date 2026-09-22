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

### 2.1 P2 全部五项 + 传输层

| 提交 | 内容 |
| --- | --- |
| `5bc8048` | 执行器公共内核、OpenCode 适配器、结果归一化 |
| `ec27bda` | 按 A 端答复 v1 对齐传输契约（HTTP 客户端 + 4 个适配器 + 编排层） |
| `23be27d` | B→A CP-0001 确认回执 |
| `ad1d15d` | 远端集成核查（发现 A 分支基线分叉） |
| `2b80674` | 状态文档更正 |
| 见下 | 真实集成测试、资料校验、上下文导出、路径边界 |

对应《项目书》第 P2 节 B 端五项：

| P2 要求 | 状态 | 落点 |
| --- | --- | --- |
| 执行器公共内核 | ✅ | `apps/executor/src/core/` |
| Git/worktree、心跳、进程控制和恢复 | ✅ | `worktree.ts` / `heartbeat.ts` / `process.ts` / `recovery.ts` |
| OpenCode 适配器独立模块 | ✅ | `adapters/opencode.ts` |
| 结果归一化 | ✅ | `result/normalize.ts` |
| 上下文导出和资料校验 | ✅ | `context.ts` / `materials.ts` |
| Windows 与两种适配器兼容性测试 | ✅ | `windows-integration.test.ts` / `windows-paths.test.ts` |

### 2.1.1 真实运行验证（P3 要求的「不能只用模拟」）

| 文件 | 内容 |
| --- | --- |
| `tests/executor/windows-integration.test.ts` | 真实 `taskkill /T` 杀进程树、真实 `git worktree`（中文 + 空格路径）、真实 SHA-256 |
| `tests/executor/materials.test.ts` | 资料校验（V15 / V16），含真实文件系统哈希 |
| `tests/executor/context.test.ts` | 上下文导出与脱敏（第 11 节） |
| `tests/executor/windows-paths.test.ts` | UNC、MAX_PATH、盘符大小写、中文相似前缀 |

**真实运行发现并修复了一个生产缺陷**：`parseTestSummary` 无法解析真实失败输出
（vitest 用**竖线**分隔：`Tests  1 failed | 1 passed (2)`），
导致真实失败被判为「无法判定」——直接影响 V06。已修复。

### 2.2 验证证据

| 检查 | 结果 |
| --- | --- |
| `tsc -b` | EXIT=0 |
| `vitest run` | **345/345 通过 + 1 skipped**（15 个测试文件） |
| `validate:protocol` | EXIT=0，5/5 样例 |
| `packages/protocol` | 零改动（与 A 端维护边界一致） |

### 2.3 Syncthing（P6 部分）

已安装运行 v2.1.5，发布/接收目录已建，同步根目录在 Git 仓库之外。
设备 ID：`IB4BOBV-WEUPNU4-FK62OF4-2B6VIUU-NZV4FUG-IMUB6RK-WKVPRWR-KYRCEQL`

---

## 三、B 端待完成

### 3.1 ✅ 上下文导出与资料校验（已完成）

《项目书》第 P2 节要求 B 端"结果归一化、**上下文导出和资料校验**"。三项均已完成：

| 项 | 落点 | 覆盖规则 |
| --- | --- | --- |
| 结果归一化 | `result/normalize.ts` | 归一化降级优先级 |
| 资料校验 | `core/materials.ts` | §10.2 / §10.3，验收 V15 / V16 |
| 上下文导出 | `core/context.ts` | §11 共享范围与脱敏、§10.1 |

**资料校验已覆盖**：
- SHA-256 与清单比对（V15）
- 不完整包判为不可用且**不返回任何可用路径**（V16）
- 路径越界与同步冲突副本**根本不读取**（P3「只能按清单读取」）
- 任务 ID 不符则整体拒绝
- 纯读取：不写、不移、不删同步目录（§10.3 要求删除需人工批准）
- 「不依赖附件的代码任务不被同步问题阻断」（§10.3）

**上下文导出已覆盖**：
- 敏感文件（`.env` / `auth.json` / `id_rsa` / `.ssh` / `.aws` / Cookies 等）**排除且不读取**
- 文本脱敏（GitHub token / API key / AWS key / JWT / Bearer / 邮箱 / 内网 IP）
- 超大文件**跳过而非截断**（不注入残缺上下文）
- 云端摘要只含第 11 节允许字段，敏感路径被移除并记入未解决问题

**唯一待定**：清单的**序列化格式**（见 §四.5）。已设计为可替换解析入口，
A 端确认后只换解析器，校验逻辑不动。

### 3.2 ✅ Windows 真实进程集成测试（已完成）

原先涉及进程与 agent 调用的用例**全部使用假运行器**。
《项目书》P3 明确要求：
> "模拟测试不能替代真实 CLI 验证。"

已补 `tests/executor/windows-integration.test.ts`（20 用例）：

| 真实验证 | 方法 |
| --- | --- |
| 进程树停止 | 真实构造 node 父→子进程树，用真实 `taskkill /T` 杀掉，断言**子进程确实死了** |
| 超时终止真进程 | 真实长驻进程 + 短超时，断言 `timed_out` 且进程确实结束 |
| 真实 worktree（中文 + 空格） | 在 `双端 连接 测试仓库` 路径下真实 `git worktree add/remove` |
| 两个独立 worktree | 在 A 写文件，断言 B 与主仓库都不受影响 |
| 拒绝覆盖未提交内容 | 目标路径已存在时必须硬失败，且未提交文件完好 |
| 基线不存在则拒绝开工 | 用假 SHA，断言抛错而非用 HEAD 顶替 |
| 真实 SHA-256 | 真实文件哈希，断言可复现 |

**真实运行发现并修复了一个生产缺陷**（`parseTestSummary`），详见 §六.4。

**仍未做的**：真实调用 OpenCode（`DAC_RUN_OPENCODE=1` 显式开启，默认跳过以不烧配额）。
Codex 适配器侧由 A 端负责。

### 3.3 ✅ 常驻进程入口（已完成于 B4）

`apps/executor/src/daemon.ts` 已实现可常驻运行的入口，落实交接单 §4 的 14 项要求。
`index.ts` 保持「纯导出、无副作用」，与运行入口**刻意分离**（避免 import 即启动常驻进程）。

启动方式：`apps/executor/package.json` 的 `start` / `start:json`。

证据：`docs/reports/B4-B-executor-daemon.md`；新增 `tests/executor/daemon.test.ts`（37 例全通过）。

> 历史备注：本项曾因缺「领取任务」端点契约而阻塞（原 §四.1）。
> 该阻塞已解除——B 端直接从 A 端已部署的协调器源码读取到完整契约，见 §6.5。

### 3.4 开机自启

`docs/authorization.md` 已注明需**另行批准**（属授权表"系统安装、自启"项）。
未申请、未实施。

---

## 四、需要 A 端确认

按重要性排序。**第 1、2 条是硬阻塞**。

### 4.1 ✅ 领取任务的端点契约（已解除，曾硬阻塞 3.3）

已从 A 端协调器源码核实，**无需再答**：

| 问题 | 已核实答案 |
| --- | --- |
| 路径与方法 | `POST /v1/projects/<project_id>/tasks/lease` |
| 请求体 | `protocol_version`、`executor_id`、`agent_kind`、`capabilities`(≥1)、`idempotency_key` |
| 应答体 | 有任务 ⇒ `{task, lease}`；**无任务 ⇒ HTTP 200 + `{task:null, lease:null, status:"empty"}`** |
| 幂等键 | scope 名 `lease_task`，服务端按 `lease_task:<key>` 自算 |
| 竞争语义 | 服务端在 `project-do.ts` 内串行选取 `ready` + 依赖就绪 + 能力匹配的任务 |

关键点：**空队列是正常路径而不是错误**——B 端据此按交接单 §4 第 5 项
实现「有上限的空闲轮询」，不抛错、不计故障。

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

### 4.5 ✅ 协调器分支基线分叉（已由 A 端解决）

原核实结论（A 分支 = `67e72da`，与 main 已分叉、且跑在协议冻结**之前**）**现已失效**。
B4 开工时复核：

| 事实 | 值 |
| --- | --- |
| A 分支 | `task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` = `2f1d914` |
| main 是它的祖先吗 | ✅ **YES**（`git merge-base --is-ancestor ae659a9 2f1d914` 退出码 `0`） |
| 它对 `packages/protocol` 的改动 | 已带上冻结：`version.ts` 为 `status: "frozen"`、`frozenTreeSha: "f9644c44628d5fe8445bcbbb54ad336d7fbe0abc"` |

即 A 端已把 main 合入自己的分支，协议冻结随之进入 A 侧。**该项不再是阻塞**。
B4 的工作基线（`d493bd2`）也是该分支的祖先，故 B4 与 A 端处在同一基线上。

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

### 5.2 ✅ 上下文导出与资料校验的**本地部分**（已完成）

- `apps/executor/src/core/materials.ts` —— 资料清单解析、SHA-256 校验、
  不完整包判定（V15/V16）。清单解析走**可替换入口** `ManifestParser`，
  A 端确定格式后只需替换 `parseManifestJson`，其余逻辑不动。
- `apps/executor/src/core/context.ts` —— 上下文导出与脱敏（§11 / §10.1 排除表）。
- 测试：`tests/executor/materials.test.ts`（23 例）、
  `tests/executor/context.test.ts`（35 例），均含**真实文件系统**校验。

### 5.3 ✅ Windows 路径边界测试补强（已完成）

`tests/executor/windows-paths.test.ts`（20 例）已覆盖：盘符大小写、尾随/重复
分隔符、混合斜杠、前缀相同但非层级关系、UNC 路径（同共享/异共享/异主机）、
MAX_PATH 附近的 255/259/400 长度、中文路径（`双端连接` vs `双端连接-备份`
vs `双端连接2`）、中文+空格嵌套、中文路径下的敏感文件识别与脱敏。

### 5.4 ✅ 真实进程 / 真实 Git 集成测试（已完成）

`tests/executor/windows-integration.test.ts`（20 例，1 例按需跳过）——
按 P3「模拟测试不能替代真实 CLI 验证」的原则，这一层用**真实进程树**
和**真实 Git 仓库**验证：

- 真实父子进程树，子 PID 写盘 → 确认存活 → `killTree` → 确认整树消失；
- 超时强杀、正常退出、stdout/stderr 分离；
- 临时仓库名为 `双端 连接 测试仓库`，真实 `git worktree` 建/删、双工作树隔离、
  拒绝覆盖已有工作树（断言未提交文件存活）、拒绝不存在的 base_sha；
- 证据输出用**真实抓取的 vitest 样本**（嵌套 vitest 会挂起，故样本在外部抓取后
  硬编码，抓取命令写在注释里）。

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

### 6.2 ✅ A 端已将协调器合入 main 基线（原阻塞已解除）

原记录：A 的任务分支基线是冻结锚点 `a577d66`（在冻结点**之前**），与 main 分叉。

B4 复核：A1 顶端 `2f1d914` 已**包含** main 顶端 `ae659a9`
（`git merge-base --is-ancestor` 退出码 `0`），且 `packages/protocol/src/version.ts`
为 `status: "frozen"` 并带 `frozenTreeSha`。原 §4.5 的分叉结论已失效。
`a577d66` 仍在该分支历史中，说明是**合并**而非改写历史。

**影响**：B 端的 `CoordinatorClient` 需要真实且与 main 同源的 `apps/coordinator`
才能端到端验证；A 端 rebase/merge 到位前，P3 无法开始。

### 6.3 ⚠️ 两端从未做过一次真实联调

截至目前，B 端所有验证都是**本机单向的**（345 个用例 + 类型检查 + 协议校验）。
《项目书》第 15 节的完成定义要求 **V01–V14 有真实双机证据**，
这一项**尚未开始**。

### 6.4 ✅ 真实执行发现并修复了一个生产缺陷（P3 原则的实证）

用真实 vitest 输出跑测试时发现：`parseTestSummary` **无法解析真实的失败输出**。

真实 vitest 3.x 用**竖线**分隔各段：

```
Test Files  1 failed (1)
     Tests  1 failed | 1 passed (2)
```

原实现是单个带可选组的正则，遇到竖线格式直接返回 `null` → 一次**真实失败**的
运行会被判为「无法判定」（`summary_parsed: false`）。这会直接危及 **V06**
（失败运行必须能被判定为失败）。

已改为**逐段解析**（分别匹配 `passed`/`failed`/`skipped`/`todo`），并用真实抓取的
样本补了回归测试。正则上方留了注释：**不要凭记忆改这些正则**。

> 教训：这条缺陷是**模拟测试抓不到的**——模拟测试里我自己拼的输出恰好是旧正则
> 能解析的格式。这正是 P3 要求真实 CLI 验证的原因。

### 6.5 ✅ B4 又发现 5 处真实契约不符（同类问题的复发与治理）

B4 开工时先读 A 端**已部署**的协调器源码，发现执行器传输层有 5 处与真实服务端不符。
它们**在既有测试下全绿**——因为假体恰好也错成了同样形状：

| # | 缺陷 | 真实后果 |
| --- | --- | --- |
| 1 | `http.ts` 从未把 `idempotency_key` 放进请求体 | 续租/心跳/领取全部 `400` |
| 2 | `renew` 只认 `{lease:{…}}` 信封，而服务端返回**裸租约** | 真实续租必被拒 → 租约必然中途过期 |
| 3 | 归属查询读 `response.lease.*`，而字段**平铺在顶层** | 归属永远 `unreachable`，恢复永久 `halt_offline` |
| 4 | 上报发自定义信封，而服务端按**扁平** `ResultReportSchema` 解析 | 结果永远无法上报 |
| 5 | 只读端点发送了多余的 `idempotency_key` | schema 不接受 |

已全部按真实契约修正，并**为这些真实形状补了回归测试**（`http-transport.test.ts` 48 例）。
另有 3 个既有测试**编码了错误契约**，已一并纠正——不是「改测试迁就实现」，
而是测试原本断言的就是不存在的形状。

> 教训（与 §6.4 同源）：**假体与真实服务端形状不一致**是一类会反复出现的风险。
> 治理方式是「先读对端源码对齐契约，再写实现与测试」，而不是先写双方都自洽的假体。
> 已把这条写进 `docs/reports/B4-B-executor-daemon.md` 第二节，供 A 端审查时复核。

> 已同步一处自查：本文件原 §3.3 曾据 `index.ts` 的导出面推断「常驻入口未接」，
> 结论正确但阻塞原因（缺 `lease_task` 契约）在 A 端落地后已失效，故改为 §3.3/§4.1 的现状写法。

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
§五 中原本"可自行推进"的四项（真实进程集成测试、资料校验本地部分、
上下文导出、Windows 路径边界补强）**均已做完**；真实执行还额外
发现并修复了一个生产缺陷（见 §6.4）。

要继续推进必须先解决两件事 ——
① A 端确认「领取任务端点」与「CP-0001 两点履约说明」；
② A 端把协调器 rebase/merge 到与 main 同源的基线，并在 `main` 上可用，
才能开始 P3 真实双机联调。

**A 端待回复项已汇总为一份可直接转发的清单**：
`docs/handoff/A-side-response-checklist.md`（含阻塞严重度排序、B 端当前假设、
以及"若只能先做一件事请先做第 1 步 rebase"的建议）。
