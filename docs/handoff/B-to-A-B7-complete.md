# B → A：B7 完成交接单（进程终止链有界化）

日期：2026-09-28

审查依据：《A → B：B6 独立验收与 B7 返修项》（2026-09-25，P0 强杀失败时 `runProcess()` 无上界等待）

## 一、一句话结论

A 端 P0 **成立且已修复**；根因就是评审单指出的那处无界 `await`，
除此之外还有两处同类无界等待（killer 调用、`taskkill` 自身）一并修掉；
失败原因已变成可观察字段。新增 11 条确定性回归。本地 `npm run check` 退出码 `0`。

## 二、交付物与提交

分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7`
基线：**B6 顶端 `aa2837408cb98f10b0d619d223c9094b096a1fcd`**（B6 分支未被改写、未被强推）

| # | 提交 SHA | 内容 |
| --- | --- | --- |
| 1 | `205cdf0d3b62d4251069a12f40eb0469db7c44b8` | B7 实现（4 文件，+748/−76）：`process.ts` / `evidence.ts` / `attempt.ts` / `core-process.test.ts` |
| 2 | 见下（文档提交） | 返修报告 `docs/reports/B7-B-process-termination-bounded.md` + 本交接单 |
| 3 | 见下（如有） | 补 CI 运行结果 |

**SHA 核对方式**（本文件若随文档提交前进，其顶端 SHA 无法自指，故以实测为准）：

```bash
git ls-remote origin refs/heads/task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7
git rev-parse HEAD        # 在 B 端 worktree 内
```

B 端推送时两者**逐字一致**的结果记在 §五。

改动范围（`git diff --name-only aa28374..HEAD` 实测）：

```
apps/executor/src/core/attempt.ts
apps/executor/src/core/evidence.ts
apps/executor/src/core/process.ts
tests/executor/core-process.test.ts
```

全部在 B 端允许范围内（`apps/executor/**`、`tests/executor/**`），
外加 `docs/**` 下的报告与交接单。**未触碰** `packages/protocol/**`、
`apps/coordinator/**`、`.github/workflows/**`、`tools/validate-protocol/**`。

## 三、逐条对照 A 端 B7 要求

| A 端要求 | 落实 |
| --- | --- |
| `killTree()` 调用自身必须有有界等待 | `SystemTreeKiller` 内 `settledWithin(handle.done, timeoutMs)`（默认 5 s），超时 `abort()` 并返回 `ok:false` + 原因；POSIX 分支用 errno 区分「已不存在」与真失败 |
| 调用失败或超时要留下可观察的失败信息 | `killTree(): KillOutcome{ok, detail}`；`runProcess` 新增 `kill_detail`；经 `EvidenceResult.termination_detail` 写入 `report.note`（`测试进程终止异常：…`） |
| 最后一级宽限仍未退出时不得再无界等待 stdout/stderr/退出码/信号 | 强杀后立即 `kill_failed=true`、`exit_code=null` 返回；stdio 改为**有界 drain**（默认 `min(grace,1000)` ms），到期用已收到的部分输出；退出码只在 `exited` 为真时从本地变量读取（**无 await**） |
| 用永不退出的进程、永不关闭的流、失败/卡住的 killer 增加确定性回归 | 见下 11 例 |
| 断言函数有界返回 | `withDeadline()`（`Promise.race` + 超时 reject），失败信息直指「缺少有界返回」，不把 vitest 挂到超时 |
| 断言失败分类正确 | `timed_out` / `kill_failed` / `escalated_to_force` / `exit_code=null` / `spawn_failed` 逐项断言 |
| 断言没有 `ready_for_integration` 副作用 | 端到端一例：超时证据经 `normalizeResult` → `repair_pending` + `TESTS_FAILED`，并断言 `status !== "ready_for_integration"` |
| 保持 B6 记录保留语义、OpenCode 启动配置、`shell:false`、参数数组，不改协议 | 未触碰 `fileInFlightStore`/`load_in_flight`、`opencode-launcher.ts`；`shell:false` 与参数数组未动；协议包零改动（含 `runProcess` 在内的类型均为执行器内部类型） |

## 四、新增回归用例（11 条）

`tests/executor/core-process.test.ts`：25 → **36** 例。

1. 永不退出的进程 + 不生效的 killer + 永不关闭的流（**A 端复现场景**）→ 有界返回，
   `timed_out=true`、`kill_failed=true`、`exit_code=null`，**部分输出被保留**
2. killer 调用自身挂住 → 有界返回，`kill_detail` 含「killer 未在 30ms 内返回」
3. killer 报告 `taskkill` 失败 → `kill_detail` 含退出码与原始错误
4. killer 抛异常 → 不挂住、不吞错，超时分类不受影响
5. 进程已退出但 stdout 永不关闭 → 不等流，退出码与输出完整，记录截断提示
6. `taskkill` 卡住 → `ok:false` + `abort()` 确实被调用
7. `taskkill` 非零退出 → `ok:false`，含退出码与 stderr
8. `taskkill` 报「进程不存在」→ `ok:true`（不算失败）
9. `taskkill` 未能启动 → `ok:false`，含启动错误
10. `taskkill` 正常结束 → `ok:true`
11. 端到端：超时证据 → `repair_pending` + `TESTS_FAILED`，**不得** `ready_for_integration`

第 6–10 例注入 `runner` 与 `platform: "win32"`，因此 **Windows 专属分支在 Linux 上也被执行**。

## 五、本地校验与 CI

### 5.1 本地（Windows，Node `v22.22.2` managed，`CI=1`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | 通过 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` + 全部样例 PASS |
| `npm test` | `0` | **21 文件 452 passed / 1 skipped / 0 failed**（453），33.4 s |
| `npm run check` | `0` | 三项串联 |
| `git diff --check` | `0` | 无空白问题 |

### 5.2 A 端最小复现的本地等价脚本

`.local/b7-repro.ts`（**已被 `.gitignore` 忽略，未提交**，与 A 端 `repro-b6-run-process.ts` 同参数）：
`timeout_ms=20`、`grace_ms=20`、永不结算的退出承诺与输出流、返回成功但不生效的 killer。

```
elapsed_ms: 100      returned: true      within_512ms: true
timed_out: true      kill_failed: true   escalated_to_force: true   exit_code: null
```

A 端原复现「512ms 仍未返回」→ 修复后 **100ms 返回**，分类正确。

### 5.3 CI

| 运行 | 提交 | `windows-latest` | `ubuntu-latest` |
| --- | --- | --- | --- |
| 本次推送后的新运行 | 见 §二 | **结果尚未取得**（B 端取得后由下一次提交补录） | 同左 |

## 六、B6 中间 run `36004505007` 的 Windows 失败原因：**未查明**

按要求保持「未查明」，不推断它就是本问题。本轮新取得的客观信息：

- 作业 `check (windows-latest)`：`failure`；`Run project checks` 13:17:12 → 13:20:14（**182 s**），
  其余步骤全部 success。
- 该 check run 有 2 条注解：1 warning（`Node.js 20 is deprecated…`）+ 1 failure，
  失败注解全文仅 **`Process completed with exit code 1.`**，无用例名、无错误文本。
- 作业日志端点本轮再次实测：`GET /repos/abah661/-/actions/jobs/107649076274/logs`
  → **HTTP 403 `Must have admin rights to Repository.`**（B 端无仓库 admin 权限）。
- 同代码 `7f44579` 之后的 #20（`be9a743`）、#21（`aa28374`）Windows 均 success（28 s 量级）。

**结论：未查明。** 需要 A 端（有 admin 权限）打开该作业日志给出失败用例名；
若可归因于 B 端代码，B 端按新返修项处理。

## 七、仍未执行 / 仍等 A 端

- 未执行：真实 OpenCode 模型调用、P3 双机验收、P5 自动返修；
  真实 B 电脑尚未连接测试 Worker 运行任务。
- 仍等 A 提供：`B-executor-token.p7m`（仅 `EXE-B-OPENCODE`）、`PROJECT_ID`、
  独立目标业务仓库 `<TARGET_REPO_URL>`、最小任务图。
- 仍等 A 裁决：B6 交接单 2.1 节的原生 `opencode.exe` 形态差异（B6 已裁定接受，
  本分支未改动该实现）。
- 整合主分支需要另行满足授权表里的目标分支与验收门槛 —— **B 端不会自行合并**。
