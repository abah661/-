# B 端 → A 端：待确认接口问题（阻塞 B 端常驻入口实现）

> 用途：B 端 P2 的三项（公共内核、OpenCode 适配器、结果归一化）已完成并推送
> （`5bc8048`），但**常驻进程入口 `apps/executor/src/index.ts` 尚未接通**，
> 因为它依赖协调器 HTTP 客户端。以下 4 个问题需 A 端答复后 B 端才能继续。
>
> 这 4 项即交接文档 `docs/protocol-v1-freeze-and-handoff.md` §8 中
> A 端待回应的接口问题，此处补充 B 端视角的具体需要。

## 背景：B 端已备好的接口

B 端没有等这些答案就停手，而是把依赖抽成三个**接口**，
实现待接口确定后补上：

```ts
// apps/executor/src/core/lease.ts
interface LeaseTransport {
  renew(task_id, attempt_id, lease_epoch): Promise<RenewOutcome>;
}

// apps/executor/src/core/heartbeat.ts
interface HeartbeatTransport {
  send(payload: HeartbeatPayload): Promise<void>;
}

// apps/executor/src/core/recovery.ts
interface RecoveryTransport {
  queryOwnership(task_id, attempt_id): Promise<TaskOwnership>;
}
```

同时已定义好 B 端**期望的语义**（这些是 B 端已实现的判定逻辑，
A 端若能确认或纠正，可直接决定接口形状）：

| B 端语义 | 含义 | 对应 B 端行为 |
| --- | --- | --- |
| `renewed` | 续租成功，附新 `expires_at` 与 `lease_epoch` | 记住新 epoch，继续 |
| `lost(lease_epoch_stale)` | 本执行器已被顶替 | **立即停子进程**，不再推送/上报 |
| `lost(lease_expired)` | 租约已过期 | 同上 |
| `lost(not_lease_holder)` | 服务端认为本执行器非持有者 | 同上 |
| `still_mine` | 恢复时查询：租约仍归我 | 校验 epoch 一致后 `resume` |
| `reassigned(to_executor, attempt_id)` | 恢复时查询：已派给别人 | **完全放手，不推送** |
| `unreachable` | 云端不可达 | **停止新操作**（第 7 节），不猜 |

## 问题 1：请求体形状与幂等键

**需要**：`lease` / `renew` / `heartbeat` / `report_result` 四个端点的
请求体 JSON 形状。

**B 端具体关注**：

1. 幂等键怎么传？协议里有 `IdempotencyKeySchema { scope, key }`，
   是放在请求头、还是请求体字段？`scope` 的取值约定是什么
   （如 `"lease"` / `"renew"` / `"report"`）？
2. 协议 `Lease` 的 `lease_epoch` 是**服务端分配**的。B 端领取后第一次续租
   应带哪个值——服务端返回的那个，还是从 1 开始？
3. `report_result` 是否要求同时带 `attempt_id` **和** `lease_epoch`？
   B 端理解是**两者都要**（V08：旧 epoch 的报告不能成为有效成果），请确认。
4. 请求体是否需要 `protocol_version` 字段？协议 schema 的
   `ResultReport` 里有 `protocol_version`，但其他请求体形状未见定义。

## 问题 2：认证方式

**需要**：执行器如何认证到 Worker API。

**背景约束**（AGENTS.md 规则 5 / 第 11 节）：

- 凭据**本地注入**，不进仓库、不进日志。
- 第 11 节明确「身份由认证映射」，`ExecutorRegistration.host_label`
  **不参与认证**。

**B 端具体关注**：

1. 是长期 token、还是需要先换取短期凭据？若是后者，换取端点与刷新时机？
2. token 放哪个请求头（`Authorization: Bearer`？）；
3. **凭据注入方式**：B 端倾向从环境变量读取
   （`process.env`，由用户在本地设置），A 端是否认可？
   B 端**不会**把凭据写入任何配置文件或提交到仓库。

## 问题 3：GitHub App 权限范围

**需要**：B 端执行器推送任务分支时，用谁的凭据？

**背景**（第 4.1 节）：B 端角色是「被授权协作者」。
协议里能力标签有 `git_push`（已被授权推送任务分支）。

**B 端具体关注**：

1. B 端是**直接用自己账号**推送，还是通过 A 端配置的 GitHub App？
   若用 App，B 端需要拿到 installation token——**这个 token 谁来签发、
   如何交给 B 端**（必须走本地注入，不能经云端或仓库传递）？
2. 推送目标分支名的约定。AGENTS.md 第 3.1 节提到
   `task/<TASK_ID>/<ATTEMPT_ID>`，B 端按此实现，请确认格式无误。
3. 推送后「核对远程提交号」（第 8 节步骤 7）——是 B 端自己 `git ls-remote`
   核对，还是要向 Worker 上报让服务端核对？

## 问题 4：DO URL 路由方案

**需要**：Worker 如何把请求路由到 Durable Object。

**B 端具体关注**：

1. B 端只知道 Worker 的基址。是**路径**区分（如
   `/projects/<id>/tasks/<id>/lease`）、还是请求头、还是查询参数？
2. 同一项目的请求是否保证路由到同一个 DO 实例（第 P5 节：
   「同一项目一次仅整合一个批次」）？B 端是否需要自己保证这一点，
   还是靠 Worker 保证？
3. 是否需要处理 **DO 重定向/重试**（如 `429` 或 `5xx` 时的重试语义）？
   B 端目前对网络异常的处理是「连续失败达阈值才判租约丢失」，
   若 A 端有特定重试约定（如 `Retry-After`），请在答复中说明。

## 附：一个已确认的实测约束（供 A 端参考，无需答复）

B 端实测确认：`opencode run` **必须显式传 `-m <provider>/<model>`**。
不带 `-m` 时会落到环境变量里的 provider，实测返回
`401 APIError "Invalid token"`（`isRetryable: false`）。

因此 B 端适配器把 `model` 设为**必填，缺省即抛错**，
不留「静默走错 provider」的空间。这条已写入
`apps/executor/src/adapters/opencode.ts`，A 端若实现 Codex 适配器的
归一化对接时需注意：两类适配器的 `blocked_auth` 判定应当同义。

## 优先级建议

| 问题 | 阻塞程度 | 说明 |
| --- | --- | --- |
| 1 请求体形状 | **高** | 不答复则 HTTP 客户端无法动工 |
| 2 认证方式 | **高** | 同上；且涉及凭据注入约定 |
| 4 DO 路由 | **中** | 影响客户端结构，但可先按路径方案假设实现 |
| 3 GitHub 权限 | **中** | 只影响推送环节，可后补 |

**B 端打算**：若 A 端未答复，B 端将按「路径路由 + Bearer token +
环境变量注入」的**假设**先实现一版 HTTP 客户端，
并在代码中把假设点标注清楚，待答复后修正。
如需 B 端先按假设推进，请告知。
