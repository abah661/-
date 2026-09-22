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

1. 已获取 `origin/main` 最新提交 `ae659a9`，其中包含 `00a1acf`、`5bc8048`、`2b80674`；
2. 已将 `origin/main` 合并到 A 任务分支，不 rebase、不强制推送；
3. 已解决 README、CP-0001、协议变更表和根 `tsconfig.json` 四处冲突；
4. 已由 A 统一重生成 `package-lock.json`，随后 `npm ci` 成功；
5. `npm run check` 实际通过：18 个测试文件，358 passed、1 skipped；
6. Wrangler dry-run 退出码 `0`。

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

- 当前 CI 执行根目录 `npm ci` 与 `npm run check`，并使用 Linux、Windows 双平台矩阵。
- Vitest 配置包含 `tests/**/*.test.ts`，所以合并后的 `tests/executor/**` 会执行。
- 根 `tsconfig.json` 已引用 `apps/executor`，executor 已进入 `tsc -b`。
- 首次合流 CI `35684998820` 已执行但失败，真实原因有两个：浅克隆缺少冻结提交；Windows 路径断言在 Linux 上按 POSIX 语义执行。
- 修复方式：checkout 使用 `fetch-depth: 0`；Windows 路径断言只在 Windows 执行；CI 新增 `windows-latest`，不修改 B 的执行器内核。
- 第二次 CI `35689026986` 的 Linux 任务成功；Windows 任务发现 `listWorktrees()` 在默认 `core.quotePath=true` 时不能处理中文路径，因此整体仍失败。
- B2 分支提交 `c05b4ff` 改用 `git worktree list --porcelain -z` 并按 NUL 解析；A 已审查范围并合并，不依赖或修改用户全局 Git 配置。
- B2 合流后的 Windows 专项复验为 40 passed、1 skipped；完整本地检查为 18 个测试文件、359 passed、1 skipped，二者退出码均为 `0`。
- 第三次 CI `35691574191` 的 Linux 任务成功；Windows 任务证明 NUL 解析有效，但 GitHub runner 的 8.3 短路径与 Git 返回的长路径仍被字符串比较误判，因此整体仍失败。
- B3 分支提交 `1256fed` 对均已存在的路径使用 Windows 文件系统真实路径规范化后严格比较；未删除断言、未放宽为仅检查目录存在、未修改生产 `isInside()` 语义。
- B3 合流后的完整本地检查为 18 个测试文件、359 passed、1 skipped，退出码 `0`；CI `35697451409` 的 Linux 与 Windows 均为 `success`。

## 7. Cloudflare 测试环境

- Worker `dual-agent-coordinator-test` 已部署，URL 为 `https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev`。
- Durable Object `PROJECTS` 与 SQLite migration `v1` 已生效。
- 两个认证 Secret 已注入；Token 不进入仓库、日志或文档，本地副本由 Windows DPAPI 加密。
- 首次真实闭环发现 Durable Object 构造参数错误，提交 `a0d80d9` 修复后，CI `35701070953` 的 Linux 与 Windows 均为 `success`。
- 重新部署版本 `f318a0e7-72fc-45c4-a2db-7cbcb143da20` 后，注册 A/B、提交任务图、领取、续租、心跳、归属查询、结果回报和最终状态查询全部成功。
- P4 已完成；P3 的真实双机联调和 P5 的自动返修/故障验收仍未完成。
