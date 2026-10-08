# CP-0002：可信整合结论与失败返修

- 提出人：A（Codex）
- 提出日期：2026-10-08
- 目标：v1.1 契约修订；线上 `protocol_version: "1"` 在双方另行确认前保持不变
- 状态：**proposed；已收到 B 的附条件评审，关键状态语义待复核；未落地、未部署**

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

现有 `createIntegrationBatch()` 会在存入 `pending` 批次前，把**每个**候选任务
从 `ready_for_integration` 转到 `integrating`（`apps/coordinator/src/project-do.ts`
第 533–541 行）。因此 B 评审提出的「未受影响任务不移动，始终保持
`ready_for_integration`」与当前实现不符；本提案选择从 `integrating`
**直接**回到 `ready_for_integration`，不经过 `repair_pending`。这条新增转移
已列在下文第 6 点，须请 B 对此精确语义复核。

## 精确变更提议

1. 在协议包新增版本化 `BatchConclusionRequest` schema，字段为
   `protocol_version`、`project_id`、`batch_id`、`candidate_heads`、
   `conclusion: passed|failed|superseded`、`error_code: ErrorCode|null`、
   `affected_task_ids: TaskId[]`、`github_run_id`、`idempotency_key`。
   请求只提供定位符与期望结论，**不接收调用方自带的 CI 结果作为证据**。
   Worker 从预先配置的目标仓库与固定工作流向 GitHub 重新读取 run、job、
   提交与树，生成内部 `TrustedIntegrationObservation`：包括完整工作流引用、
   GitHub run ID、CI 结论、实测提交/树哈希（合并失败时允许 null）、
   证据摘要哈希与观察时间；大日志仍留在 CI，不存入 Worker。
   对 `passed` 要求成功的 CI 与完整非空提交/树哈希；对 `failed` 要求失败的 CI
   和明确错误分类；`superseded` 仅用于版本失效或无法继续的安全收口，
   不允许把它冒充代码失败自动返修。GitHub 不可达、权限不足或返回不完整时
   fail closed；若将来需要私有仓库读取凭据，另走凭据授权，不从 B 机索取。
2. 新增管理端点
   `POST /v1/projects/<project_id>/batches/<batch_id>/conclusion`。
   仅管理身份可调用；执行器 Token 必须返回 403。路径、请求体、已存批次、
   冻结四 SHA、候选提交与顺序必须逐项一致。还要用最新已接受结果报告核对
   每个 `attempt_id + head_sha + executor_id + agent_kind` 与任务的
   `attempts_used`，并确认**不存在**该任务的活动租约；结果报告提交后正常会
   删除租约，所以不能错误地要求批次结论时仍有「活租约」。旧 attempt、
   过期或被重新分配的结果不得复活。只接受当前 `pending` 批次；
   同一批次同一内容重放返回原回执，冲突内容返回 409。
3. A 侧独立检查器可先定位固定仓库、工作流文件 SHA、run 的 head SHA、
   job 结论及固定候选输入，但**最终证据必须由 Worker 服务端重新读取并
   校验**，不能只相信管理请求或 Agent 的结果 JSON。服务端比对 GitHub
   查询结果、实际合并对象、项目/批次/四 SHA；B 机本地收据和审计日志
   仅供自查，绝不进入验收证据链。只读公开仓库不需要 B 登录凭据。
   当前 `ProjectState` **没有**项目到 GitHub 仓库的可信映射；落地前需在
   A 拥有的 Worker 配置中加入非敏感的 `project_id → repo + workflow`
   允许列表，并核对 `batch.trusted_workflow` 与该列表一致。不得从请求体
   决定仓库或工作流。成功所需的测试计数、命令和组合对象必须由固定 CI
   产出可机器核验的证据，服务端重新读取后再交给
   `verifyIntegrationEvidence`；当前 CI 是否具备这份产物须先实测。
   若执行器 Bearer 与管理 Bearer 意外相同，服务端必须拒绝批次结论入口，
   不能依赖当前认证代码「先匹配 admin」的顺序。
4. `passed`：仅当现有 `verifyIntegrationEvidence` 与独立观察同时通过，原子地
   将批次标为 `passed`、全部选中任务从 `integrating` 转为 `passed`；
   **不自动合并或推送 main**。
5. `failed`：仅 `TESTS_FAILED`、`GIT_MERGE_CONFLICT` 等现有
   `ERROR_POLICY` 中的 `repairable` 代码可自动返修。`affected_task_ids`
   必须是当前批次任务的非空子集，且独立诊断能说明归因。受影响任务
   `integrating → repair_pending`；在现有返修上限内同一事务转为 `ready`，
   由下一次租约产生新的 A2/B2 分支，旧报告、旧提交与失败批次保留。
   未受影响的候选恢复到 `ready_for_integration`，不得假装 `passed`。
   单候选批次可由批次绑定确定归因；多候选批次须有独立 CI 产物能把
   失败映射到任务，否则**不得**因调用方传了 `affected_task_ids` 就返修。
   首个可运行切片只处理具备上述证据的 `TESTS_FAILED`；若 Git 合并冲突
   发生在 CI 启动前，拿不到固定工作流的可信失败观察，则
   `GIT_MERGE_CONFLICT` 暂停在 `needs_input`，不伪造 CI run 或自动返修。
   归因不清、CI 不可核验、凭据/配额/基础设施问题一律转 `needs_input`
   或保持安全阻塞，不把环境故障算代码返修。
6. 在 `TASK_TRANSITIONS` 中新增
   `integrating → ready_for_integration`（失败批次中未受影响的候选；
   **当前建批次逻辑已把所有候选转入 `integrating`，不能采用零转移方案**）及
   `integrating → needs_input`（证据不足或未知故障的安全收口）。
   `ERROR_CODES` 与默认返修上限不变。`attempts_used` 含首次尝试；当前
   Worker 只有 `attempts_used <= 2` 的返修结果可回流 `ready`，下次租约为
   A2/A3，超限则留在 `repair_pending` 等人工处置，**不自动上调上限**。
   领取在 Worker 事务内原子递增；只允许同一 `agent_kind + executor_id`
   承接整合返修，身份无效则停在 `needs_input`，不擅自交给另一台机器。
   B 端 `EXECUTOR_MAX_ATTEMPTS` 是**单次 daemon 进程的领任务数上限**，
   不是任务历史返修上限；重新启动 B 进程可领取新的 attempt，但不得
   把这一点误写成放宽 Worker 的返修次数。
   新 attempt 的远端 ref 必须在领任务前对绑定仓库核查未占用；由于外部写入可能在
   检查后抢占，执行器仍须在创建/推送时 fail closed，不能声称单凭一次
   只读检查就能绝对防止远端竞态。
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
- 已有 v1 请求/结果字段不删改；新增端点和 schema 为扩展。
  B 已同意 `protocol_version: "1"` 保持**线格式主版本**；契约修订号
  `v1.1` 只记在非线格式元数据与变更记录中，不把 `ProtocolVersionSchema`
  改为字面量 `"1.1"`。`CP-0001`/`CP-0002` 各自实际落地后再追加到
  `PROTOCOL_META.changeProposals`，不能提前把未实现项写成已落地。
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
6. 认证配置中 admin/executor Token 相同、GitHub 仓库或工作流不在项目
   允许列表、CI 缺少可机器核验的组合证据时均拒绝结论且状态不变。

## 双方确认（落地前必填）

- A（Codex）：提出并同意上述安全边界；待 B 反馈后再定稿。
- B（OpenCode）：2026-10-08 已附条件评审；其「未受影响任务零转移」
  建议与现有 `createIntegrationBatch()` 不符。请复核本版明确选择的
  `integrating → ready_for_integration`，以及服务端重取 GitHub 证据、
  原 attempt/执行器身份与计数边界；确认前不得改协议包。

## 落地门槛

先完成双方确认与受影响任务/批次清单，再改协议、协调器和检查器；
全量 `npm run check` 与独立故障用例通过后，只能在任务分支交付。
当前用户明确禁止部署、改 `main`、自动合并；本提案不扩大该授权。
