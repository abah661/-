# 协议 v1 冻结确认与 A 端实现交接

- 日期：2026-09-21
- 确认方：B 端（OpenCode）
- 协议版本：**v1，状态 frozen**
- 冻结点提交（anchor）：`a577d6688b323afbdbc647b3a1288c0316f7fb1e`
- 该提交下协议子树哈希：`f9644c44628d5fe8445bcbbb54ad336d7fbe0abc`
- 冻结记录落盘提交：`00a1acf`

> **核对方式**：`git rev-parse a577d66:packages/protocol`
> 注意这是 **`packages/protocol/` 子树**的树哈希，不是仓库根树哈希
> （根树哈希是 `d6457c8`，两者用途完全不同——子树哈希只随协议包内容变化，
> 因此才能用来核对"协议未被悄悄改动"）。
> 这一区分已由 `tests/protocol/freeze.test.ts` 自动断言，防止再次混淆。
>
> **`a577d66` 是一个"冻结前"快照**：该提交里 `status` 仍是 `draft`。
> 冻结动作本身只改动了 `src/version.ts` 一个文件，其余协议文件自 `a577d66`
> 起逐字节未变——这一点由 `freeze.test.ts` 逐文件比对保证。
> 之所以不把"冻结后提交"当作 anchor，是因为写入冻结记录会改变子树哈希，
> 形成自引用（详见 §1.2）。

---

## 0. 这份文档解决什么

项目书 P1 要求"协议以固定提交冻结后，双方进入不同模块并行开发"。
本文是 B 端完成的核对结果与**给 A 端的实现交接单**，让 A 端可以立即开始：

1. Worker API 与 Durable Object
2. Codex 适配器
3. 需求管理 CLI
4. 固定提交整合与独立验收

**B 端核对结论：协议 v1 可实现，无阻塞项。** 详见第 2 节。

---

## 1. 冻结了什么

`PROTOCOL_META.status` 由 `draft` 改为 `frozen`，并记录提交号与树哈希。

冻结校验已加入 `validate-protocol`：

```
PASS  PROTOCOL_META
```

校验规则（`tools/validate-protocol/src/validate.ts`）：

- `frozen` 状态必须记录完整 40 位提交号
- 必须记录树哈希，否则无法核对协议未被悄悄改动
- `superseded` 状态必须记录导致取代的变更提案

**冻结守卫已自动化**（`tests/protocol/freeze.test.ts`，11 个测试）：

- 冻结提交在仓库中真实存在
- `frozenTreeSha` 等于**冻结点**下 `packages/protocol` 的子树哈希
- `frozenTreeSha` **不是**根树哈希（防止混淆）
- 冻结后协议包内容逐文件未变（**排除 `src/version.ts`**，见 §1.2）
- 冻结后协议包没有新增文件（同上）
- 工作区中协议包无未提交改动（同上）

**该守卫经过反向验证**：故意在 `status.ts` 追加一行注释后，
测试立即失败（`M packages/protocol/src/status.ts`）；用 `git checkout` 恢复后重新通过
（11 passed, EXIT=0）。即它确实能拦住未经提案的协议改动，不是摆设。

**冻结后规则**：任何字段增删或语义变化，必须走 `docs/protocol-changes.md` 的提案流程，
**不能由一端私自修改**。

---

## 1.1 冻结过程中的一处修正（供 A 端知悉）

首次记录冻结信息时，B 端误把**仓库根树哈希**记成了**协议子树哈希**。
核对时发现 `git rev-parse a577d66:packages/protocol` 与实际记录不一致，已修正。

同时补了两道防线：

1. `ProtocolMeta.frozenTreeSha` 的注释明确写清它是子树哈希及获取方法
2. `freeze.test.ts` 增加断言：`frozenTreeSha` 不得等于根树哈希

A 端实现时若要新增冻结相关字段，请沿用同一模式：
**记录可被机器核对的值，并写测试验证它**，而不是只写进文档。

---

## 1.2 冻结记录的"自引用"问题（A 端必读，否则会踩同一个坑）

冻结记录写在 `packages/protocol/src/version.ts` 里，而这个文件**本身就在被冻结的子树之内**。
于是"冻结点与 HEAD 的完整子树哈希必须相等"这条断言**必然失败**：
写下冻结信息的那一刻，子树哈希就已经变了。

```
git rev-parse a577d66:packages/protocol   → f9644c44628d5fe8445bcbbb54ad336d7fbe0abc  (冻结点)
git rev-parse HEAD:packages/protocol      → 5ed940d31beb5641d0b9d31ddf73f3700fe6da2e  (含冻结记录)
```

两者不等是**预期行为，不是错误**。正确做法是把校验拆成两件事：

| 校验目标 | 方法 |
| --- | --- |
| 记录本身没写错 | `frozenTreeSha === git rev-parse "<frozenAt>:packages/protocol"` |
| 冻结后没人偷改协议 | 逐文件比对 blob 哈希，**排除 `version.ts`** |

B 端已按此实现，并额外补了一条"没有新增文件"的检查
（逐文件比对只能发现"改"和"删"，发现不了"增"）。

> **给 A 端的建议**：如果 A 端也要在仓库里记录类似的"冻结/版本锚点"，
> 不要让锚点文件自己参与锚点哈希的计算，否则会陷入同一个自引用陷阱。
> 若确实需要单一哈希，用 `git write-tree` 排除该文件后再算，或把锚点放到被冻结目录之外。

---

## 2. B 端可实现性核对结果

按项目书第 13 节，B 端需"核对 Windows/OpenCode 可实现性，提供成功、失败、恢复样例"。

| 核对项 | 结论 | 依据 |
| --- | --- | --- |
| 任务/结果/事件 schema 字段完备 | ✅ 可实现 | `schemas.ts` 全部字段有明确类型与必填性 |
| 状态机可覆盖实际流程 | ✅ 可实现 | 正常路径 + 6 个异常状态，均已定义转移 |
| 错误分类可映射到实际故障 | ✅ 可实现 | 26 个错误码，四类处置策略 |
| 版本绑定四元组可获取 | ✅ 可实现 | 均为 git rev-parse 可得的 SHA |
| 租约与 epoch 语义明确 | ✅ 可实现 | `lease_epoch` 单调递增，旧 epoch 报告失效 |
| 中文路径 / 空格路径 | ✅ 已验证 | Syncthing 实测通过（见下） |
| 结果归一化到 `ResultReport` | ✅ 可实现 | 两类 agent 输出可映射到同一结构 |
| 样例夹具可复现 | ✅ 已验证 | 5 个夹具正反向校验全部符合预期 |

### 已验证的实际证据

B 端本机（Windows）已实测：

```
npm run check
→ typecheck: 通过（EXIT=0）
→ 协议校验: 5/5 PASS（含 3 个反向夹具正确拒绝）
→ 测试: 80 passed / 5 files（EXIT=0）
```

其中冻结守卫 11 个用例，**已做反向验证**：篡改 `packages/protocol/src/status.ts`
后立即失败并报出具体文件，`git checkout` 还原后恢复全绿。

中文路径处理已在 Syncthing 配置中实测通过（`state=idle`, `errors=0`），
证明 Windows 中文路径不会破坏文件与配置处理。

### 未发现需要提案的问题

协议 v1 直接可实现，**无需变更提案**。以下是实现时需要注意的**约定**，
不是协议缺陷，而是 B 端请 A 端在实现时对齐的行为：

1. `ready_for_integration` 的硬性门槛已在 schema 层强制
   （必须有证据、退出码 0、失败数 0、head ≠ base）。
   A 端**不需要**重复实现该判断，但**必须**在服务端再校验一次，
   因为执行器可能被绕过。
2. `repair_pending` 等失败状态**必须**带 `error_code`。
   A 端收到无 `error_code` 的失败报告应直接拒绝。
3. 版本绑定四项任一为空 → **不得开工**。A 端在 `lease_task` 时就要检查。

---

## 3. 给 A 端的实现清单

按项目书 P2 分工表，A 端负责：

### 3.1 Worker API（`apps/coordinator/src/routes/`）

项目书第 7 节建议的 API，与协议包的对应关系：

| API | 请求体 schema | 幂等作用域 |
| --- | --- | --- |
| 注册执行器 | `ExecutorRegistrationSchema` | `register_executor` |
| 提交需求 | 新建，需产出 `TaskGraphSchema` | `submit_requirement` |
| 领取任务 | 返回 `LeaseSchema` | `lease_task` |
| 续约 | 需 `lease_epoch` | `renew_lease` |
| 回报结果 | `ResultReportSchema` | `report_result` |
| 获取上下文 | 内置任务规则/契约/验收绑定 | （只读，无需幂等） |
| 提交契约提案 | 新建，见 `docs/protocol-changes.md` | `contract_proposal` |
| 查询状态 | 只读 | （只读） |
| 接收 GitHub 事件 | `EventEnvelopeSchema` | `github_event` |

**幂等作用域常量**：`IDEMPOTENCY_SCOPES`（`src/version.ts`）。
写请求必须携带幂等键，服务端按 scope 去重。

### 3.2 Durable Object（`apps/coordinator/src/do/project-do.ts`）

每个项目一个 DO，**领取和状态转移必须在事务中处理**（第 7 节）。

首版数据实体（第 7 节）：

```
项目 执行器 任务 尝试 租约 契约 消息 事件 整合批次 授权记录
```

**状态转移必须用协议包的函数**：

```ts
import { canTransition, assertTransition } from "@dac/protocol";

// 事务内
assertTransition(task.status, next); // 非法转移直接抛错
```

不要在 DO 里自己写一份转移表——那会导致两端判定不一致。

**领取的原子性**（验收 V02）：

```
同一任务并发领取 → 只产生一个有效领取
```

实现要点：在 DO 事务内比较并交换 `lease_epoch`。
分配新 `attempt_id` 时递增 epoch，**旧 epoch 的报告不能成为有效成果**（验收 V08）。

### 3.3 Codex 适配器（A 端独立模块）

B 端已定义好两侧接口契约，A 端照此实现即可：

**输入**（任务包，A 端从 DO 取出后交给 adapter）：

```
任务 ID、尝试 ID、基线 SHA、写入范围、契约引用、
验收条件、规则文档路径、超时上限
```

**输出**（归一化为 `ResultReportSchema`）：

```
status、head_sha、changed_files、evidence、error_code、commit_shas
```

**关键约定**（与 B 端一致，保证两端可互换）：

1. 以**固定程序和参数数组**调用 agent，不执行云端任意 shell 字符串（第 8 节）
2. **agent 说"完成"或退出码为 0 都不足以判定成功**（第 8 节步骤 8）
3. 必须由执行器/适配器自己跑测试并采集证据
4. 登录与配额失败映射到 `AUTH_EXPIRED` / `QUOTA_EXHAUSTED`，
   **不得**映射为 `TESTS_FAILED`（验收 V10）
5. 超时映射为 `AGENT_TIMEOUT`

**建议复用**：`packages/protocol/src/errors.ts` 的 `ERROR_POLICY`
是唯一判定依据。用 `isRepairable()` / `blockedStatusFor()`，
不要自己写 if-else 分支。

### 3.4 需求管理 CLI（`tools/`）

项目书第 6 节：用户通过管理 CLI 提交需求。

CLI 需要产出的第一件东西是 `TaskGraphSchema`：

```ts
import { analyzeGraph, TaskGraphSchema } from "@dac/protocol";

const graph = TaskGraphSchema.parse(planned);
const { order, problems } = analyzeGraph(graph);
if (problems.length > 0) {
  // 退回规划执行器修正，最多两次（DEFAULT_LIMITS.maxPlanRejections）
}
```

**直接复用 `analyzeGraph`**，它已实现：

- 环检测（含环上具体节点，便于错误提示）
- 字段完整性（验收条件、写入范围、能力声明）
- allow/deny 冲突检测
- 确定性拓扑排序（相同输入 → 相同批次顺序）

**并行判定**用 `canRunInParallel(a, b)`，已实现保守策略：
写入范围可能重叠即判定串行。用于满足 `maxConcurrentTasksPerExecutor = 1`。

### 3.5 固定提交整合与 CI

第 9 节的九步流程，与协议的对应：

| 步骤 | 协议字段 |
| --- | --- |
| 固定 main 基线、候选 head | `IntegrationBatchSchema.base_sha` / `candidate_heads` |
| 规则/契约/验收版本 | `rules_sha` / `contract_sha` / `acceptance_sha` |
| 受信任工作流 | `trusted_workflow`（不能是候选代码自带的工作流） |
| 记录 run ID | `ci_run_id` |
| 组合提交与树哈希 | `merged_sha` / `tree_sha` |
| 过期批次失效 | `conclusion: "superseded"`（验收 V07） |

**重要**：合并冲突立即记为失败，**不用强制选边掩盖冲突**（第 9 节步骤 5）。
映射到 `GIT_MERGE_CONFLICT`。

**不接受 agent 自报的 CI 成功**：必须回查 run 的仓库、工作流、批次和结论（第 9 节）。

### 3.6 独立验收测试

用协议包的常量断言，避免硬编码：

```ts
import {
  DEFAULT_TIMING, DEFAULT_LIMITS, validateTimingConfig, ERROR_POLICY
} from "@dac/protocol";
```

A 端应重点覆盖的验收项（对应的协议能力已就绪）：

| 编号 | 场景 | A 端需要实现的检查 |
| --- | --- | --- |
| V02 | 同一任务竞争 | DO 事务内的 epoch 比较交换 |
| V03 | 规则或契约不一致 | `analyzeGraph` + 版本绑定校验 |
| V06 | 虚假完成 | 服务端二次校验 `ResultReportSchema` |
| V07 | main 或候选变化 | 批次 `conclusion` 置 `superseded` |
| V08 | 断线与迟到回报 | 拒绝旧 `lease_epoch` |
| V09 | 重复或伪造回调 | 幂等键去重 + 签名验证 |
| V10 | 登录与配额失败 | `blockedStatusFor()` 分类阻塞 |
| V12 | 重启恢复 | DO 持久化状态 |
| V14 | 合并一致性 | 实际合并对象对应已测组合 |

---

## 4. 协议核心速查

### 4.1 状态机

```
draft → planning → ready → leased → running → validating
      → ready_for_integration → integrating → passed → merged

异常：repair_pending / blocked_auth / blocked_quota /
      blocked_approval / needs_input / cancelled
```

设计要点：

- `leased → running` 只能由持有当前 `lease_epoch` 的执行器推进
- `validating → passed` **只表示单任务自身契约通过**，
  完整功能仍必须由组合测试验收（P5）
- 任意非终态都可在授权下进入 `cancelled`
- `merged` / `cancelled` 是终态，无后继

### 4.2 版本绑定（规则 2）

```ts
{ base_sha, rules_sha, contract_sha, acceptance_sha }
```

四项缺一不可。任一为空 → 拒绝开工。运行途中任一项在远端变化 → 当前批次通过记录失效。

### 4.3 错误分类（验收 V10 的关键）

| 处置 | 含义 | 计入返修 |
| --- | --- | --- |
| `repairable` | 代码/工程类失败，自动派发返修 | ✅ 是 |
| `blocked` | 登录、配额、授权类，等待介入 | ❌ **否** |
| `retryable` | 执行器放弃本次尝试，协调器重派 | ❌ 否 |
| `fatal` | 终态失败，需人工判断 | ❌ 否 |

**登录过期与配额不足必须分别标记，不得按代码失败反复返修。**

### 4.4 默认参数（可调建议值）

| 参数 | 值 | 常量 |
| --- | --- | --- |
| 空闲轮询 | 15s + 随机延迟 | `DEFAULT_TIMING.pollIntervalMs` / `pollJitterMs` |
| 心跳 | 30s | `heartbeatIntervalMs` |
| 租约 | 180s | `leaseTtlMs` |
| 单任务超时 | 30min | `taskTimeoutMs` |
| 每台并发 | 1 | `DEFAULT_LIMITS.maxConcurrentTasksPerExecutor` |
| 返修上限 | 2 | `maxRepairAttempts` |
| 规划退回上限 | 2 | `maxPlanRejections` |
| 同项目并发批次 | 1 | `maxConcurrentBatchesPerProject` |

`validateTimingConfig()` 会检查一致性（心跳 ×3 ≤ 租约等）。
A 端改参数时必须跑它。

---

## 5. 项目书章节 → 实现位置对照

| 项目书 | 实现位置 | 状态 |
| --- | --- | --- |
| 第 5 节 规则 | `AGENTS.md` | ✅ B 端已写 |
| 第 6 节 契约与规划 | `packages/protocol/src/graph.ts` | ✅ 可复用 |
| 第 7 节 协议与生命周期 | `status.ts` / `schemas.ts` / `errors.ts` / `defaults.ts` | ✅ 已冻结 |
| 第 8 节 本地执行器 | `apps/executor/` | ⬜ B 端待实现 |
| 第 9 节 整合 | `apps/coordinator/src/batch/` | ⬜ **A 端待实现** |
| 第 10 节 Syncthing | `双端连接-sync/` | ✅ 已配置，待配对 |
| 第 11 节 授权 | `docs/authorization.md` | ✅ B 端已建 |
| 第 15 节 预算 | `docs/budget-and-limits.md` | ✅ B 端已拟 |

---

## 6. A 端开工建议顺序

按项目书 P2 与依赖关系：

1. **先读** `AGENTS.md` 与 `docs/protocol-changes.md`（1 小时内的量）
2. **协议包不要改**：`packages/protocol/` 维护者是 A，
   但它已冻结——要改先提 CP 提案
3. **Worker 骨架 + DO 骨架**，先跑通 `register_executor` 与 `submit_requirement`
4. **`lease_task` 事务**（最关键的并发点，验收 V02/V08）
5. **`report_result` + 服务端二次校验**（验收 V06）
6. **Codex 适配器**，与 B 端 OpenCode 适配器对齐输出结构
7. **CLI**，复用 `analyzeGraph`
8. **CI 与固定提交整合**（验收 V07/V14）

**建议同时做**：把 `npm run check` 接入 CI，
确保 A 端改动不会破坏协议基线。

---

## 7. 待 A 端回应的接口问题

以下不是阻塞项，但需要 A 端确认后才好实现对接：

1. **提交需求的请求体形状** — 协议包未定义（属于 API 层，非协议层）。
   A 端定义后请在 `docs/` 补充，B 端执行器不消费此接口，但 CLI 用户会。
2. **认证方式** — 执行器凭据的具体形式（Bearer token / 签名）。
   第 11 节要求"身份由认证映射，不能靠请求字段冒充"。
   确定后 B 端据此实现执行器认证。
3. **GitHub App 的权限范围** — 影响 B 端执行器推送时的授权校验逻辑。
4. **DO 的 URL 路由方案** — 影响 B 端轮询/心跳的目标地址。

---

## 8. 双方共同基线

| 项目 | 值 |
| --- | --- |
| 协议版本 | v1（frozen） |
| 冻结点提交（anchor） | `a577d6688b323afbdbc647b3a1288c0316f7fb1e` |
| 该提交下协议子树哈希 | `f9644c44628d5fe8445bcbbb54ad336d7fbe0abc` |
| 协议文件快照 | `packages/protocol/`（除 `src/version.ts` 外自冻结点起逐字节未变） |
| 验证命令 | `npm run check` |
| 基线状态 | **80 tests 全绿**，EXIT=0 |

> 第 P0 节要求"双方核对共同 SHA"。
> A 端克隆后请执行以下命令与本表核对：
>
> ```
> git rev-parse a577d66:packages/protocol
> # 期望：f9644c44628d5fe8445bcbbb54ad336d7fbe0abc
> ```
>
> **不要**用 `git rev-parse HEAD:packages/protocol` 来核对——HEAD 已包含冻结记录
> （记录写在 `version.ts` 里），该值必然不同。原因见 §1.2。
>
> **注意**：远程仓库当前**尚未推送**（GitHub 返回 401）。
> 在 B 端完成本机认证并推送前，A 端无法克隆。
