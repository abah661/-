# CP-0002：可信整合结论与失败返修

- 提出人：A（Codex）
- 提出日期：2026-10-08
- 目标：v1.1 契约修订；线上 `protocol_version: "1"` 在双方另行确认前保持不变
- 状态：**proposed，待 B 审核；未落地、未部署**

## 动机与实测证据

测试项目 `a-codex-regression-20261008` 的 `TASK-1004-A1` 由 A 自动执行，
提交 `88023aa01ff91b3d90eb513e7071b918b9e136cc` 已推送并被 Worker 接受为
`ready_for_integration`。独立 worktree 将它与 provider A4 的固定提交
`e43b9ce247fb73754887ecb3dd220a866236f9ab` 组合后，Node 22 自测 4/4 通过，
但冻结 `acceptance/run.mjs` 退出码 1：缺少 `src/display/render-user.js`。
组合提交 `580703f4d97634737380c1b6cf07506f11b45669` 未推送。

现有 Worker 只有 `POST /batches` 创建 `pending` 批次，并把候选任务转到
`integrating`；没有可信结论入口，因此既不能记录失败并重派 A2，也不能把
受信任 CI 的成功结论推进到 `passed`。这不是通过修改旧 A1 回执能解决的问题。

## 精确变更提议

1. 在协议包新增版本化 `BatchConclusionReport` schema，字段为
   `protocol_version`、`project_id`、`batch_id`、`candidate_heads`、
   `conclusion: passed|failed|superseded`、`error_code: ErrorCode|null`、
   `affected_task_ids: TaskId[]`、`observation`、`idempotency_key`。
   `observation` 必须带固定工作流完整引用、GitHub run ID、CI 结论、
   实测提交/树哈希（在合并失败时允许 null）、证据摘要哈希与观察时间。
   对 `passed` 要求成功的 CI 与完整非空提交/树哈希；对 `failed` 要求失败的 CI
   和明确错误分类；`superseded` 仅用于版本失效或无法继续的安全收口，
   不允许把它冒充代码失败自动返修。大日志仍留在 CI，不存入 Worker。
2. 新增管理端点
   `POST /v1/projects/<project_id>/batches/<batch_id>/conclusion`。
   仅管理身份可调用；执行器 Token 必须返回 403。路径、请求体、已存批次、
   冻结四 SHA、候选提交与顺序必须逐项一致。只接受当前 `pending` 批次；
   同一批次同一内容重放返回原回执，冲突内容返回 409。
3. A 侧独立检查器从 GitHub 查询固定仓库、工作流文件 SHA、run 的 head SHA、
   job 结论及其固定候选输入，核对 Git 提交与实际合并对象后形成
   `TrustedIntegrationObservation`；不能从 Agent 的结果 JSON 反序列化出
   “可信”结论。Worker 只接受该独立管理边界提交的结构化观察，并再次检查
   项目、批次和 SHA。只读 GitHub API/CI 不需要 B 登录凭据。
4. `passed`：仅当现有 `verifyIntegrationEvidence` 与独立观察同时通过，原子地
   将批次标为 `passed`、全部选中任务从 `integrating` 转为 `passed`；
   **不自动合并或推送 main**。
5. `failed`：仅 `TESTS_FAILED`、`GIT_MERGE_CONFLICT` 等现有
   `ERROR_POLICY` 中的 `repairable` 代码可自动返修。`affected_task_ids`
   必须是当前批次任务的非空子集，且独立诊断能说明归因。受影响任务
   `integrating → repair_pending`；在现有返修上限内同一事务转为 `ready`，
   由下一次租约产生新的 A2/B2 分支，旧报告、旧提交与失败批次保留。
   未受影响的候选恢复到 `ready_for_integration`，不得假装 `passed`。
   归因不清、CI 不可核验、凭据/配额/基础设施问题一律转 `needs_input`
   或保持安全阻塞，不把环境故障算代码返修。
6. 在 `TASK_TRANSITIONS` 中新增
   `integrating → ready_for_integration`（失败批次中未受影响的候选）及
   `integrating → needs_input`（证据不足或未知故障的安全收口）。
   `ERROR_CODES` 与默认返修上限不变。重领时优先限制在上次该任务的
   `agent_kind`/执行器身份，避免把 B 的返修误派给 A；身份不可用则停在
   `needs_input`，不擅自转交。
7. 批次结论与精简证据写入既有 `IntegrationBatch` 和 `EventEnvelope`
   (`batch.failed`/`batch.passed`)；不直接改 Durable Object 存储、不删除历史。
   如实现需新增持久字段，须在落地前补充兼容/迁移审查；本提案不授权迁移。

## 影响范围与兼容性

- 受影响的在线任务（2026-10-08 只读回查）：`demo-user-profile-p3` 的
  `TASK-1001` 为 `ready_for_integration`、`attempts_used=4`，`TASK-1002`
  为 `ready_for_integration`、`attempts_used=3`；两者均超过现有默认返修上限，
  **不能**借本提案自动再派。隔离项目 `a-codex-regression-20261008` 的
  `TASK-1004` 为 `ready_for_integration`、`attempts_used=1`，但尚无批次，
  也尚无该批次的真实失败 CI 观察；因此目前不能触发自动返修。
- 两个项目当前批次数均为 0；没有进行中的批次可按新契约作废或重建。
  落地前必须重新只读盘点任务和批次，再决定是否需要逐批重建。
- `packages/protocol/`：新增结论 schema、两个状态转移；**冻结协议变更，须按流程审核**。
- `packages/integration/`：失败观察与独立核验；成功检查继续从严。
- `apps/coordinator/`：管理路由、幂等事务、状态终结与归因校验。
- `tools/cli/` 或 A 端独立检查器：读取 GitHub/固定 Git 证据并上报；
  不把候选 Agent 的自报当成可信输入。
- B 执行器内核：**本提案不要求 B 改代码**；B 需确认重新变为 `ready` 的任务
  能按现有 `attempts_used` 领取新分支，且不误领 A 的返修。
- 已有 v1 请求/结果字段不删改；新增端点和 schema 为扩展，但
  `protocol_version` 的线上表示与 CP-0001 的 v1.1 记账问题须先一起裁定。
- `TASK-1004-A1` 当前 Worker 记录保持原样。只有将来实现、经授权部署并
  取得真实失败 CI 观察后，才可为它创建待验收批次、提交失败结论并重派 A2。

## 必须验证的用例

1. 单候选真实组合失败 → 批次 `failed` → A1 保留 → A2 新租约/新分支；
   返修后的新批次独立验收才可 `passed`。
2. 双候选仅一项有证据归因：只返修该项，另一项回到
   `ready_for_integration`；归因不明不得随机指派。
3. 错误候选 SHA、基线、项目、工作流/run、非当前批次、重复/冲突结论、
   执行器 Token、伪造的 Agent 自报均被拒绝且状态不变。
4. 超过返修上限、CI 缺失/不可达、认证或配额失败均不自动重领；
   幂等重放、并发终结与版本变化不得产生双重派单。
5. `passed` 仍需完整可信 CI/Git 证据，不能因本提案降低独立验收门槛；
   不自动合并、推送 `main` 或部署。

## 双方确认（落地前必填）

- A（Codex）：提出并同意上述安全边界；待 B 反馈后再定稿。
- B（OpenCode）：**待确认**。请特别裁定未受影响任务回退、返修身份绑定、
  A2/B2 领取和线上 `protocol_version` 表示。未经确认不得改协议包。

## 落地门槛

先完成双方确认与受影响任务/批次清单，再改协议、协调器和检查器；
全量 `npm run check` 与独立故障用例通过后，只能在任务分支交付。
当前用户明确禁止部署、改 `main`、自动合并；本提案不扩大该授权。
