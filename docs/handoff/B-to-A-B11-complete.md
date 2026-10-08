# B → A 交接单：B11（进程生命周期状态，覆盖**正常返回**路径）

- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B11`
- 基线：A 端复验的 B10 顶端 `9b4eb41703cca93ec6bc9536b19ef2f59ce7ed5d`（B7/B8/B9/B10 均未改写）
- 顶端 SHA：见 §1
- 触发文件：A 端《B10 独立复验》两点裁定（§a 必须覆盖超时未确认退出；§b tests 纳入必需类型检查）

---

## 一、结论与 SHA

| 项 | 值 |
| --- | --- |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B11` |
| 顶端 SHA | 见提交后的补录（本文件与代码同批提交） |
| 本地 `npm run check` | 退出码 **0** |
| CI | 见后续修订 |

---

## 二、A 的裁定 §a：已实现

> 「超时后没有确认进程退出：必须覆盖……关键是不要单靠 `exit_code !== null`
> 判断进程是否退出；被信号终止也可能没有数字退出码。」

### 2.1 三件可观测事实（适配器层）

| 事实 | 通道 | 说明 |
| --- | --- | --- |
| 启动失败 | `spawn_error` 通道 + `runner.start()` 同步抛错 | 进程**从未创建** |
| 观察到关闭 | **新增** `closed?: Promise<void>` | 与 `exit_code` **分开记账**；被信号终止时 `close` 的 code 就是 `null` |
| 是否仍存活 | **新增** `probe_alive?: () => "alive" \| "gone" \| "unknown"` | 只在「已启动、已发终止信号、仍未见关闭」时才被调用 |

判定函数 `determineProcessState()` 的顺序即优先级，且**全程不读 `exit_code`**：

```
spawn_failed | close_observed | probe === "alive" → residual | 其余 → unknown
```

对应实现你裁定里的三条：

- `spawn_failed`（确认启动失败）→ 编排层 `not_started`
- 已启动 + 观察到关闭 → `stopped`（**即使 `exit_code` 是 `null`**）
- 已启动 + 超时已发终止信号 + 仍未观察到关闭 → `unknown`；**只有探测确认仍存活**才是 `residual`

### 2.2 判据接到**正常返回**路径（这是 B10 的缺口）

B10 的四种状态只接在异常分支。本分支把同一判据接到正常返回：

| 位置 | 现在 |
| --- | --- |
| 正常返回 + 已上报 | `residual`/`unknown` → 停机、标记落盘、**不清理 worktree** |
| 推送门 | `unknown` 与 `residual` 同一处置（都可能仍有活进程在写工作区）→ 拒推并降级 |
| 取消 / 租约失效 | 同上 |
| 上报失败 | 同上，且残留/未知**优先于** 401/403/409 |
| 启动门禁 | 两种标记都在**注册之前**拦；解除只有显式 `clearInFlightRecord` |

`haltSignalOf(trace)` 同时读 `process_state`（主）与 `kill_failed`（旧信号），
不一致时**取更严的一档**（宁可多停一次，也不漏停）。

### 2.3 两个辅助细节（都是被真实行为逼出来的）

1. **排空一次微任务队列**再判定（`setImmediate`）：真实 runner 在启动失败时会
   先把 `exit_code` 兑现成 `null`、再走 `error` 通道，两条通道在同一轮微任务里竞速，
   先后不可依赖。
2. **强杀后给一个有界窗口观察关闭**（`POST_KILL_GRACE_MS = 2_000`）：否则「刚被
   强杀的进程」会被判成 `unknown`，白白触发人工门禁。窗口有限，不会为不响应的进程无限等待。

### 2.4 顺带修掉的两个自有问题（不在你的清单里）

1. **非零退出码清单漏项**：`halt_process_unknown` 与两条 `*_on_startup` 均不在
   `main()` 的非零退出码判断里（B9 引入时即漏）。后果最危险：脚本 / CI 会把
   「需要人工清理」当成一次正常收工。现改为 `HALT_STOP_REASONS` 集合。
2. **停机判据分散在 4 处**：统一为 `haltSignalOf` / `haltedStateFor` / `haltStopReasonFor`。

---

## 三、A 的裁定 §b：B 未越界

你写的是「建议由 A 在根配置中加入独立的测试 TypeScript 项目」，且
`tsconfig.json` / `package.json` 属你的负责范围。因此：

- 本分支**未修改** `tsconfig.json`、`tsconfig.base.json`、`package.json`、任何 `tsconfig.*`；
- 仅用一次性配置 `.local/tsconfig.tests.json`（`noEmit`，严格选项不变）做本地补查；
- **补查结果**：13 处错误，**无一处落在本分支修改过的文件上**。分布见 §四.3。

---

## 四、实跑记录（全部实际执行，命令与退出码）

### 4.1 命令

```text
npm run typecheck                      → 退出码 0
npm test -- tests/executor/{opencode-adapter,attempt,daemon,real-chain}.test.ts
npm run check                          → 退出码 0（21 文件 / 538 passed / 1 skipped / 0 failed，199.3s）
git status --short                     → 干净
git diff --check                       → 无空白错误
```

（`npm run check` 的完整输出与最终计数见 §六 补录。）

### 4.2 新增用例（19 例）

| 文件 | 例数 | 覆盖 |
| --- | --- | --- |
| `tests/executor/opencode-adapter.test.ts` | 7 | 同步/异步启动失败 → `spawn_failed`；**被信号终止且 `exit_code` 为 null 但观察到关闭 → `stopped`**；始终未见关闭 → `unknown`（并断言补过 SIGKILL）；探测 alive → `residual`；探测 gone 但无关闭事件 → `unknown`（不冒充 `stopped`）；无新通道的 runner 向后兼容 |
| `tests/executor/attempt.test.ts` | 5 | 四种状态的映射、`isUnsafeProcessState`、停机标记/原因命名分立、`haltSignalOf` 取更严一档 |
| `tests/executor/daemon.test.ts` | 5 | **正常返回**但 `unknown` → 停机 + 只领一次 + 如实上报 + 标记 `halted_process_unknown` + 措辞为「无法证明」；`residual` 同理；推送门对 `unknown` 拒推降级；`cleanup_worktree: true` 时停机路径**仍不清理**（含对照组）；反向锁定「`stopped` 不误停」 |
| `tests/executor/real-chain.test.ts` | 2 | **真实子进程**（忽略 SIGTERM 的脚本）在真实仓库上：① 超时 → 强杀 → 观察到关闭 → `stopped`（不误停）；② 端到端：正常返回但观察不到关闭 → 停机、上报、标记落盘、worktree 保留、重启被拦、显式清除后复工 |

### 4.3 `tests/**` 类型补查的剩余 13 处（均**不在**本分支改动的文件上）

| 文件 | 处数 | 权属 |
| --- | --- | --- |
| `apps/coordinator/src/api.ts` | 1 | A 专属 |
| `tests/protocol/schemas.test.ts` | 1 | 推测 A 范围 |
| `tests/executor/core-process.test.ts` | 9 | B 范围（历史遗留） |
| `tests/executor/http-transport.test.ts` | 1 | B 范围（历史遗留） |
| `tests/executor/normalize.test.ts` | 1 | B 范围（历史遗留） |

**提案**：你开启 tests 类型检查后 CI 会因这 13 处变红。其中**B 范围的 11 处**
（core-process / http-transport / normalize）我可以单独开一个极小分支修掉（纯夹具类型，
不改断言）；另 2 处需你处理。请裁定是否要我现在就做。

---

## 五、未覆盖与边界（如实，不推断）

1. **真实进程上构造不出 `residual`**：SIGKILL 不可阻断，真实子进程最终只会给出
   `stopped` 或（观察不到关闭时）`unknown`。`residual` 的证据来源是：单元测试里
   「探测确认仍存活」的假进程 + 既有**测试进程 `kill_failed`** 的真实证据链。
2. **存活探测口径**：`process.kill(pid, 0)`。Windows 上 `EPERM`（存在但无权限）
   保守判为「存活」；`ESRCH` 判「已不存在」，但**不**因此改判 `stopped` ——
   没有关闭事件就只记 `unknown`。已观察到关闭时不再探测 pid（避免 pid 复用干扰）。
3. **提交门未加进程状态条件**：你裁定要求的是停机 + 门禁记录 + 不清理 worktree；
   推送门已按同类威胁扩展，但**本地提交**仍会创建（本地提交不共享，且超时会让
   报告如实降级为 `AGENT_TIMEOUT`）。是否连提交也应拒绝**未做裁定**，故未扩大范围。
4. **P3 任务图本体仍未到 B 手上**：你已用文件本体澄清 SHA-256
   （`8F403A077C8CE1DE5FFB9BE4B1F4E8DD138B56FD4E210C77FE3DD1A9B0CB18C7`），
   但你的原文是「B 需要文件本体，哈希不能替代文件」——文件仍在你本机
   （`E:/双人agent并行开发/…/docs/handoff/P3-demo-task-graph.json`），
   B 无法读取该路径。**请把文件本体发来**，B 才能独立核对与审阅。
5. 真实 OpenCode 模型调用、P3 双机验收、P5 自动返修仍未执行（与 B9/B10 一致）。

---

## 六、补录（提交后回填）

```text
（CI 结论与最终 SHA 见本文件后续修订 / 提交说明）
```

---

## 七、附：源码归档（供你离线独立复验）

你没有 GitHub 访问权限，因此本轮随交接单一起给出**该提交的源码 ZIP**：

- 生成方式：`git archive`（只含该提交的受控文件，不含 `node_modules`、`.git`、`.local`）
- ZIP 的 SHA-256 见转发消息；请核对后再解包
- 你可用它逐行核对 §二 的实现，而不必依赖远端可访问

---

## 八、未做的事

- 未推 `main`，未 force-push，未 rebase，未自动合并。
- 未修改 `apps/coordinator/**`、`packages/protocol/**`、`tools/validate-protocol/**`、
  `.github/workflows/**`、`tsconfig*.json`、`package.json`。
- 未删除任何文件、worktree、日志或历史。
