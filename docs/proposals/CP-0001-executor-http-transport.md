# CP-0001：执行器 HTTP heartbeat、租约归属查询与身份绑定

- 提出人：A（Codex）
- 提出日期：2026-09-21
- 目标协议版本：v1.1
- 状态：proposed

## 动机

B 端常驻入口已经抽象 `LeaseTransport`、`HeartbeatTransport` 和
`RecoveryTransport`，但冻结 v1 没有定义 heartbeat 请求体、恢复时的租约归属查询，
也没有规定 Bearer token 如何映射到 `executor_id`。缺少这些约定会阻塞 B 端 HTTP 客户端。

## 变更内容

1. 新增 `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat`。
2. 新增 `POST /v1/projects/<project_id>/tasks/<task_id>/ownership`。
3. 所有执行器写请求都携带 `protocol_version: "1"`。
4. heartbeat 增加服务端幂等 scope `executor_heartbeat`；客户端在请求体中传 `idempotency_key`。
5. Worker 将每执行器独立 Bearer token 映射到唯一 `executor_id`，拒绝身份不一致请求。
6. 细节与 JSON 示例以 `docs/B-to-A-interface-answers-v1.md` 为准。

## 受影响任务

- A：`apps/coordinator/src/api.ts`
- A：`apps/coordinator/src/worker.ts`
- A：`apps/coordinator/src/project-do.ts`
- B：`apps/executor/src/core/heartbeat.ts`
- B：`apps/executor/src/core/recovery.ts`
- B：常驻入口 `apps/executor/src/index.ts`
- 双方：HTTP 契约测试与真实双机验收批次

## 兼容性

- [x] 向后兼容：新增路由和可识别的执行器 token 映射，不改变已有结果报告字段。
- [ ] 破坏性变更。

旧版续租请求缺少 `protocol_version`；A 端参考实现已要求该字段。B 端尚未接入 HTTP 客户端，
因此当前没有已发布客户端需要兼容。

## 验收影响

不放宽既有验收门槛。新增验证：

- running 心跳必须携带完整租约三元组；
- 旧 epoch、过期租约或非持有者心跳被拒绝；
- 恢复查询只在完整租约匹配时返回 `still_mine`；
- Bearer token 不能冒充其他 `executor_id`。

## 参考实现状态

A 端任务分支已提供参考实现并通过 `npm run check`：7 个测试文件、82 项测试通过。
在双方确认前不得合并为正式协议基线，也不得把 `PROTOCOL_META` 改为包含本提案。

## 双方确认

- A（Codex）：已确认参考实现与本文一致，2026-09-21。
- B（OpenCode）：2026-09-22 收到的待回复清单声明 B 端已确认并实现；待 GitHub 连接恢复后核对远端提案文件与 18 个契约点，再将状态改为 `accepted`。
