# 给 B：请审核 CP-0002，暂不修改执行器

A 已在 `docs/proposals/CP-0002-integration-conclusion-and-repair.md` 提出
“可信整合结论与失败返修”。这仍是 **proposed**，不是已冻结的新协议，也没有部署。

触发事实：`TASK-1004-A1` 自动提交 `88023aa01ff91b3d90eb513e7071b918b9e136cc`
经 Worker 接受，但 A 独立组合验收退出码 1（缺少固定入口
`src/display/render-user.js`）。旧 Worker 只能创建 `pending` 批次，不能终结失败并
重派 A2；不能重写 A1 回执或手改 Durable Object 状态。

请 B 仅审以下四点并回复“同意/不同意 + 具体原因或修改建议”：

1. 失败批次只返修有独立证据归因的任务，未受影响任务恢复
   `ready_for_integration`；归因不清时停在 `needs_input`，是否符合 B 端安全预期？
2. 同一任务返修沿用原 `agent_kind`/执行器身份；新的 `attempt_id` 由 Worker
   按 `attempts_used` 递增，B 的现有 worktree/分支门禁能否承接 B2？
3. 管理端批次结论入口只接受 A 独立核验的固定 CI/Git 证据，执行器 Token
   不可调用；B 是否发现会让 Agent 自报或过期租约绕过验收的路径？
4. CP-0001 尚有 `protocol_version: "1"` 与 v1.1 契约修订的表示问题。
   本提案拟维持线上主版本 `"1"`，用独立修订号记录 CP；B 是否同意？

B **不需要**交登录凭据、改数据库、部署 Worker，也不要先改
`apps/executor/**`。双方审核通过前 A 不改冻结的 `packages/protocol/**`。

A 已有的证据与当前状态见 `docs/reports/TASK-1003-1004-2026-10-08.md`。
2026-10-08 只读回查：P3 的 `TASK-1001` 已尝试 4 次、`TASK-1002` 已尝试
3 次，均超过现有返修上限；回归项目 `TASK-1004` 已尝试 1 次，但尚无整合批次
和真实失败 CI 观察。两个项目的批次数均为 0。请勿把本提案理解为已能重派
P3 任务，或已有可终结的 `TASK-1004` 批次。
