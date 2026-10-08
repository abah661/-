# B11 交付报告：进程生命周期状态（覆盖**正常返回**路径）

- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B11`
- 基线：A 端复验的 B10 顶端 `9b4eb41703cca93ec6bc9536b19ef2f59ce7ed5d`
- 触发：A 端《B10 独立复验》两点裁定
  - §a **超时后没有确认进程退出：必须覆盖，B10 暂不能因此视为验收完成**
  - §b `tests/**` 应纳入必需的类型检查（**A 负责范围**，B 不越界）

---

## 1. 结论

§a 已实现并落地：进程状态不再由 `exit_code` 反推，而是由**三条可观测事实**
（启动失败 / 观察到关闭 / 主动探测）判定，并**同时**接在异常分支与正常返回分支上。

§b 属 A 的配置范围（`tsconfig.json`、`package.json`），**本分支未修改这两个文件**；
仅用一次性本地配置在 `.local/` 下补查（结果见 §3.3）。

---

## 2. 逐条对应 A 的裁定

### 2.1 进程状态改为可观测事实判定

| A 的要求 | 实现 |
| --- | --- |
| `spawn_failed`：确认启动失败 → `not_started` | 新增 `OpenCodeProcessState = "spawn_failed" \| "stopped" \| "unknown" \| "residual"`；`runner.start()` **同步抛错**与 `spawn_error` **异步通道**都归到 `spawn_failed`；经 `mapAdapterProcessState` 映射为 `not_started` |
| 已启动且**观察到进程关闭** → `stopped`（即使 `exit_code` 是 `null`） | 进程抽象新增独立通道 `closed?: Promise<void>`，**与 `exit_code` 分开记账**。被信号终止时 `close` 事件的 code 就是 `null`，因此用「是否观察到关闭」判定，而不是「退出码是否非空」 |
| 已启动、超时后发出终止信号、**仍未观察到关闭** → `unknown`；**能确认仍存活**才是 `residual` | 新增 `probe_alive?: () => ProcessLiveness`（三态 `alive \| gone \| unknown`，用 `process.kill(pid, 0)` 做存在性探测）；判定顺序：启动失败 → 观察到关闭 → 探测答 alive → `residual`，否则 `unknown`（**「探不到」不当作「已退出」**） |
| `residual` / `unknown` 都要停机、保留门禁记录、不清理 worktree，直到显式人工解除 | 见 2.2 |
| **不要单靠 `exit_code !== null` 判断进程是否退出** | 删除 `attempt.ts` 原有的 `exit_code !== null ? "stopped" : "unknown"`；`determineProcessState()` 全程**不读** `exit_code` |

适配器新增 `process_state: OpenCodeProcessState` 字段随结果一起返回；
编排层把它写进 `AttemptTrace.process_state`，常驻入口据此分流。

### 2.2 停机判据从「异常分支」扩到**两条路径**

B10 的四种状态只接在异常分支（`runAttempt` 抛异常）上。A 端指出的关键点是：
**超时不是异常** —— `runOpenCodeTask` 会正常返回一个结果（`timed_out: true`），
而进程仍可能活着。因此本分支把同一个判据接到**正常返回**路径上：

| 位置 | 修改前 | 修改后 |
| --- | --- | --- |
| 正常返回 + 已上报 | 只看 `kill_failed` | `haltSignalOf(trace)`：`residual`/`unknown` 都停机、标记落盘、**不清理 worktree** |
| 推送门（`ready_for_integration`） | 只在 `kill_failed` 时拒绝推送 | 同样是 `haltSignalOf`：`unknown` 与 `residual` 是同一类威胁（都可能有活进程在改工作区） |
| 取消 / 租约失效分支 | 只看 `kill_failed` | 同上 |
| 上报失败分支 | 只看 `kill_failed` | 同上（仍**优先于** 401/403/409） |
| 启动门禁 | 已有（B9/B10） | 不变：两种标记都在**注册之前**拦截，解除只有 `clearInFlightRecord` |

`haltSignalOf(trace)` 同时读两个信号（`process_state` 为主、`kill_failed` 为旧信号），
不一致时**取更严的一档**：停机判据宁愿多停一次（代价是一次人工确认），
也不能漏停（代价是残留进程与新任务并行抢同一个 worktree）。

### 2.3 判定顺序与两个辅助事实

1. **排空微任务队列**（`node:timers/promises` 的 `setImmediate`）：真实 runner 在
   启动失败时会把 `exit_code` **也**兑现成 `null`，两条通道在同一轮微任务里竞速落定，
   先后不可依赖。判定前排空一次，读到的是稳定值（一个有界 macrotask 边界，不是无界等待）。
2. **强杀后给一个有界窗口观察关闭**（`POST_KILL_GRACE_MS = 2_000`）：SIGKILL 之后进程
   通常很快被回收，若此刻立刻判定会把「刚被杀掉的进程」说成「状态未知」，
   白白让执行器停在人工门禁上。窗口**必须存在**（避免假停机）也**必须有限**（避免被不响应的进程拖死）。

### 2.4 自己发现并一并修掉的两个问题（不在 A 的清单里）

1. **非零退出码清单漏项**：`halt_process_unknown` 与两条 `*_on_startup` 都不在
   `main()` 的非零退出码判断里（B9 引入 `halt_residual_process_on_startup` 时就漏了）。
   后果最危险的一类：脚本 / CI 会把「需要人工清理」当成一次正常收工。
   现改为 `HALT_STOP_REASONS` 集合，新增停机原因只需在一处维护。
2. **停机判据分散**：4 处各写一遍 `kill_failed` 与标记名，容易再次漏改。统一为
   `haltSignalOf` + `haltedStateFor` + `haltStopReasonFor`。

---

## 3. 验证（全部实际执行）

### 3.1 编译期

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | **0** | 无错误 |

### 3.2 测试

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm test -- tests/executor/{opencode-adapter,attempt,daemon,real-chain}.test.ts` | 见 §3.4 | — |
| `npm run check` | 见 §3.4 | — |
| GitHub Actions | 见 §3.4 | — |

新增用例覆盖（不含既有用例）：

- **适配器层**（`opencode-adapter.test.ts`，7 例）：同步/异步启动失败 → `spawn_failed`；
  **被信号终止且 `exit_code` 为 null 但观察到关闭 → `stopped`**（A 点名的核心用例）；
  超时且始终未观察到关闭 → `unknown`（并断言放弃前补过 SIGKILL）；
  探测答 alive → `residual`；探测答 gone 但无关闭事件 → `unknown`（不冒充 `stopped`）；
  无 `closed`/`probe` 通道的注入式 runner 向后兼容。
- **编排层**（`attempt.test.ts`，5 例）：四种状态的一一映射、`isUnsafeProcessState`、
  停机标记/停机原因的命名分立、`haltSignalOf` 取更严一档。
- **常驻入口**（`daemon.test.ts`，5 例）：**正常返回**但 `unknown` → 上报后停机、不领第二个任务、
  标记为 `halted_process_unknown`；`residual` 同理；推送门对 `unknown` 同样拒绝并降级；
  `cleanup_worktree: true` 时停机路径**仍不清理** worktree（含同配置下的对照组：
  状态干净时清理点会被走到）；反向锁定「`stopped` 不误停」。
- **真实链路**（`real-chain.test.ts`，2 例）：用**真实子进程**（忽略 SIGTERM 的脚本）
  在真实仓库上跑两条方向相反的结论 ——
  ① 超时 → 强杀 → 观察到关闭 → `stopped`（**不因「退出码可能为 null」误停**）；
  ② 端到端：正常返回但观察不到关闭 → 停机、如实上报、标记落盘（`halted_process_unknown`）、
  worktree 保留、重启被门禁拦住、显式清除后才能复工。

### 3.3 `tests/**` 的类型检查（§b）

`tsc -b` 只覆盖 `apps/**`、`packages/**`、`tools/**` 的 `src`，**不含 `tests/**`**，
因此测试里的类型错误不会被现有 `typecheck` 发现。本分支**未改** `tsconfig.json` /
`package.json`（A 的权属范围），只用一次性配置在 `.local/` 下补查：

- 配置：`.local/tsconfig.tests.json`（`include` 覆盖 `tests/**`，`noEmit`，严格选项与基座一致）
- 结果：见 §3.4

### 3.4 实跑记录

```text
（见提交说明与本文件后续修订）
```

---

## 4. 未覆盖 / 边界（如实记录）

1. **真实进程上没有构造出 `residual`**：SIGKILL 不可被阻断，真实子进程最终只会给出
   `stopped` 或（观察不到关闭时）`unknown`。`residual` 由两类证据覆盖：单元测试里
   「探测确认仍存活」的假进程，以及**测试进程** `kill_failed` 那条既有真实证据链。
2. **存活探测的口径**：`process.kill(pid, 0)`。Windows 上 `EPERM`（进程存在但无权限）
   按保守方向判为「存活」；`ESRCH` 判为「已不存在」，但**不**因此改判 `stopped` ——
   没有关闭事件就只记 `unknown`。pid 复用理论上存在，但判定前先看关闭事件，
   已观察到关闭时不再探测 pid。
3. **提交门未加进程状态条件**：A 的裁定要求的是停机、门禁记录与不清理 worktree；
   推送门已按同类威胁扩展（`unknown` 同样拒推），但**本地提交**仍会创建。
   是否连提交也应拒绝未做裁定，故未扩大范围（本地提交不共享，且报告会因
   `AGENT_TIMEOUT` 如实降级）。
4. **P3 目标仓库与任务图**：A 已用文件本体澄清 `P3-demo-task-graph.json` 的
   SHA-256（`8F403A07…B0CB18C7`），但**文件本体仍未到 B 手上**，B 未独立验证；
   哈希不能代替文件（A 的裁定原文）。

---

## 5. 本分支自己踩到的坑（写入技能，供后续复用）

同一文件的**多处并行编辑**在本工具链下会互相覆盖（后一次写入覆盖前一次），
本轮因此出现过「改了但没落盘」的情况——由 `tsc` 报出「找不到名称」才发现。
处置：**一个文件一次编辑**，改完立刻用 `tsc -b --pretty false` 验证落盘。
