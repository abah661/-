# B7-B：进程终止链有界化返修报告

日期：2026-09-28

分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7`（基线 = B6 顶端 `aa28374`，未改写 B6）

依据：A 端《A → B：B6 独立验收与 B7 返修项》（2026-09-25）

## 结论

A 端 P0 成立，且**根因就是评审单指出的那一行**：终止升级链在第 3 级之后仍然
`await Promise.all([stdoutPromise, stderrPromise])`，同时 `killTree()` 调用与 `taskkill`
自身都没有上限。B7 已把**每一个可能不结束的等待都加上上限**，并把失败原因变成
可观察的字段；新增 11 条确定性回归用例。本地 `npm run check` 退出码 `0`。

## 一、根因（不凭信任，逐行核对）

`apps/executor/src/core/process.ts` 原实现的三处无界等待：

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | 第 3 级之后 `await Promise.all([stdoutPromise, stderrPromise])` | 流永不结束 → 永不返回（**A 端最小复现命中的就是这里**） |
| 2 | `await killer.killTree(pid, false/true)` | 注入的 killer 或系统 `taskkill` 卡住 → 永不返回 |
| 3 | `SystemTreeKiller.killTree` 内 `await` 一个 `close`/`error` 二选一的 Promise | `taskkill` 挂住 → 永不返回；且**完全忽略退出码**，失败与成功无法区分 |

第 3 条还带来一个连带缺陷：`killTree` 返回 `void`，于是「taskkill 因权限被拒绝」
与「taskkill 成功杀掉」在调用方看来一模一样 —— 这违反评审单要求的
「调用失败或超时要留下可观察的失败信息」。

## 二、修法：四层全部有界

等待原语只有一个 `settledWithin(promise, ms)`，本文件里**没有任何 `await` 是无界的**。

| 层级 | 上限 | 超时后的行为 |
| --- | --- | --- |
| `SystemTreeKiller.killTree`（`taskkill` 本身） | `DEFAULT_KILL_TIMEOUT_MS = 5_000` | 中断该命令（`abort()`）并返回 `ok:false` + 原因 |
| `runProcess` → `killBounded()`（每次 killer 调用） | `kill_timeout_ms`（默认同 5_000） | 放弃等待并记入 `kill_detail`；不再把承诺交给对方遵守 |
| 第 3 级强杀后 | 无额外等待 | 立即 `kill_failed=true`、`exit_code=null` 返回 |
| stdio 收集 | `drain_ms`（默认 `min(grace_ms, 1000)`） | 用**已收到的部分输出**返回，并记录「输出可能被截断」 |

**最坏耗时上界**（可写进运维文档）：

```
timeout_ms + 2×grace_ms + 2×kill_timeout_ms + drain_ms
默认 = timeout_ms + 21s
```

`spawn_failed` 分支保持原样：启动失败时**不等任何流**，直接返回。

### 2.1 为什么 `killBounded` 这一层不能省

只修 `SystemTreeKiller` 是不够的：`deps.killer` 是注入点，换一个实现就把
「有界返回」的承诺重新交了出去。所以 `runProcess` 对**任何** killer 都套一层上限，
并且 killer 抛异常也被捕获（`killer 抛出异常：…`），不会把异常变成未处理拒绝。

### 2.2 部分输出不能丢

原实现用 `collectStream` 收集，流不结束时连**已经拿到的内容**也拿不到。
改成 `captureStream`：内容增量落进数组，`text()` 可随时读取，
`done` 内部吞掉流错误、**永不拒绝**（避免「读流出错」升级成未处理拒绝）。
`collectStream` 作为对外 API 保留，语义不变。

## 三、可观察性：失败不再只是一个布尔值

| 新增字段 | 位置 | 内容 |
| --- | --- | --- |
| `KillOutcome { ok, detail }` | `killTree()` 返回值 | 停止动作是否确认生效；失败/超时原因 |
| `RunProcessResult.kill_detail` | `runProcess` 结果 | killer 失败/超时、taskkill 非零退出或卡住、强杀后仍未退出、stdio 未关闭 |
| `EvidenceResult.termination_detail` | `collectEvidence` 结果 | 直接透传 `kill_detail` |
| `report.note` | `attempt.ts` → 归一化备注 | `测试进程终止异常：…`（与原有「租约丢失」备注并列，超 2000 字符由既有逻辑截断） |

这样云端不再只看到 `exit_code=1`，而能区分「测试真的失败」与
「进程杀不掉、需要人工介入」。

`taskkill` 的识别规则（读 stderr，非零退出时）：

- 退出码 `0` → `ok:true`
- 输出匹配 `not found` / `找不到` / `没有找到` → 进程本就不存在 → `ok:true`（不算失败）
- 其他非零 → `ok:false`，detail 带退出码 + stderr 首行
- 未在窗口内返回 → `ok:false`，detail 明写「未在 Nms 内返回，已中断（pid=…）」

POSIX 分支：负 PID 组信号 `ESRCH` → `ok:true`（组已不存在）；其他错误 → `ok:false` + errno。

## 四、新增回归用例（11 条，全部确定性、不依赖机器权限）

`tests/executor/core-process.test.ts` 新增 36 - 25 = 11 例。

### 4.1 runProcess 有界返回（5 例）

| 用例 | 断言 |
| --- | --- |
| 永不退出的进程 + 不生效的 killer + 永不关闭的流（A 端复现场景） | 有界返回；`timed_out=true`、`kill_failed=true`、`exit_code=null`、`stdout` 保留已收到的部分内容 |
| killer 调用自身挂住（`new Promise(() => {})`） | 有界返回；`kill_detail` 同时含「killer 未在 30ms 内返回」与「强杀后进程仍未退出」 |
| killer 报告 `taskkill` 失败 | `kill_detail` 含「taskkill 退出码 1」与原始错误文本 |
| killer 抛异常 | 不被吞掉也不挂住；`kill_detail` 含「killer 抛出异常：boom」，超时分类不受影响 |
| 进程已退出但 stdout 永不关闭 | 有界返回（不等流）；`exit_code=0` 且输出完整保留；记录「stdio 未在 50ms 内关闭」 |

**「有界返回」怎么断言**：用 `withDeadline(promise, ms)` 包起来（`Promise.race` + 超时 reject）。
如果缺陷复现，测试会以「runProcess 未在 1500ms 内返回（缺少有界返回）」**失败**，
而不是把 vitest 挂到 5 秒超时——失败的语义必须指向真正的原因。

### 4.2 SystemTreeKiller 有界与可观察（5 例）

注入 `runner` 与 `platform: "win32"`，因此 **Windows 专属分支在 Linux CI 上同样被执行**：

`taskkill` 卡住（含 `abort()` 被调用）／非零退出（带退出码+stderr）／
「进程不存在」→ `ok:true`／未能启动（`spawn ENOENT`）／正常结束 → `ok:true`。

### 4.3 端到端：超时不得产生 `ready_for_integration`（1 例）

测试进程永不退出 + 输出流永不关闭 → `collectEvidence` 有界返回，
`evidence.exit_code !== 0`、`summary_parsed=false`、`termination_detail` 非空；
经 `normalizeResult` 得到 `repair_pending` + `TESTS_FAILED`，
**且 `report.note` 里能看到终止异常**。

## 五、A 端最小复现的本地等价验证

B 端写了等价脚本（`.local/b7-repro.ts`，**已被 `.gitignore` 忽略、未提交**）：
注入永不结算的退出承诺与输出流 + 一个「返回成功但不生效」的 `TreeKiller`，
`timeout_ms=20`、`grace_ms=20`，与 A 端复现参数一致。

```
elapsed_ms: 100
returned: true
within_512ms: true
timed_out: true
kill_failed: true
escalated_to_force: true
exit_code: null
kill_detail: "强杀后进程仍未退出，已放弃等待（pid=999999，可能仍在运行并占用 worktree 锁）；
              stdio 未在 20ms 内关闭，已按已接收到的输出返回（输出可能被截断）"
```

A 端原复现是「等待 512ms 仍未返回」；修复后 **100ms 返回**，且分类正确。

## 六、实际执行的校验（以命令输出为准）

本机：Windows，Node `v22.22.2`（managed），`CI=1`。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | 全量类型检查通过 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` + 全部样例 PASS（含 5 个样例正反向） |
| `npm test` | `0` | **21 文件 452 passed / 1 skipped / 0 failed**（453），33.4 s |
| `npm run check` | `0` | 上述三项串联 |
| `git diff --check` | `0` | 无空白问题 |

对 B6 基线（441 passed / 1 skipped）增量 **+11 例**，1 个 skip 是既有平台门控；
**未删除断言、未跳过失败用例、未降低标准**。

A 端在受限环境中报过超时的两条真实进程用例
（`windows-integration.test.ts`「超时后真实子进程被终止」、
「真实长驻测试命令超时后仍返回可记录的证据」）在本机正常用户权限下**均通过**，
且 B7 未改动它们的任何断言。

## 七、B6 中间 run `36004505007` 的 Windows 失败原因：**未查明**

A 端要求「没有证据时保持未查明」。B 端本轮能取到的**全部客观信息**：

- 作业 `check (windows-latest)`：`failure`，13:17:12 → 13:20:14（**182 s**），
  唯一失败步骤是 `Run project checks`（`npm run check`）。
- 该 check run 的 2 条注解为：1 个 warning（`Node.js 20 is deprecated`）+
  1 个 failure，失败注解全文只有 **`Process completed with exit code 1.`**
  —— 不含任何用例名或错误文本。
- 作业日志端点 `GET /repos/abah661/-/actions/jobs/107649076274/logs` 返回
  **HTTP 403：`Must have admin rights to Repository.`**（B 端本轮再次实测），
  因此**拿不到那 182 秒里的失败详情**。
- 同代码（`7f44579`）之后的 #20（`be9a743`）、#21（`aa28374`）Windows 均 `success`（28 s 量级），
  本地（含模拟 CI 无 opencode 环境）441 例全绿。

**B 端不推断它就是本问题，也不把它写成「偶发」**：结论保持「未查明」，
需要 A 端（有仓库 admin 权限）打开该作业日志给出失败用例名；
如果那是 B 端可归因的缺陷，B 端按新返修项处理。

## 八、兼容性与边界（逐条对照评审单）

- ✅ 保持 B6 的记录保留语义：未触碰 `fileInFlightStore()` / `load_in_flight()`。
- ✅ 保持 OpenCode 启动配置：未触碰 `adapters/opencode-launcher.ts`，
  仍为原生 `opencode.exe` 绝对路径、`shell: false`、**参数数组**。
- ✅ **不改协议**：未触碰 `packages/protocol/**`；`RunProcessResult`/`EvidenceResult`
  是执行器内部类型，不进协议；`report.note` 是既有字段。
- ✅ 未修改 A 端协调器、CI（`.github/workflows/ci.yml` 只读核对过：`timeout-minutes: 15`，
  两个 OS 都跑同一条 `npm run check`）。
- ✅ 改动范围（`git diff --name-only` 实测）仅：
  `apps/executor/src/core/{process,evidence,attempt}.ts`、`tests/executor/core-process.test.ts`
  + 本文档与交接单。

## 九、未执行（不得写成成功）

- Windows / Linux **CI 结果**：见交接单（`docs/handoff/B-to-A-B7-complete.md`），以实际运行为准。
- 真实 OpenCode 模型调用、P3 双机验收、P5 自动返修：**均未执行**。
- A 端受限环境下的两条超时用例：B 端无法在本机复现该权限环境，**未在其下验证**。
