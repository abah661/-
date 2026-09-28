# B10 交付报告：编排异常的可验证进程状态与 fail-closed 停机

| 项 | 值 |
| --- | --- |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B10` |
| 基线 | B9 顶端 `88b25d4ff2047f3416c6055d914675288ac1e41d` |
| 对应复验单 | 《A → B：B9 独立复验结果》第四节「阻塞验收的问题：runner 异常后继续领取」 |
| 交接单 | `docs/handoff/B-to-A-B10-complete.md` |

## 一、结论

A 端判定的 fail-open 缺口已按「可证明的进程状态」重做：

- `runAttempt` **不再原样抛出**内部异常，改为抛出带 `process_state` 的
  `AttemptOrchestrationError`；异常形态里必须携带「进程现在在哪」，
  不允许留空由调用方猜（猜的结果过去就是「当成没有进程」）。
- 常驻入口按状态分流：`not_started` / `stopped` → 记录后继续；
  `residual` / `unknown` → **停机 + 保留停机标记 + 当前进程不再领取**。
- 启动门禁从「只认已确认残留」扩展到「已确认残留**或**状态未知」，两者都在
  **注册之前**拦住。
- 非类型化异常（裸 `Error`）一律按 `unknown` 处理 —— 拿不到状态声明时，
  乐观默认为「已停止」正是被点名的那个错误。

本地 `npm run check` 退出码 0；Windows / Ubuntu CI 两个 OS 均 success（见 §5）。

## 二、逐条对应复验单第四节

### 2.1 「明确区分 `not_started / stopped / residual / unknown`；异常不能默认映射为『已停止』」

新增类型（`apps/executor/src/core/attempt.ts`）：

```ts
export type AttemptProcessState = "not_started" | "stopped" | "residual" | "unknown";
```

**状态记账点**——每跨过一个「可能已有进程存在」的边界就更新一次：

| 位置 | 记账 | 理由 |
| --- | --- | --- |
| 函数入口 | `not_started` | 还没碰过任何子进程，此时异常一定安全 |
| `setPhase("running_agent")` **之前一行** | `unknown` | 从这一行起本机**可能**出现 agent 进程；刻意不写 `not_started`——那会把「可能已在跑」说成「肯定没在跑」 |
| `runOpenCodeTask` 正常返回后 | `exit_code !== null ? "stopped" : "unknown"` | **退出码才是证据**。拿不到就只能是「未知」，不能算「已停止」 |
| 测试进程 `collected.kill_failed === true` | `residual` | 最坏一种；只在 `kill_failed` 时改写，不允许被后来的步骤回退成 `stopped` |

### 2.2 「对 `residual` 和 `unknown` 持久化安全停机状态；命名不能把未知冒称确认残留」

- 在途状态新增 `halted_process_unknown`（`core/recovery.ts`），与
  `halted_residual_process` **并存且语义分立**：

  | 状态 | 含义 |
  | --- | --- |
  | `halted_residual_process` | **已确认**有杀不掉的进程 |
  | `halted_process_unknown` | **状态未知**：既没确认存在，也没确认不存在 |

- 停机原因新增 `halt_process_unknown`（当前进程停机）与
  `halt_process_unknown_on_startup`（重启被门禁拦住）。
- worktree **刻意不清理**：清理动作可能被仍未退出的进程挡住，而「清理失败」
  会把「需要人工处理」伪装成一次普通告警。
- `attemptRecords[].result` 新增 `failed_orchestration`，与 `failed_to_report`
  分开 —— 前者「压根没跑完」，后者「跑完了但上报不出去」。

### 2.3 「只有可证明异常发生在进程启动之前，或已有可靠终止证据时，才允许按安全结束」

- 新增 `OpenCodePreStartError`（`adapters/opencode.ts`）与内部 `preStart()` 包装，
  只覆盖 `runner.start()` **之前**的代码（构造参数数组、解析启动目标）。
  `runner.start()` **同步抛错**走的是返回值路径（既有设计），不在此列。
- `runAttempt` 的 `catch` 分流：

  ```ts
  const state = error instanceof OpenCodePreStartError ? "not_started" : processState;
  throw new AttemptOrchestrationError(`编排异常（${describeProcessState(state)}）：${detail}`, state, error);
  ```

- 原始异常保留在 `cause`，`errorCodeOf` 递归取 `cause` 的错误码，
  **不因为包了一层就把 `CoordinatorHttpError` 的分类丢掉**。
- 常驻入口对非 `AttemptOrchestrationError` 的异常一律按 `unknown`（fail-closed）。

### 2.4 「新增故障注入测试」

复验单要求的五项断言逐一有确定性用例：

| 复验单要求 | 用例位置 |
| --- | --- |
| 不领取第二个任务 | `daemon.test.ts` ①（`acquireCalls() === 1`）、`real-chain.test.ts` 端到端 ① |
| 不清理仍可能被占用的 worktree | `daemon.test.ts` ①（日志断言）、`real-chain.test.ts` ③（真实 `existsSync`） |
| 在途记录持久化 | `daemon.test.ts` ①（`saved.at(-1).state`）、`real-chain.test.ts` ④（真实读盘） |
| 重启门禁在显式人工解除前拒绝开工 | `daemon.test.ts` ④⑤、`real-chain.test.ts` ⑤⑥ |
| 覆盖「确定发生在启动前」的异常分支 | `daemon.test.ts` ②、`attempt.test.ts`、`real-chain.test.ts`（模型标识非法） |

另加**反向锁**：`daemon.test.ts` ③ 用裸 `Error` 注入，锁定「非类型化异常不得
乐观默认为已停止」。

## 三、测试分层与各自证明什么

| 文件 | 注入层次 | 它能证明 | 它证明不了 |
| --- | --- | --- | --- |
| `daemon.test.ts` | 注入 `AttemptOrchestrationError` 到 `AttemptRunner` | 入口如何按四种状态分流 | `runAttempt` 是否真会算出正确状态 |
| `attempt.test.ts` | 无真实仓库（worktree 必失败） | 异常类型化、`not_started` 口径、四种说明措辞互不相同 | 走到 agent 阶段后的行为 |
| `real-chain.test.ts` | **真实** git 仓库 + 真实 `runAttempt`，故障注入点在**进程边界** | 状态由 `runAttempt` 自己算出；worktree 与在途记录的真实落盘 | 真实模型调用 |

> `attempt.test.ts` 刻意不建真实仓库：任何要走到 agent 阶段的用例都必须先有真
> worktree，而该文件的定位是「不碰真实网络与 Git 仓库」——所以那部分放在
> `real-chain.test.ts`，两层不重复。

## 四、新增用例清单（12 例）

`tests/executor/daemon.test.ts`（7 例）

1. ① ×2：`unknown` / `residual` → 停机、只领一次、标记持久化、未推送未上报、
   措辞可分辨、worktree 不清理
2. ② ×2：`not_started` / `stopped` → 记录后继续，**不误停**
3. ③ 裸 `Error` → 按 `unknown` 处理
4. ④ 重启发现 `halted_process_unknown` → 不注册、不领取
5. ⑤ 集成真实 `fileInFlightStore`：标记在 → 拒绝开工；记录原样保留；显式清除后复工

`tests/executor/attempt.test.ts`（2 例）

6. 四种状态的说明互不相同，且「未知」不得冒称「已确认」
7. worktree 准备失败 → `AttemptOrchestrationError` + `not_started` + `cause` 保留

`tests/executor/real-chain.test.ts`（3 例）

8. 进程已启动但拿不到退出码 → `unknown`（不是 `not_started` / `stopped`）
9. 模型标识非法（可证明的启动前失败）→ `not_started`，且 `start()` **一次都没被调用**
10. 端到端：停机 → 标记落盘 → 重启被门禁拦 → 显式清除后复工

## 五、实跑记录

| 命令 / 通道 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | **0** | 无错误 |
| `npm test -- tests/executor/{daemon,attempt,real-chain}.test.ts` | **0** | 3 文件 **112 passed / 0 failed**（180.2s） |
| `npm run check` | **0** | 21 文件 **519 passed / 1 skipped / 0 failed**（520），177.3s |
| GitHub Actions | — | **#31（`9dbfd8f`）**：`check (windows-latest)` **success**、`check (ubuntu-latest)` **success** |

总数对账：B9 基线为 **507 passed / 1 skipped（508）**，本轮 **519 / 1（520）**，
差 **12** 例 —— 与新增用例数完全吻合。

作业时长（用于判断是否跑完整套）：Windows `Run project checks` **24 s**、
Ubuntu **19 s**，与该仓库同 OS 的历史成功值（Windows 24–34 s、Ubuntu 16–19 s）
同量级。

> 基准提醒：本机 Windows 单跑 `npm run check` 需 **177 s**，Ubuntu CI 只要 **19 s**，
> 两者不可互相作基准。

## 六、本轮自查发现的三处问题（都是自己引入或既有的，不粉饰）

1. **门禁日志的模板字符串写坏。** 我把闭合反引号误写成双引号，导致模板字符串
   一直吞到文件后段，`tsc` 报出一串与真实原因无关的错误。已修。
2. **`makeInFlightRecord` 少传参数。** 新用例 ④ 里只传了 `dir`，而该夹具签名是
   `(dir, attemptId, taskId?)`。**`tsc -b` 不会检查 `tests/`**，所以这个错误在
   `npm run typecheck` 里看不见；是我另跑一次 tests 专用类型检查才发现的。已修。
3. **既有测试从错误的模块导入 `AttemptRunner`**（`core/attempt.js` 并不导出它，
   它由 `daemon.js` 导出）。该错误一直存在，且因为类型导入是纯类型、
   vitest 转译时会被抹掉，所以**从未被任何检查捕获**；它还会让依赖它的
   `defaultRunner` 退化成隐式 `any`。已在 `daemon.test.ts` 与
   `real-chain.test.ts` 各修一行。

## 七、未覆盖的边界（如实记录，未编造默认值）

1. **agent 侧「超时且拿不到退出码」不走异常分支。** 该路径上
   `runOpenCodeTask` **正常返回**（`exit_code: null`、`timed_out: true`），
   于是 `runAttempt` 也正常返回，常驻入口按普通失败处理并**继续领取**。
   进程是否真的结束了同样没有证据。
   我**没有**扩大范围去改它：复验单第四节限定的是「runner 抛异常」这条分支，
   且这条路径要正确处置，必须先区分「spawn 失败（可证明没启动）」与
   「超时未退出（状态未知）」——目前适配器返回值里没有这个区分字段。
   **建议**：若你要一并覆盖，请裁定在 `OpenCodeAdapterResult` 上加一个
   「进程是否确实启动过」的显式字段，那时我按同一套状态机接上。
2. **`residual` 在 attempt 层的直接证据缺失。** 「测试进程杀不掉」需要真实
   不可杀进程，本机做不到确定性复现；该状态由 `daemon.test.ts` 注入 +
   B7/B8 既有证据覆盖，attempt 层只保证 `kill_failed → residual` 这一行的
   记账顺序（不被后续步骤回退）。
3. **`tests/**` 不在 `tsc -b` 的检查范围内。** 已实测：`tsconfig.json` 的
   `references` 只含 `packages/protocol`、`apps/executor`、`tools/validate-protocol`，
   `tests/` 既不被 include 也无独立 project，因此测试代码**只有转译、没有类型检查**。
   本轮我用一次性配置（`.local/tsconfig.tests.json`，未提交）验证了新增代码无
   类型错误，但**没有改构建配置**：`/tsconfig.json` 与 `package.json` 不在
   B 的改动范围内。是否把 `tests/` 纳入类型检查请你裁定。
4. P3 真实双机联调、真实 Worker 的 403/409 / 旧租约 / 报告约束仍未执行。
5. `P3-demo-task-graph.json` 本体仍未在 B 的检出与收到的文件中出现，
   A 实算的 SHA-256（`8F403A07…B0CB18C7`）已如实记录，但 B **未独立验证**。

## 八、没有做的事

- 未修改 `apps/coordinator/**`、`packages/protocol/**`、`tools/validate-protocol/**`、
  `.github/workflows/**`。
- 未改写 B7 / B8 / B9 的既有提交；B10 从 B9 顶端派生。
- 未自动合并、未 force-push、未推 `main`。
- 未把任何凭据写进代码、日志、文档或仓库。
