# B9 交付报告：残留进程状态在全部分支的保留与重启门禁

| 项 | 值 |
| --- | --- |
| 任务 | `TASK-B-EXECUTOR` / B9（返修尝试） |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B9` |
| 基线 | B8 顶端 `4c65ae2140b85774b910461084883b5b6c9dcaf6`（B8 未被改写） |
| 触发 | A 端《A → B：B8 独立复验结果与 P3 任务图》第三节「B7-1 必须补齐的缺口」 |
| 范围 | 仅 `apps/executor/**`、`tests/executor/**`、`docs/**` |

## 一、结论

**B8 的 B7-1 只修好了一条路径**：结果上报成功 + `kill_failed=true`。
A 的独立复验指出另外三类路径没有同等保护，本次全部补齐，并为每条分支补了测试。

| # | A 指出的缺口 | 本次修法 |
| --- | --- | --- |
| 1 | 取消 / 租约失效分支不检查 `kill_failed`；日志仍声称「已终止子进程」；记录写成 `skipped_*` | 该分支先判残留：`kill_failed` 时不出现「已终止」字样，在途记录写成 `halted_residual_process`，并**停机** |
| 2 | 上报失败先写 `failed_to_report`；遇到 401/403/409 会在停机门**之前** `break` | 上报失败分支先判残留；残留优先于 401/403/409 与「继续」 |
| 3 | `isActiveInFlightRecord()` 只认 `undefined` / `in_flight`，启动恢复因此**忽略** `halted_residual_process` | 新增按「全量记录」扫描的启动门禁，位置在**注册之前** |

## 二、逐项修法

### 2.1 取消 / 租约失效分支（缺口 1）

`daemon.ts` 的 `if (outcome.trace.sideEffectsSkipped || aborted())` 分支：

- 新增 `const residual = outcome.trace.kill_failed === true;`
- **日志分叉**：残留时改为「……但子进程**未被终止**（kill_failed）：保留残留标记并停止领取新任务」。
  这一条是 A 明确点出的「误报」——原文案无论进程死活都说「已终止子进程」。
- `markInFlight(flightRecord, residual ? "halted_residual_process" : skipState)`
- 残留时 `report.stop_reason = "halt_residual_process"` 并 `break`。

**刻意的取舍**：`attemptRecords[].result` 仍记 `skipped_aborted` / `skipped_lease_lost`。
理由是这两件事回答不同问题——`result` 描述「这次 attempt 在 daemon 视角的收尾方式」
（确实没推送、没上报，是事实），`state` 描述「本机现在安不安全」。把安全状态塞进
`result` 会让「为什么没上报」变得不可读。因此新增的是 `state`，不是新的 `result` 取值。

**优先级**：残留 > 取消 > 租约失效。本地有杀不掉的进程时，这件事比云端租约状态
更需要人工介入，所以它的 `stop_reason` 覆盖 `aborted` / `lease_lost`。

### 2.2 上报失败分支（缺口 2）

`try { await deps.result_reporter.report(...) } catch` 分支：

- 同样先算 `residual`；
- `markInFlight(flightRecord, residual ? "halted_residual_process" : "failed_to_report")`；
- 残留时**先于** 401/403/409 判断并停机。

原实现的顺序是「先写 `failed_to_report`，再按 HTTP 状态分流」，
于是 401/403/409 三条都在停机门之前 `break`，残留事实被丢掉；
其余错误虽会落到停机门，记录却已经是 `failed_to_report`。两条路径现在都先判残留。

### 2.3 启动门禁（缺口 3）

这是最关键的一处：B8 **写了** `halted_residual_process`，却没有任何地方**读**它。

- `DaemonDeps` 新增可选 `load_in_flight_records?: () => readonly InFlightRecord[]`。
  **不能复用 `load_in_flight`**：那个只返回活动租约，而 `halted_residual_process`
  恰恰不是活动租约——这正是盲点的来源。`fileInFlightStore` 现在同时提供两者。
- 新增导出函数 `findResidualProcessRecord(records)`，只回答「有没有未清理的残留标记」。
- `runDaemon` 在**健康检查之后、注册之前**加门禁：

```text
[halt] 上次运行留下未清理的残留进程标记（attempt=...）：拒绝开工——可能有杀不掉的
       进程仍占用 worktree 与文件锁。请人工确认残留进程已清理（必要时重启本机）后，
       用 clearInFlightRecord 显式清除该标记，再重新启动
```

**为什么放在注册之前**：注册是本次运行的第一个云端写操作。「拒绝开工」必须在它之前
拦住，否则会出现「已经以本机身份注册，然后才发现不该开工」的中间态。
**为什么不放在健康检查之前**：`health` 是只读的，保留它能让排查多一条有意义的线索。

**解除方式只有一种**：`clearInFlightRecord(repoRoot, attemptId)` —— 一个**显式**、
需点名 attempt_id 的动作。常驻入口在任何自动路径里都不会调用它（沿用 P1-2 的既定前提）。
门禁**不会**删除或推进该记录：拒绝开工不等于删除许可。

## 三、验证证据（全部实跑）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 退出码 **0** |
| `npm test -- tests/executor/daemon.test.ts` | **72 passed / 0 failed**（新增 13 例；改动前 59 例） |
| `npm run check` | 退出码 **0**：21 文件 **507 passed / 1 skipped / 0 failed**（508），96.7s |
| GitHub Actions | **#29（`feccefd`）** `check (windows-latest)` 与 `check (ubuntu-latest)` 均 **success** |

新增 13 例（`tests/executor/daemon.test.ts`，`B9 §B8复验` 组）：

| # | 用例 | 断言要点 |
| --- | --- | --- |
| ① | 取消 + `kill_failed` | `stop_reason=halt_residual_process`；只领 1 次；**日志不含「已终止子进程」**、含「未被终止」 |
| ② | 租约失效 + `kill_failed` | 同上，`result` 仍 `skipped_lease_lost` |
| ③ | 取消但进程已终止 | 仍 `aborted` / `skipped_aborted`（不误报残留） |
| ④ | 上报 401 / 403 / 409 / 500 + `kill_failed`（4 例） | 均 `halt_residual_process`，**不被原状态分支抢走** |
| ⑤ | 上报 401 且进程已终止 | 仍 `auth_blocked`（回归锁定） |
| ⑥ | 上报 409 且进程已终止 | 仍 `lease_lost`（回归锁定） |
| ⑦ | 启动发现残留标记 | `halt_residual_process_on_startup`；**不注册、不领取** |
| ⑧ | 残留标记与 `isActiveInFlightRecord` 的关系 | 它不是活动租约（`load_in_flight` 看不见），但门禁看得见 |
| ⑨ | 集成 `fileInFlightStore` | 标记在 → 拒绝开工且**记录原样保留**；显式清除后 → 正常开工 |
| ⑩ | 无残留标记 | 门禁不干扰正常注册与领取 |

## 四、未验证项与已知边界

- **编排异常分支（`runAttempt` 抛异常）没有残留标记。**
  该分支上 `outcome` 根本不存在，`trace.kill_failed` 无从取得，因此无法判断
  是否留下残留进程。本次**没有**改动它，也没有为此编造默认值——
  「拿不到」不能伪装成「没有」。若 A 认为需要覆盖，需要在 `runAttempt`
  的异常契约上先定义「异常时如何报告进程状态」。
- **重启门禁依赖调用方传入 `load_in_flight_records`。**
  真实常驻入口经 `fileInFlightStore` 自动带上；直接调 `runDaemon` 的调用方若不传，
  门禁不生效（与 `DaemonDeps` 其余可选依赖风格一致）。已在测试 ⑨ 用真实
  `fileInFlightStore` 覆盖集成路径。
- 真实 Worker 的 403/409、旧租约、单活动租约、报告约束仍未联调（属 P3 工作）。
- 目标业务仓库的推送授权、真实双机联调仍未执行。

## 五、不做的事

- 未改 `apps/coordinator/**`、`packages/protocol/**`、`.github/workflows/**`。
- 未删除任何测试、未跳过任何用例、未放宽验收基线。
- B7 / B8 分支未被改写。
