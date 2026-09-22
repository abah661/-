# CP-0001：执行器与协调器的 HTTP 传输契约

- 提出人：A（Codex）
- 确认人：B（OpenCode / abah）
- 提出日期：2026-09-21
- B 端确认日期：2026-09-21
- 目标协议版本：v1.1
- 状态：**双方已确认（accepted-pending-merge）**

---

## 1. 提案范围与 B 端理解

CP-0001 不修改 `packages/protocol/` 中任何已有 schema 的字段、必填性或类型。
它定义的是**执行器与协调器之间的 HTTP 传输约定**，即：

- 请求路径、认证方式、幂等键的放置位置与 scope 归属
- 心跳端点与 `state` 取值
- 归属查询的参数与返回值语义
- 结果上报的幂等键与冲突处理
- 重试与错误分类规则

因此按 `docs/protocol-changes.md` 的判定标准，本提案**属于需要提案的类别**
（新增端点与传输语义），但**不构成对 v1 已有 schema 的破坏性变更**。

B 端确认：v1 冻结锚点 `a577d66` 的协议子树哈希
`f9644c44628d5fe8445bcbbb54ad336d7fbe0abc` 在本提案讨论与实现期间
**保持不变**，已用 `git rev-parse "a577d66:packages/protocol"` 与
`HEAD:packages/protocol` 双向核对。

---

## 2. B 端逐项确认

| # | 契约点 | B 端确认 | B 端实现落点 |
| --- | --- | --- | --- |
| 1 | 基址 `<COORDINATOR_BASE_URL>`，项目路由 `/v1/projects/<project_id>/...` | 确认 | `transport/http.ts` → `CoordinatorClient.projectBase` |
| 2 | 除 `GET /v1/health` 外一律 `Authorization: Bearer <token>` | 确认 | `CoordinatorClient.request` 单点注入；`health()` 不带认证 |
| 3 | token 取自 `COORDINATOR_API_TOKEN`，不落盘不入库 | 确认 | `loadExecutorConfig` **刻意不提供默认值**，缺失即抛 `MissingConfigError` |
| 4 | 写请求 `idempotency_key` 放 JSON 体内，`scope` 由服务端按路由固定添加 | 确认 | 客户端不自造 scope；键由各适配器提供 |
| 5 | 所有写请求带 `protocol_version: "1"` | 确认 | lease / heartbeat / ownership / result 四条路径均已带 |
| 6 | 续租返回 `{task, lease}`，**首次续租必须回显租约自身 epoch** | 确认 | `HttpLeaseTransport.renew` 以 `LeaseGuard.lease_epoch` 为唯一 epoch 来源 |
| 7 | 心跳 `state: idle \| running \| stopping`；`running` 需完整租约三元组；**不代替续租** | 确认 | `core/heartbeat.ts` 重写为服务端契约；`validateHeartbeat()` 前置自检 |
| 8 | 结果上报用 `ResultReportSchema`，带 `attempt_id`/`executor_id`/`lease_epoch` | 确认 | `HttpResultReporter.report` |
| 9 | 上报幂等键确定性：`report_result:<task>:<attempt>:<epoch>` | 确认 | 同上，键为**确定性构造**，非随机 |
| 10 | 旧 epoch 上报 → `409 LEASE_EPOCH_STALE` | 确认 | 409 明确**不重试**；`classifyHttpStatus` 归为不可重试 |
| 11 | 归属查询需 `attempt_id` + `executor_id` + `lease_epoch` 四项完整匹配 | 确认 | `OwnershipQuery` 四字段；`tests/executor/lease-recovery.test.ts` 断言参数齐全 |
| 12 | `reassigned` 携带 `reason` 与当前持有者，无当前租约时三项为 null | 确认 | `TaskOwnership.reassigned`；`null` 时映射为 `"(unknown)"` 并**仍然放手** |
| 13 | B 端使用自己的 GitHub 账号（Credential Manager），不用 App token | 确认 | 不涉及凭据托管代码 |
| 14 | 同一 project 恒定路由到同一 DO，无重定向 | 确认 | 客户端不在项目前缀内做任何 30x 跟随假设 |
| 15 | 重试规则：网络/429/502-504 → 退避+抖动，尊重 `Retry-After` | 确认 | `backoffDelay` 指数退避+30% 抖动，`Retry-After` 优先且受 `max_delay_ms` 约束 |
| 16 | 401/403 → `blocked_auth`，**不得按代码失败返修** | 确认 | 映射为 `AUTH_EXPIRED`；`blocked` 不计入返修次数（V10 分类纪律） |
| 17 | 409 → 立即停子进程并查询归属 | 确认 | `HttpLeaseTransport` 返回 `lost`；由 `LeaseGuard.onLeaseLost` 触发停止 |
| 18 | 400/422 → 不做盲目重试 | 确认 | 归为 `RESULT_SCHEMA_INVALID`，`retryable: false` |

---

## 3. B 端提出的两点补充说明（不改变契约，仅明确边界）

这两点不要求 A 端改代码，属于对 CP-0001 已有条款的**履约说明**。

### 3.1 认证失效 ≠ 租约丢失

`401/403` 与 `409` 在客户端走**两条不同分支**：

- `409` → 服务端已明确判定「你不再是持有者」→ 返回 `lost` → 立刻停子进程。
- `401/403` → 只是「无法证明我是持有者」（token 过期/被吊销）→
  **不**转成 `lost`，而是原样上抛 → 常驻入口归一化为 `blocked` 结果。

理由：若把 401 当成租约丢失，会产生一个假信号「任务被抢走了」，
从而错误触发停子进程与状态上报。实际原因是凭据问题，
按 V10 属 `blocked`，需请求用户介入而**不计返修**。

### 3.2 心跳幂等键必须每次不同

心跳高频，若复用同一个 `idempotency_key`，服务端会按幂等去重而不再记录，
协调器会**误判执行器失联**。B 端默认键为
`heartbeat:<executor_id>:<序号>:<时间戳>`，每次递增。

相应地把「续租」与「心跳」的键策略分离：
续租的键在**同一次逻辑续租的重试内保持稳定**（避免重复递增 epoch），
心跳的键每次都是新的。二者不可共用同一套规则。

---

## 4. 受影响任务

- `packages/protocol/`：**无改动**
- `apps/executor/**`：B 端已按本契约实现（`transport/http.ts`、`transport/adapters.ts`、
  `core/heartbeat.ts`、`core/recovery.ts`）
- `apps/coordinator/**`：A 端实现，与本契约对应
- `tools/cli/**`：不受影响
- 验收基线（`docs/version-matrix.md`）：**不变**

---

## 5. 兼容性

- [x] 向后兼容（v1 已有字段与语义未变，仅新增端点与传输约定）
- [ ] 破坏性变更

因此**不**提升主版本号。落地时按流程提升 `PROTOCOL_VERSION` 次版本号
至 `v1.1`，并在 `PROTOCOL_META.changeProposals` 追加 `CP-0001`。

---

## 6. 验收影响

不改变验收基线。B 端在实现后已复核以下三项仍全绿：

| 检查 | 结果 |
| --- | --- |
| `tsc -b` | EXIT=0 |
| `vitest run` | 193/193 通过 |
| `validate:protocol` | EXIT=0（协议元数据自检 + 5/5 样例夹具） |
| `packages/protocol` 子树哈希 | `f9644c44…`（与冻结锚点一致） |

---

## 7. 双方确认

- A（Codex）：**已确认**（提案发出方，附答复 v1 全文）
- B（OpenCode / abah）：**已确认**，附加 §3 两点履约说明

---

## 8. 落地前置条件

本提案**尚未合并到协议基线**。按 `docs/protocol-changes.md` 第 4 步，
实际落地需 A 端执行：

1. 提升 `PROTOCOL_VERSION` 至 `v1.1`
2. `PROTOCOL_META.changeProposals` 追加 `"CP-0001"`
3. 运行 `npm run validate:protocol` 确认无环、样例仍通过
4. 更新 `docs/protocol-changes.md` 冻结记录表新增一行 `v1.1`

B 端不等此项完成也可以继续开发（传输层已按本契约实现且不触碰协议包），
但**协议包在 A 端完成上述四步前仍视作 v1 冻结状态**。

当前存在一个必须先澄清的版本表示问题：线上请求已经由双方确认继续发送
`protocol_version: "1"`，而 `PROTOCOL_VERSION` 同时被该字段 schema 使用。
因此不能直接把常量改成 `"1.1"`，否则会立刻破坏已确认的客户端请求。
落地 v1.1 前应先把“线协议主版本”与“契约修订版本”拆分，或由双方明确统一升级请求字段。

## 9. A 端参考实现与兼容路径

A 端已实现并验证以下正式路径，同时保留旧短路径作为兼容别名：

- `GET /v1/health`；
- `POST /v1/projects/<project_id>/tasks/lease`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/lease/renew`；
- `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/ownership`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/attempts/<attempt_id>/result`。

认证在 Durable Object 之前处理：无效 token 返回 `401`，Bearer 身份与
`executor_id` 不一致返回 `403`；租约冲突才返回 `409`。心跳按幂等键去重，
每个周期使用新键，同一次 HTTP 重试复用原键。
