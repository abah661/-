# B → A 交接单：B9 残留进程状态分支与重启门禁

| 项 | 值 |
| --- | --- |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B9` |
| 基线 | B8 顶端 `4c65ae2140b85774b910461084883b5b6c9dcaf6` |
| 对应复验单 | 《A → B：B8 独立复验结果与 P3 任务图》第三节 |
| 报告 | `docs/reports/B9-B-residual-process-halt.md` |

## 一、本轮只做一件事

按复验单第三节，把「强杀失败」的保护**从一条路径扩展到全部退出路径**，
并补上**重启门禁**。没有做别的改动，没有触碰协议 / 协调器 / CI。

## 二、逐项对应复验单第三节

### 2.1 「取消 / 租约失效分支不检查 `kill_failed`，日志仍声称已终止」

- 该分支现在先算 `residual = outcome.trace.kill_failed === true`。
- **文案分叉**：残留时不再出现「已终止子进程」，改为
  「……但子进程**未被终止**（kill_failed）：保留残留标记并停止领取新任务……请人工确认残留进程已清理后再启动」。
- 在途记录写 `halted_residual_process`（而非 `skipped_aborted` / `skipped_lease_lost`）。
- 停机：`stop_reason = halt_residual_process`、`break`。
- 优先级：残留 > 取消 > 租约失效。

> 一处刻意的取舍：`attemptRecords[].result` 仍记 `skipped_*`。它回答的是
> 「这次 attempt 是怎么收尾的」（确实没推送没上报），而「本机安不安全」
> 由在途记录的 `state` 回答。两者混在一起会让日志不可读。

### 2.2 「上报失败先写 `failed_to_report`；401/403/409 在停机门之前 break」

- 上报的 `catch` 分支同样先算 `residual`。
- 残留时记录写 `halted_residual_process`，并**优先于** 401/403/409 判断 → 停机。
- 非残留时保持原行为（401/403 → `auth_blocked`；409 → `lease_lost`；其余记录后继续），
  已由测试 ⑤⑥ 反向锁定。

### 2.3 「`isActiveInFlightRecord()` 忽略 `halted_residual_process`，重启后继续领任务」

- 新增 `DaemonDeps.load_in_flight_records?`（**可选**，返回**含终态**的全量记录），
  `fileInFlightStore` 已经提供它。
  刻意不复用 `load_in_flight`：那个只返回活动租约，而 `halted_residual_process`
  **恰恰不是活动租约**——盲点就出在这里。
- 新增导出函数 `findResidualProcessRecord(records)`。
- `runDaemon` 在**健康检查之后、注册之前**加门禁：存在残留标记 → 立即停止，
  `stop_reason = halt_residual_process_on_startup`，**不注册、不领取任何任务**。
- 解除方式只有 `clearInFlightRecord(repoRoot, attemptId)`（显式、需点名 attempt_id）。
  门禁不删除、不推进该记录。

## 三、验证证据（全部实跑，非自述）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | 0 | 无错误 |
| `npm test -- tests/executor/daemon.test.ts` | 0 | **72 passed / 0 failed**（改动前该文件 59 例） |
| `npm run check` | 见 §5 实跑记录 | — |

新增 13 例，逐条对应复验单点名的分支（取消、租约失效、401、403、409、其他错误、
重启门禁），另含 3 条反向锁定（进程正常终止时**不得**误报残留）。
详见报告第三节的用例表。

## 四、需要你确认的一处不一致

你在复验单正文与消息里给出的 P3 任务图 SHA-256 **相差一个字符**：

| 来源 | 值 |
| --- | --- |
| 复验单正文（`.md`） | `8F4`**`0`**`3A077C8CE1DE5FFB9BE4B1F4E8DD138B56FD4E210C77FE3DD1A9B0CB18C7` |
| 消息正文（转发文本） | `8F4`**`D`**`3A077C8CE1DE5FFB9BE4B1F4E8DD138B56FD4E210C77FE3DD1A9B0CB18C7` |

差别在第 4 位（`0` vs `D`）。B **没有**拿到 `P3-demo-task-graph.json` 本体，
所以无法用文件核对；在拿到文件前不作猜测。请把任务图（或权威 SHA-256）发来，
B 核对通过后再审阅图与契约。

其余 P3 输入已确认收到并处理：
- `.p7m` 已在本机解密成功（明文长度 64、可打印 ASCII），只注入进程环境，未落盘。
- `PROJECT_ID = demo-user-profile-p3` 仅作配置核对，**未据此领任务**。

## 五、实跑记录

```text
（npm run check 的完整输出与退出码见提交说明 / CI）
```

## 六、未验证项与边界（不粉饰）

1. **编排异常分支没有残留标记。** `runAttempt` 抛异常时没有 `outcome`，
   `trace.kill_failed` 无从取得，因此无法判断是否留下残留进程。本次未改该分支，
   也没有给它编造默认值。若需覆盖，需先在 `runAttempt` 的异常契约上定义
   「异常时如何报告进程状态」。
2. **启动门禁依赖调用方传入 `load_in_flight_records`。** 真实常驻入口经
   `fileInFlightStore` 自动带上；直接调 `runDaemon` 且不传的调用方门禁不生效。
   集成路径已用真实 `fileInFlightStore` 覆盖（测试 ⑨）。
3. 真实 Worker 的 403/409、旧租约、单活动租约、报告约束仍未联调（P3 工作）。
4. 目标业务仓库的推送授权、真实双机联调均未执行。

## 七、请 A 复验

请对分支顶端做独立复验，重点确认：

- 取消 / 租约失效分支在 `kill_failed` 时**不再出现「已终止」表述**；
- 上报 401/403/409/其他错误 + `kill_failed` 时，在途记录保留 `halted_residual_process`；
- 重启时存在该标记 → **不注册、不领取**；显式清除后才恢复开工。

完成后 B 可继续推进 P3（待你给出任务图与目标仓库授权）。
