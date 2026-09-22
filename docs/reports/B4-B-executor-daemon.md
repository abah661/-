# B4 报告：常驻执行器入口（`apps/executor/src/daemon.ts`）

- 阶段：B4
- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4`
- B4 最低代码基线：`d493bd263febefcc4faca21da617520ce03fefa8`
  （`TASK-A-COORDINATOR: record successful P4 deployment`，已核验为 HEAD 祖先，`git merge-base --is-ancestor` 退出码 `0`）
- 开工时 HEAD：`2f1d91416fc82e08c6dbd75ca688b1418ad759b6`（= 权威分支 `task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` 顶端）
- B4 实现提交（分支顶端）：`f9bebbb872aef28d3a730cc0e4a68b8fcd2d342c`（14 文件，+2534 / −103）
- 推送：已推送该分支；`git ls-remote` 复核远端 = 本地，`main` 未改动
- 工作区：`C:\Users\lenovo\Desktop\dual-agent-coordinator-b`（由主仓库 `C:\Users\lenovo\Desktop\双端连接` 检出的 worktree）

---

## 一、交付物

### 1.1 新增：`apps/executor/src/daemon.ts`

可常驻运行的真实入口，落实交接单 §4 的 14 项要求。刻意与 `index.ts` 分离：
`index.ts` 保持「纯导出、无副作用」，`daemon.ts` 才是「import 就启动」的运行入口。
启动脚本加在 `apps/executor/package.json`（`start` / `start:json`），
**未改动根目录验收命令**。

14 项要求在文件头有对照表，实现落点摘要：

| # | 要求 | 落点 |
| --- | --- | --- |
| 1 | 环境变量读配置，缺失清楚报错且不打印 Token | `loadExecutorConfig` + `makeLogger` 出口统一 `redactSecrets` |
| 2 | 调 `/v1/health` | `deps.health()`，失败即停且**不做任何云端写操作** |
| 3 | 注册 `EXE-B-OPENCODE` | `HttpRegistrationTransport` |
| 4 | 稳定幂等键领取 | `HttpLeaseAcquirer`（同一次调用内复用键、跨轮次换新键） |
| 5 | 空队列有上限轮询，不当故障 | `max_idle_polls` |
| 6 | 先起续租与心跳再调 OpenCode | `runAttempt` 内部时序（既有测试已锁定） |
| 7 | 四项 SHA 版本绑定 | `findBindingProblem`，缺项即**拒绝开工** |
| 8 | 租约有效 + diff 合法 + 无敏感文件才推送 | `report.status === "ready_for_integration"`（由 `normalizeResult` 判定） |
| 9 | 固定幂等键回报 | 服务端按 `task/attempt/epoch` 自算，客户端不传 |
| 10 | `401/403` → `blocked_auth`，不计返修 | `stop_reason: "auth_blocked"` |
| 11 | `409` / 租约失效 → 停子进程、不推送不上报 | `trace.sideEffectsSkipped` 分支 |
| 12 | 网络不可达 → 停领新任务 | `status === null` → `offline` |
| 13 | `Ctrl+C` → 停轮询/心跳/续租/子进程 | `signal` 透传至 `runOpenCodeTask`，触发 `SIGTERM` |
| 14 | 重启先查归属再决定 | `decideRecovery` 五个分支全覆盖 |

两条红线写进了代码注释，也是实现的取舍依据：

1. **不猜**：云端没回答的事实不得用本地推断替代（网络不可达就是不可达）。
2. **不假装成功**：自报完成不算完成；没推送就不能说推送了。

关于第 14 项，本实现的明确取舍是「**查得出来，但一律放弃**」：B4 没有恢复中间
worktree 状态的能力，硬续跑会造成两方同时改同一任务。真正的断点续跑属 P5，
此处**不假装实现**——日志与报告中如实标注为 `resume` 但放弃本地 attempt。

### 1.2 修改的文件

| 文件 | 改动 |
| --- | --- |
| `apps/executor/src/transport/http.ts` | **将 `idempotency_key` 合并进 JSON 请求体**（此前只写进了文档，从未真正发送） |
| `apps/executor/src/transport/adapters.ts` | 5 处契约修正（详见第二节）+ 新增注册/领取传输实现 |
| `apps/executor/src/core/lease.ts` | `remainingLeaseMs`/`isLeaseExpired` 放宽为 `Pick<Lease,"expires_at">`（归属响应里没有 `binding`/`agent_kind`） |
| `apps/executor/src/core/recovery.ts` | 新增 `OwnershipLease`；`TaskOwnership.still_mine.lease` 改用该类型 |
| `apps/executor/src/adapters/opencode.ts` | `OpenCodeTaskInput` 新增 `signal`；中止时发 `SIGTERM` |
| `apps/executor/src/core/attempt.ts` | `AttemptInput` 新增 `signal` 并透传 |
| `apps/executor/src/index.ts` | `export * from "./daemon.js"`（仍保持无副作用） |
| `apps/executor/package.json` | 新增 `"./daemon"` 导出与 `start` / `start:json` 脚本 |

---

## 二、本次最重要的发现：5 个真实集成缺陷

这些缺陷**全部无法被既有测试发现**——既有测试用的假体恰好也错成了同样的形状。
它们只有把执行器接到**A 端已部署的真实协调器**上才会暴露。
按交接单 §4 的措辞，此时必须先读协调器源码把契约对齐，而不是先写测试。

| # | 缺陷 | 真实后果 | 依据（A 端源码） |
| --- | --- | --- | --- |
| 1 | `http.ts` 从未把 `idempotency_key` 放进请求体 | 续租/心跳/领取全部 `400` | `api.ts` 的 `requireIdempotencyScope(input, scope)` 从 **body** 取键 |
| 2 | `HttpLeaseTransport.renew` 只认 `{lease:{…}}` 信封 | **每一次真实续租都被拒绝 → 租约必然在任务中途过期（V08）** | `project-do.ts` 的 `renewLease` 是 `jsonResponse(lease)`，返回**裸租约** |
| 3 | `HttpRecoveryTransport` 读 `response.lease.expires_at` | 归属查询永远 `unreachable`，恢复永久停在 `halt_offline` | `project-do.ts` 的 `queryOwnership` 把字段**平铺在顶层** |
| 4 | `HttpResultReporter` 发自定义信封 `{protocol_version, executor_id, lease_epoch, report}` | **结果永远无法上报** | `project-do.ts` 用 `ResultReportSchema` 解析**扁平** body |
| 5 | `queryOwnership` 发送了 `idempotency_key` | 只读端点多余字段，schema 不接受 | `OwnershipQuerySchema` 无此字段 |

配套的 3 个既有测试**编码了错误的契约**（断言续租体缺 `idempotency_key`、断言归属体带多余键、
用伪造信封测上报器）。已按真实契约修正，并**为上述真实形状补了回归测试**，
使这类「假体与真实服务端形状不一致」的问题今后会被测试直接抓住。

> 这 5 个缺陷是「先对齐契约、再写实现」的直接收益。若按直觉直接写常驻循环，
> 交付的会是一个**在真实双机上必然失败**的入口，且本地全绿。

---

## 三、实际执行命令与退出码

全部在本地 worktree 实际运行，逐条记录：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | 无错误 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` PASS + 5 个样例 PASS，输出「全部校验通过」 |
| `npm test` | `0` | **19 files passed；398 passed \| 1 skipped（共 399）** |
| `npm run check` | `0` | typecheck + validate:protocol + test 全通过 |
| `git diff --check` | `0` | 无输出（无空白符错误） |
| `git status --short` | `0` | 提交前实测 11 项（9 改 + 2 新增未跟踪）；补齐文档后提交集共 **14 个文件**（10 改 + 4 新增） |
| `git diff --cached --check` | `0` | 暂存后复核，无空白符错误 |

关于那 1 个 skip：是 `tests/executor/windows-integration.test.ts:571` 的
`it.skipIf(!enabled)`，为**既有的平台门控测试**，非本次新增，也未通过降低标准来换取绿灯。

### 3.1 新增测试计数

| 文件 | 用例数 | 结果 |
| --- | --- | --- |
| `tests/executor/daemon.test.ts`（新增） | 37 | 全通过 |
| `tests/executor/http-transport.test.ts`（含 2 个新回归） | 48 | 全通过 |

### 3.2 测试覆盖与交接单 §5 的对应

| §5 要求 | 覆盖用例 |
| --- | --- |
| 启动配置完整/缺失 | `§1 齐全时装配成功`、`缺 token → MissingConfigError 列出全部缺失项`、`缺模型 → 明确报错` |
| 注册成功与身份不匹配 | `§2 注册成功 → 进入领取循环`、`身份不匹配（403）→ registration_rejected，且不领取任何任务` |
| 空队列轮询 | `§3 空队列按上限轮询后正常退出`、`空队列之后领到任务 → 空闲计数重置` |
| 领取成功且重试复用幂等键 | `§4 同一轮次网络重试复用同一个幂等键`、`不同轮次必须换新键` |
| 续租/心跳/执行/上报顺序 | `§5 跨边界顺序：领取 → 编排(续租/心跳/agent) → 推送 → 上报` |
| 401/403、409、429、网络中断 | `§6` 共 6 例（含 `429 之后恢复`、`429 持续`、`上报遇 409`） |
| 租约失效后不推送、不上报 | `§7 sideEffectsSkipped`、`版本绑定缺项 → 拒绝开工（不上报伪造结果）` |
| 优雅停止与重启恢复 | `§8` 共 6 例（取消前置位/运行中取消/四个恢复分支） |
| 日志中不出现 Bearer Token | `§9` 共 3 例，其中一例**故意把 token 打进日志字段**以证明脱敏真的生效 |
| Windows 中文与空格路径 | `§10` 共 3 例，含真实临时目录读写往返 |

---

## 四、TLS / 凭据交接

### 4.1 `B-token-public.cer` 已生成

按交接单 §6.1 执行，证书位于 `C:\Users\lenovo\Desktop\B-token-public.cer`（797 字节，DER）。

| 项 | 值 |
| --- | --- |
| Subject | `CN=DualAgent-B-Token-Handoff` |
| 指纹 (SHA-1) | `893EA59AAAFC83C66DB2273E386DBDB92B7F39DF` |
| 有效期至 | `2026-09-29T17:14:54+08:00`（7 天） |
| 密钥 | RSA 2048，`Microsoft Software Key Storage Provider` |
| 私钥可导出性 | **`私钥不能导出`**（`certutil -user -store My` 原文）；`keyExportPolicy=None` |

独立佐证：`certutil` 同时报告 **`通过了加密测试`**，说明该密钥可用于解密 A 端回传的 CMS 密文。
公钥证书只含公钥（RSA 2048 bits，EKU = 文档加密 `1.3.6.1.4.1.311.80.1`），
**未导出 PFX、未导出私钥**，私钥保留在 `Cert:\CurrentUser\My`。

`.cer` 位于仓库之外，无法被 Git 跟踪；仓库内 `.cer/.p7m/.pfx/.key/.pem` 检出为 0 项。

### 4.2 尚缺：`B-executor-token.p7m`

A 端回传后，B 端将直接解密到内存、以 DPAPI `SecureString` 形式保存到本机受限目录，
运行时**只注入当前进程**的 `COORDINATOR_API_TOKEN`。不写入 `.env`/JSON/Markdown/注册表。

---

## 五、未完成项与阻塞项

### 5.1 明确「未实际执行」的事（不得当作已完成）

- **未对真实 Worker 发起任何 HTTP 请求**：未调 `/v1/health`、未注册、未领取。
  所有网络行为均在假体或本地集成测试中验证。
- **未使用真实 Token**：`.p7m` 未收到，`COORDINATOR_API_TOKEN` 从未注入。
- **未做双机联调**：无任何服务端状态或真实 attempt 记录产生。
- **未在常驻入口中真实调用 OpenCode**：`runAttempt` 走的是注入的 `attempt_runner`；
  OpenCode 的真实调用由既有适配器/集成测试覆盖，未在 daemon 内端到端实跑。
- **未做 P5 场景**：断网、租约过期、旧 epoch、认证失效、自动返修均未真实演练。

### 5.2 阻塞项

- `PROJECT_ID`、`<TARGET_REPO_URL>`、最小任务图——均由 A 端提供，B4 起未获得。
- `B-executor-token.p7m`——未获得，P3 无法开始。

按交接单 §7，在上述信息到位前，B4 开发、本地测试、Worker 健康检查与执行器注册
均可完成；**未伪造任何真实任务执行成功**。

---

## 六、下一步

1. ✅ 已推送 `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4` 并报告 HEAD SHA（交接单 §8 第 1–2 步）。
2. 等 A 端独立审查并整合 B4。
3. A 端返回 `B-executor-token.p7m` 后，完成安全接收 + 健康检查 + 注册（§8 第 4–5 步）。
4. A 端提供 `PROJECT_ID`/任务图/`<TARGET_REPO_URL>` 后进行 P3。
