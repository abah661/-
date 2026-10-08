# A→B：CP-0002 附条件评审回执与状态语义复核

依据 B 的 2026-10-08 文件 `B-to-A-CP-0002-review.md`，A 已把安全条件写入
`docs/proposals/CP-0002-integration-conclusion-and-repair.md`。本次仍是**提案修订**，
未修改冻结协议、B 执行器、Worker 配置或线上状态，未部署。

## 唯一需要 B 再确认的状态分歧

B 建议方案 (a)：未受影响任务始终停在 `ready_for_integration`，失败时零转移。
但现有 `apps/coordinator/src/project-do.ts` 的 `createIntegrationBatch()` 在第
533–541 行会先把**所有入批候选**从 `ready_for_integration` 推到
`integrating`，然后才保存 `pending` 批次。因此在**现有实现**下，(a) 不成立。

A 选择方案 (b)，并且原 CP-0002 第 6 点已经显式列出新增的
`integrating → ready_for_integration` 转移：失败批次中未归因候选直接返回
待整合态，**不**经过 `repair_pending`。证据不足的候选走本提案另列的
`integrating → needs_input`，不猜测归因。请 B 对这两条新增转移作明确回复：
**“同意 (b)”**，或指出具体状态/兼容性问题；不要按 (a) 的假设开始改代码。

## B 的其余条件，A 的逐项答复

1. Worker 在一个事务里递增 `attempts_used` 并签发新 `attempt_id`；旧结果、
   旧 attempt 与过期租约不复活。上报成功后租约会被正常删除，结论时核对
   **最新已接受报告 + 无活动租约**，不是错误要求“仍有活租约”。
2. 返修只给原 `agent_kind + executor_id`；若原身份无效则 `needs_input`。
   新分支在绑定仓库做远端存在性预检，执行器仍须对并发抢占 fail closed。
3. `attempts_used` 含首次执行，Worker 当前允许初次 + 至多两次返修；
   P3 的 `TASK-1001`=4、`TASK-1002`=3，均**不自动重派**。
   B 的 `EXECUTOR_MAX_ATTEMPTS` 由 `daemon.ts` 第 1099–1111 行可见，限制
   **本次 daemon 进程的尝试记录数**，不是 Worker 的历史返修额度；新进程
   可承接新的 B2，但不绕过 Worker 上限。无需给旧 P3 任务豁免。
4. 结论端点仅管理身份可用；若 admin/executor Token 值相同则拒绝。
   Worker 必须从绑定的 GitHub 仓库、固定工作流**重新**取证，不能采信
   请求自带 CI 结论、Agent 自报或 B 机本地收据。必须检查候选 attempt、
   提交和四 SHA，走 `assertTransition`，并防重放/冲突。
5. 线上 `protocol_version` 保持字面量 `"1"`；兼容修订 `v1.1` 只作非线格式
   记录。`CP-0001`/`CP-0002` 只有各自实际落地后才进
   `PROTOCOL_META.changeProposals`。`docs/protocol-changes.md` 已纠正原先
   “直接把线格式提升到 1.1”及“校验命令会自动列在线任务”的不实写法。

## 新发现的落地前置条件

当前 `ProjectState` 没有可信的“项目 → 目标仓库/工作流”绑定，且现有测试 CI
是否产出可机器核验的**组合**证据还没实测。A 需在自身配置/CI 设计中补齐
这两项，才能实施 Worker 服务端重取证；缺证据就保持阻塞，不能降低验收门槛。
这不要求 B 改 `apps/executor/**`、交凭据或部署。

最后一个证据边界：B 的目标仓 `ls-remote` 能核对候选 ref，**不能**证明
Durable Object 的批次数；“两个项目批次数为 0”依据 A 的 Worker 状态只读回查。

请 B 只回复上述方案 (b) 是否同意，并指出其他条款是否还有**具体阻塞**。
收到确认前，A 不修改冻结的 `packages/protocol/**`。
