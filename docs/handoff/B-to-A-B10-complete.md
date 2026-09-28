# B → A 交接单：B10 编排异常的进程状态与 fail-closed 停机

| 项 | 值 |
| --- | --- |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B10` |
| 基线 | B9 顶端 `88b25d4ff2047f3416c6055d914675288ac1e41d` |
| 对应复验单 | 《A → B：B9 独立复验结果》第四节 |
| 报告 | `docs/reports/B10-B-orchestration-process-state.md` |

## 一、本轮只做一件事

按复验单第四节，把「runner 抛异常后状态未知却继续领取」这条 fail-open
路径改成 **fail-closed**：明确区分四种可验证的进程状态，`residual` / `unknown`
一律停机并保留标记，重启门禁同样拦截；只有**可证明**发生在进程启动之前、
或已有终止证据的异常才按安全结束处理。

未触碰协议 / 协调器 / CI，未改写 B7/B8/B9 的既有提交。

## 二、逐条对应复验单第四节

### 2.1 状态区分

```ts
export type AttemptProcessState = "not_started" | "stopped" | "residual" | "unknown";
```

记账点（任何时刻抛出都能说出进程在哪）：

| 时刻 | 状态 | 依据 |
| --- | --- | --- |
| 函数入口 | `not_started` | 未碰过任何子进程 |
| `setPhase("running_agent")` 前一行 | `unknown` | 从这一行起**可能**已有 agent 进程 |
| `runOpenCodeTask` 返回后 | `exit_code !== null ? stopped : unknown` | **退出码才是证据** |
| 测试进程 `kill_failed` | `residual` | 只在 `kill_failed` 时改写，不可被后续步骤回退 |

**没有**在任何地方默认成 `stopped`。

### 2.2 停机与命名

| 场景 | 在途状态 | `stop_reason` |
| --- | --- | --- |
| 异常 + 状态未知 | `halted_process_unknown` | `halt_process_unknown` |
| 异常 + 已确认残留 | `halted_residual_process` | `halt_residual_process` |
| 重启时发现「状态未知」标记 | （保留原记录） | `halt_process_unknown_on_startup` |
| 重启时发现「已确认残留」标记 | （保留原记录） | `halt_residual_process_on_startup` |

- 门禁从 `findResidualProcessRecord` 改为 `findHaltedProcessRecord`
  （判定收敛到导出的 `isHaltedProcessState`），两种状态**都拦**，
  但日志措辞与停机原因**可分辨**——「未知」不冒称「已确认残留」。
- 门禁位置不变：**健康检查之后、注册之前**。
- worktree **刻意不清理**；解除仍只有 `clearInFlightRecord(repoRoot, attemptId)`。
- `attemptRecords[].result` 新增 `failed_orchestration`（与 `failed_to_report` 分立）。

### 2.3 可证明的安全结束

- 新增 `OpenCodePreStartError` + `preStart()`，只包 `runner.start()` **之前**的
  代码（参数数组构造、启动目标解析）。这类异常 → `not_started`。
- `runAttempt` 抛 `AttemptOrchestrationError(message, process_state, cause)`；
  `cause` 保留原始异常，`errorCodeOf` 递归取码，不因包装丢掉 HTTP 分类。
- 入口对非 `AttemptOrchestrationError` 一律按 `unknown`（fail-closed）。

### 2.4 故障注入测试（12 例）

- `daemon.test.ts` 7 例：`unknown`/`residual` 停机（×2）、`not_started`/`stopped`
  不误停（×2）、裸 `Error` → `unknown`、重启门禁、真实 `fileInFlightStore` 集成。
- `attempt.test.ts` 2 例：四种措辞互不相同且未知不冒称已确认、启动前失败分类。
- `real-chain.test.ts` 3 例（真实仓库）：启动后拿不到退出码 → `unknown`；
  模型标识非法 → `not_started` 且 `start()` 未被调用；端到端停机 → 落盘 →
  重启被拦 → 显式清除后复工。

## 三、验证证据（全部实跑）

| 命令 / 通道 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | **0** | 无错误 |
| `npm test -- tests/executor/{daemon,attempt,real-chain}.test.ts` | **0** | 3 文件 **112 passed / 0 failed**（180.2s） |
| `npm run check` | 见 §五 | — |
| GitHub Actions | 见 §五 | — |

## 四、需要你裁定的一件事（本轮**刻意没做**）

**agent 侧「超时且拿不到退出码」不走异常分支。** 该路径上
`runOpenCodeTask` 正常返回（`exit_code: null`、`timed_out: true`），
`runAttempt` 于是也正常返回，常驻入口按普通失败处理并**继续领取**——
进程是否真的结束同样没有证据，性质与本次被点名的缺口相同。

没有顺手改的原因：要正确处置它，必须先区分

- `spawn` 失败（`ENOENT` 之类，**可证明进程从未被创建**，安全）；
- 超时未退出（**状态未知**，必须停机）；

而现在的 `OpenCodeAdapterResult` 里没有这个区分字段（两者都是
`exit_code: null` + `status: failed`）。硬加会造成「执行器一遇到模型名写错就
每次启动都被残留门禁拦住、必须人工清标记」的假停机。

复验单第四节限定的是「runner 抛异常」这条分支，所以我**没有**扩大范围。
若你要一并覆盖，请在 `OpenCodeAdapterResult` 上裁定一个显式的
「进程是否确实启动过」字段，我按同一套状态机接上。

## 五、实跑记录

| 命令 / 通道 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | **0** | 无错误 |
| `npm test -- tests/executor/{daemon,attempt,real-chain}.test.ts` | **0** | 3 文件 **112 passed / 0 failed**（180.2s） |
| `npm run check` | **0** | 21 文件 **519 passed / 1 skipped / 0 failed**（520），177.3s |
| GitHub Actions | 见提交说明补充 | — |

总数对账：B9 基线 **507 passed / 1 skipped（508）** → 本轮 **519 / 1（520）**，
差 **12** 例，与新增用例数吻合。

## 六、未验证项与边界（不粉饰）

1. 见第四节的「超时未退出」路径，本轮未覆盖。
2. `residual` 在 attempt 层无直接证据（需真实不可杀进程，本机无法确定性复现）；
   由 `daemon.test.ts` 注入 + B7/B8 既有证据覆盖。
3. **`tests/**` 不在 `tsc -b` 的检查范围内**（`tsconfig.json` 的 references 不含
   `tests/`）。本轮实测发现并因此修掉了两个测试侧类型错误（其中一个是既有的
   `AttemptRunner` 导入来源错误）。未改构建配置——`/tsconfig.json` 与
   `package.json` 不在 B 的改动范围，是否纳入请你裁定。
4. P3 真实 Worker 的 403/409 / 旧租约 / 单活动租约 / 报告约束仍未联调。
5. `P3-demo-task-graph.json` 本体仍未出现在 B 的检出与收到的文件中；
   你在复验单 §5 用文件本体实算的 SHA-256
   `8F403A077C8CE1DE5FFB9BE4B1F4E8DD138B56FD4E210C77FE3DD1A9B0CB18C7`
   （第 4 位是 `0`）已如实记录，但 **B 未能独立验证**。请把任务图发来。

## 七、请 A 复验

重点确认：

- 四种状态是否确实区分，且**没有任何路径默认成「已停止」**；
- `residual` / `unknown` 是否都触发「当前进程停机 + 标记持久化 + 重启门禁拦截」；
- 「未知」是否未被冒称为「已确认残留」（命名、日志、`stop_reason` 三处都可分辨）；
- `not_started` / `stopped` 是否仍按安全结束处理，**不误停**。

完成后 B 可继续推进 P3（仍待你给出任务图与目标业务仓库的推送授权）。
