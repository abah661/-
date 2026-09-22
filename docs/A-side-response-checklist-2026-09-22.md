# A 端对 2026-09-22 待回复清单的答复

## 1. 领取任务

- 路径：`POST /v1/projects/<project_id>/tasks/lease`。
- 请求体：`protocol_version`、`executor_id`、单个 `agent_kind`、`capabilities`、`idempotency_key`。
- `agent_kind` 不是列表；执行器注册时声明自己的单一适配器种类。
- 成功：`200 { task, lease }`。
- 无任务：`200 { task: null, lease: null, status: "empty" }`。
- 重试同一请求必须复用同一幂等键；同键不同请求体返回冲突。
- 同一项目的领取由单个 Durable Object 事务串行化，服务端保证 V02。
- 默认租约 180 秒，实际到期时间始终以响应 `lease.expires_at` 为准；第一次续租原样带回服务端返回的 `lease_epoch`。
- `write_scope` 属于返回的任务，不由领取方在请求中自报。

## 2. CP-0001 行为

- 认证失败在进入 Durable Object 前返回 `401`；Bearer 身份与 `executor_id` 不一致返回 `403`。
- `409` 只用于租约/epoch/路径与请求体不一致等已确认冲突，不用于 token 过期。
- heartbeat 使用幂等去重。每个周期使用新键；同一次 HTTP 重试复用原键。
- 当前 A 端状态存储对相同键持续去重，不是短时间窗口。B 的递增 heartbeat 键符合约定。

## 3. 基线分叉决策

A 任务分支已经公开推送，rebase 会改写历史并需要强制推送。A 端选择：

1. GitHub 连接恢复后，将当前 `origin/main` **合并到 A 任务分支**，不 rebase、不强制推送；
2. 由 A 在合并分支统一解决 `package.json/package-lock.json/tsconfig.json`；
3. 执行 `npm ci`、`npm run check`、Wrangler dry-run；
4. 通过后正常推送任务分支并让 CI 复验。

截至本文生成时，终端到 GitHub 443 仍不可达，无法 fetch 和核对清单所述 `2b80674`；
因此尚未执行合并，也未声称已取得 B 的 `00a1acf/2b80674`。

## 4. 正式接口路径

正式支持 B 已实现的路径：

- `GET /v1/health`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/lease/renew`；
- `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/ownership`；
- `POST /v1/projects/<project_id>/tasks/<task_id>/attempts/<attempt_id>/result`；
- `POST /v1/projects/<project_id>/tasks/lease`。

A 原有短路径继续作为兼容别名。B 使用 `encodeURIComponent(project_id)` 正确；未编码的 `/`
不能出现在路径段中。嵌套路径标识必须与请求体字段一致。

## 5. 资料清单

确认 B 的 JSON 假设，正式格式见 `docs/materials-manifest-v1.md`。

## 6. CI 覆盖

- 当前 CI 执行根目录 `npm ci` 与 `npm run check`。
- Vitest 配置包含 `tests/**/*.test.ts`，所以合并后的 `tests/executor/**` 会执行。
- 当前 A 分支的根 `tsconfig.json` 尚未引用 `apps/executor`，因此**目前不能声称 executor typecheck 已覆盖**。
- 合并 B main 后由 A 添加/核对 `apps/executor` project reference，再以 CI 实际结果为准。
