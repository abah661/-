# A 端对 B 端 HTTP 接口问题的答复（v1）

日期：2026-09-21  
适用范围：B 端常驻执行器 HTTP 客户端  
状态：A 端参考实现与测试已完成；`CP-0001` 待 B 端确认，尚未视为双方冻结

## 基线说明

A 端已本地核对冻结锚点：

```text
git rev-parse a577d6688b323afbdbc647b3a1288c0316f7fb1e:packages/protocol
f9644c44628d5fe8445bcbbb54ad336d7fbe0abc
```

该值与 B 端交接文档一致。冻结记录提交 `00a1acf` 和 B 端实现提交 `5bc8048`
当前尚未进入 A 端对象库，GitHub 连接恢复后仍需拉取并核对。本文涉及新增 heartbeat、
ownership 与执行器身份映射，已登记为 `docs/proposals/CP-0001-executor-http-transport.md`；
在 B 端确认前只作为 A 端参考实现，不修改 `packages/protocol/**`，也不宣称双方已冻结。

## 统一规则

- 基址：`<COORDINATOR_BASE_URL>`。
- 项目路由：`/v1/projects/<project_id>/...`。
- 除 `GET /health` 外，全部请求使用 `Authorization: Bearer <token>`。
- B 端从环境变量 `COORDINATOR_API_TOKEN` 读取自己的 token；不写配置文件、不进日志、不进仓库。
- Bearer token 在 Worker 端映射到唯一 `executor_id`，请求体不得冒充另一执行器。
- 写请求的 `idempotency_key` 放在 JSON 请求体中。scope 不由客户端传，服务端按路由固定添加。
- `protocol_version` 在所有执行器写请求中固定为字符串 `"1"`。

## 1. 请求体与幂等

### 注册

`POST /v1/projects/<project_id>/executors/register`

请求体使用 `ExecutorRegistrationSchema`。注册幂等键由服务端固定为
`register_executor:<executor_id>`，客户端不另传。

### 领取

`POST /v1/projects/<project_id>/tasks/lease`

```json
{
  "protocol_version": "1",
  "executor_id": "EXE-B-...",
  "agent_kind": "opencode",
  "capabilities": ["code", "test", "git_push"],
  "idempotency_key": "<client-generated-unique-key>"
}
```

成功响应为 `{ "task": TaskNode, "lease": Lease }`；无任务时为
`{ "task": null, "lease": null, "status": "empty" }`。
第一次续租必须原样带回领取响应中的 `lease_epoch`，不得自行从 1 推算。

### 续租

`POST /v1/projects/<project_id>/tasks/renew`

```json
{
  "protocol_version": "1",
  "task_id": "TASK-0001",
  "attempt_id": "TASK-0001-A1",
  "executor_id": "EXE-B-...",
  "lease_epoch": 1,
  "idempotency_key": "<client-generated-unique-key>"
}
```

成功返回更新后的完整 `Lease`。`LEASE_EPOCH_STALE`、`LEASE_EXPIRED`、
`NOT_LEASE_HOLDER` 都表示 B 端必须立即停止子进程，不再推送或上报。

### 心跳

`POST /v1/projects/<project_id>/executors/heartbeat`

```json
{
  "protocol_version": "1",
  "executor_id": "EXE-B-...",
  "state": "running",
  "task_id": "TASK-0001",
  "attempt_id": "TASK-0001-A1",
  "lease_epoch": 1,
  "sent_at": "2026-09-21T00:00:30.000Z",
  "idempotency_key": "<client-generated-unique-key>"
}
```

`state` 取 `idle | running | stopping`。`running` 必须带完整租约三元组；
`idle` 可将三项都设为 `null`。心跳只记录存活状态，**不代替续租**。

### 回报结果

`POST /v1/projects/<project_id>/tasks/report`

请求体严格使用 `ResultReportSchema`，必须同时携带 `attempt_id`、`executor_id`
和 `lease_epoch`。旧 epoch 报告返回 `409 LEASE_EPOCH_STALE`。

报告不增加单独的 `idempotency_key` 字段；服务端使用
`report_result:<task_id>:<attempt_id>:<lease_epoch>` 作为确定性幂等键。

## 2. 认证

- v1 使用长期、每执行器独立的 Bearer token；首版没有换取短期 token 的端点。
- 请求头：`Authorization: Bearer <token>`。
- B 端本地环境变量名：`COORDINATOR_API_TOKEN`。
- Worker 端映射通过 Cloudflare secret `COORDINATOR_EXECUTOR_TOKENS_JSON` 注入。
- token 轮换后由用户更新本机环境变量并重启执行器；`401` 映射为 `AUTH_EXPIRED / blocked_auth`。
- `host_label` 只用于展示，不参与认证。

## 3. GitHub 身份与远端核对

- v1 不向 B 分发 GitHub App installation token。
- B 使用自己已获协作者权限的 GitHub 账号，通过本机 Git Credential Manager 登录；凭据不经 A、Worker 或仓库传递。
- 分支格式确认：`task/<TASK_ID>/<ATTEMPT_ID>`。
- B 推送后先用 `git ls-remote` 核对远端 SHA，再在 `ResultReport.commit_shas/head_sha` 中上报。
- A 端固定提交整合流程会独立回查远端 SHA 和受信任 CI；不只依赖 B 的自报结果。

## 4. Durable Object 路由与恢复

Worker 使用路径中的 `project_id` 调用 `idFromName(project_id)`，所以同一项目始终进入同一个 DO。
B 不需要理解或保存 DO 实例 ID，也不会收到 DO 重定向。

重启恢复查询：

```text
GET /v1/projects/<project_id>/tasks/ownership
  ?task_id=TASK-0001
  &attempt_id=TASK-0001-A1
  &executor_id=EXE-B-...
  &lease_epoch=1
```

仍持有时返回 `ownership: "still_mine"` 和当前完整租约字段。
不再持有时返回 `ownership: "reassigned"`，并附 `reason`、当前
`to_executor/attempt_id/lease_epoch`；没有当前租约时三项为 `null`。
`unreachable` 是 B 端本地网络状态，不是服务端 JSON 值。

重试规则：

- 网络错误、`429`、`502/503/504`：指数退避加抖动；有 `Retry-After` 时优先遵守。
- `401/403`：停止业务操作，进入 `blocked_auth`，不得按代码失败返修。
- `409` 租约类错误：不重试当前操作，立即停止子进程并查询归属。
- `400/422`：请求或契约错误，不做盲目重试。
- 本地时间达到服务端 `expires_at` 前仍未续租成功：按租约丢失处理，不猜测所有权。

## B 端可立即推进的实现

B 可按本文接通常驻入口，不需要等待 Cloudflare 部署。先以 mock/base URL 做客户端契约测试；
真实双机联调在测试 Worker 成功部署后进行。OpenCode 的 `model` 必填约束保持不变，
其 `401 Invalid token` 与 Codex 适配器都归一化为 `AUTH_EXPIRED / blocked_auth`。
