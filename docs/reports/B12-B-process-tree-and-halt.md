# B12 交付报告：受控进程树观察 + unsafe 短路 + kill_failed 证据强度

- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B12`
- 基线：A 端复验的 B11 顶端 `090b6268a1dfdcc3c6fa27e6a6faa24cc9c07e47`
- 触发：A 端《B11 独立复验》三项阻塞（§三 P1-A / P1-B / P2）与类型检查裁定（§b）

---

## 1. 结论

三项阻塞逐条落地：进程状态的观察单位从**直接子进程**提升为**整棵受控进程树**；
`unknown` / `residual` 时 attempt **在核对 diff 之前短路**全部 worktree 操作；
`kill_failed` 不再被冒充成「已确认残留」。`tests/**` 的类型检查按 A 的裁定
只做了**一次性本地补查**（`.local/tsconfig.tests.json`），未改根配置。

---

## 2. 逐条对应 A 的阻塞

### 2.1 P1-A：观察单位必须是**整棵受控进程树**

> A 原文：「B11 只跟踪/终止直接子进程……必须按整棵受控进程树的状态观察；
> Windows 需要可靠的树/Job 语义，POSIX 需要显式进程组或等价物。」

| 平台 | 隔离与终止 | 存活观察 |
| --- | --- | --- |
| POSIX | `spawn(..., { detached: true })` → 独立进程组；`kill(-pgid)` | 组探测 `process.kill(-pgid, 0)` |
| Windows | `taskkill /PID <pid> /T [/F]`（树语义） | 按 `ParentProcessId` 递归枚举后代（CIM `Win32_Process`） |

新增 `apps/executor/src/core/proc-tree.ts` 作为**唯一**的进程状态来源，测试进程
（`core/process.ts`）与 agent 进程（`adapters/opencode.ts`）共用同一套判定，
避免两条链对「什么叫已停止」给出两种解释。

判定顺序（全新，且**全程不读 `exit_code`**）：

```
spawn_failed
  → close 观察到? ──是──→ 问树：gone→stopped / alive→residual / unknown→unknown
                    └─否──→ 主动探测 alive→residual，否则 unknown
```

关键点：**「观察到 close」从此不再等于「已停止」**。A 复现的正是这一步——
父进程关闭、分离后代仍在写同一个 worktree。

### 2.2 P1-B：`unknown` / `residual` 时**在 attempt 内立即短路**

> A 原文：「不得继续 worktree 相关操作：不跑测试、不暂存、不提交、不推送、
> 不清理；保留 worktree 与持久化停机记录；仍生成并上报明确的失败结果，然后停机。
> 只有 `not_started` / `stopped` 才允许继续验证与提交。」

实现（`core/attempt.ts`）：

| 位置 | 行为 |
| --- | --- |
| agent 返回后（3b 段） | `isUnsafeProcessState` → **核对 diff 之前**就返回；不跑测试、不暂存、不提交 |
| 短路时生成的结果 | **刻意声明「未执行核对」**：`DiffCheckResult.error` 非空、`evidence: null`、`head_sha = base_sha` —— 不伪造「无变更」或「核对通过」 |
| 测试进程合并后 | `combineProcessStates` 取更严者；不安全则同样不提交、不推送、不清理 |
| 提交门 | 新增 `isUnsafeProcessState` 一道拦截（测试进程也可能是来源） |
| `finally` 清理 | 新增 `!isUnsafeProcessState` 守卫：即使调用方要求清理也不清 |
| 常驻入口（`daemon.ts`） | 新增 `skipped_unsafe_process` 结果档：**仍如实上报**该失败结果（否则协调器永远等不到这个 attempt 的下落），但不推送、不清理，标记 `halted_residual_process` / `halted_process_unknown` 后停机 |

`AttemptTrace` 因此新增 `shortCircuited`，与 `sideEffectsSkipped` **分开**：
后者可能是「取消」或「租约丢失」，把三件事混成一个字段会让记录写下
一个根本没发生的原因。

### 2.3 P2：`kill_failed` 不得冒充「已确认残留」

> A 原文：「`kill_failed` 直接映射成 `residual` 不成立：未观察到关闭只证明
> `unknown`；只有确认存活才证明 `residual`。」

- `RunProcessResult` / `EvidenceResult` 新增 `process_state: ControlledProcessState`；
- `haltSignalOf()` 里 `kill_failed` 不再升级为 `residual`，改为
  `{ unsafe: true, state: "unknown" }` —— **仍然停机**，但日志与持久化状态
  分别用「已确认残留」与「状态未知」两套措辞，不伪造证据强度；
- 确认存活（探测答 `alive`）时如实记 `residual`，那条路径不受影响。

---

## 3. 实测得到的两个非显然事实（写下来供 A 复核）

### 3.1 Windows 上「分离」是后代存活的前提，且它由**控制台**决定

A 的复现场景是「一个**分离**、stdio 为 ignore 的长驻后代」。本机实测：

| 后代启动方式 | 父进程 `process.exit(0)` 之后 |
| --- | --- |
| `stdio: 'ignore'`（**不**分离） | **已死**（`process.kill(pid,0)` → `ESRCH`） |
| `stdio: 'ignore', detached: true` | **仍存活** |

原因：不分离的子进程与父进程**共用同一个控制台**，父进程退出时控制台关闭，
子进程被一并终止。因此「父关闭、后代仍活」这个前提**必须**用 `detached: true`
构造；否则用例会退化成一句空断言（探针如实答 `gone`，被**正确**判成 `stopped`）。
本分支的回归用例已按此修正。

### 3.2 只按 `ParentProcessId` 枚举**并不充分**：必须带创建时间窗口

Windows 在进程退出时保留其记录下来的创建者 pid，而 pid 又会被**回收复用**。
于是「`ParentProcessId == 我们的 root pid`」并不能证明那进程是我们的后代，
它也可能是**更早的树**留下的孤儿（其父 pid 后来被回收给了我们）。

实测证据：全量并行测试时，同一份代码里 `B6 §8 连续两个 attempt` 用例在
4 次全量运行中失败 1 次（`expected 'halted_residual_process' to be 'reported'`），
而 `tests/executor/real-chain.test.ts` **单独运行 4/4 通过**；探针本身在
隔离环境下反复验证正确（死 pid → 0；已退出子进程 → 0；活父+活子 → 1）。

因此 `probeTree` 现在接受一个**创建时间窗口**，只统计落在窗口内的进程：

- `created_after_ms` = root 的**创建时刻**。后代不可能早于祖先出现 ——
  这条边界**永不误杀真实后代**，正是它剔掉了上面那类孤儿；
- `created_before_ms` = root 的**退出观察时刻 + 50ms**。祖先退出后不可能再创建
  后代，这条边界挡掉「pid 复用者新拉起的子进程」。两个时间戳取自 Windows
  同一套系统时钟（`KUSER_SHARED_DATA`），共享 ~15.6ms 的更新粒度，50ms 余量
  足以覆盖其粒度而不误杀。

创建时刻**读不到**时（记为 0）一律**计入**：过滤只允许删除**可证明无关**的进程，
漏判残留的代价远大于多停一次。

**仍存在的暴露面（如实记录）**：pid 恰好在探针窗口内被复用、且复用者立刻拉起
子进程时，仍可能被算作后代。真正彻底的方案是 Windows Job Object（创建即绑定、
退出即整树回收），需要原生模块，不进本执行器的依赖表。该暴露面的失败方向是
**多停一次人工确认**，绝不会冒称 `stopped`。

### 3.3 一次**假失败**：注入代理环境变量会打穿既有的证据哈希用例（**非本分支回归**）

本节如实记录一次全量检查的**非零退出**，以及定位与证毕过程——因为它的触发条件
（在带代理的环境变量下跑检查）**A 端很可能也会踩到**，先说清楚可以省掉一轮误判。

**现象**：`npm run check` 退出码 **1**，唯一失败用例是既有的
`tests/executor/windows-integration.test.ts` ›「SHA-256 对相同输入可复现、对不同输入不同」：

```
expect(a1.evidence.output_sha256).toBe(a2.evidence.output_sha256);
```

**根因**（已证毕）：该次检查的父 shell 里带了
`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=http://127.0.0.1:7897`（本机跑真实 Worker
所需）。这两个变量被测试里的**子进程**继承，Node 随即向 **stderr** 打印：

```
(node:<PID>) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.
(Use `node --trace-warnings ...` to show where the warning was created)
```

而 `collectEvidence` 的哈希口径是 `sha256(stdout + "\n" + stderr)`（`evidence.ts:137,146`），
于是**含 PID** 的警告文本进了哈希，两次运行的 PID 不同 → 两个哈希不同。

**证毕**：对观测到的 4 个哈希逐个反查，全部**精确等于**
`sha256("same-output" + "\n" + warningText(PID))`：

| 观测哈希 | 反查出的 PID | 出现位置 |
| --- | --- | --- |
| `eb94ccbc…` | 6672 | 全量检查 a2 |
| `feee3713…` | 32668 | 全量检查 a1 |
| `e0a5012b…` | 25776 | 隔离复现 a2 |
| `b98e785c…` | 3196 | 隔离复现 a1 |

对照实验：**同一份代码**，把两个变量移除后跑该用例 → **通过**；重新注入 → **稳定失败**
（不是「偶发」，是确定性触发）。

**结论**：这与 B12 无关。本分支对 `evidence.ts` 的改动**纯属追加**
（新增 `process_state` 字段并透传），没有触碰哈希口径；失败用例是 B11 之前
就存在的，它对「子进程 stderr 为空」的隐含假设在带代理变量的环境下不成立。

> **暴露的既有脆弱点（不在本分支范围，提请裁定）**：该用例的执行环境未受控，
> 任何会让子进程多吐一行 stderr 的环境都会被算进 `output_sha256`。最小稳健化做法是
> 在用例里显式给子进程一个受控 `env`（而不是继承父进程环境）。
> **本分支刻意未改它**：它不在你三项阻塞的范围内，改了会扩大 diff。
> 是否要把它并入 §6 提到的那个**最小分支**一起修，请裁定。

---

## 4. 检查记录（均为实跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（主干） | `npm run typecheck` | 退出码 **0** |
| 协议校验 | `npm run validate:protocol` | 见 §5 |
| 全量测试（**带**代理变量） | `npm run check` | 退出码 **1** — 唯一失败见 §3.3（**假失败，非本分支回归**） |
| 全量测试（**干净**环境） | `npm run check` | 退出码 **0**（见 §5） |
| `tests/**` 一次性类型检查 | `tsc -p .local/tsconfig.tests.json` | 13 项错误，见 §6 |
| 空白/冲突检查 | `git diff --check` | 无输出（无空白错误） |

---

## 5. 全量检查与 SHA

| 项 | 值 |
| --- | --- |
| `npm run check`（**干净环境**） | 退出码 **0** |
| 测试文件 | `Test Files  22 passed (22)` |
| 用例 | `Tests  567 passed | 1 skipped (568)` |
| 耗时 | 221.46 s |
| 代码提交 SHA | 见交接单《B-to-A-B12-complete.md》§六 |

> 同一次检查在**父 shell 带代理变量**时退出码为 1，唯一失败是 §3.3 记录的假失败。
> 两次运行的差异仅为进程环境变量，代码未变。

---

## 6. `tests/**` 类型检查的现状（A 的裁定 §b）

在 `.local/tsconfig.tests.json`（`include` 覆盖 `tests/**`、`apps/executor/src/**`、
`packages/protocol/src/**`；`lib` 只用 `ES2023`）下实跑得到 13 项错误，
与 A 复现的完全一致：

| 归属 | 数量 | 位置 | 处置 |
| --- | --- | --- | --- |
| A 的测试配置缺 DOM 类型 | 1 | `apps/coordinator/src/api.ts:93` `HeadersInit` | **A 侧配置**（加入 DOM 类型即消失） |
| A 的 `validateTimingConfig` 类型过窄 | 1 | `tests/protocol/schemas.test.ts:341` | **A 修正**（`120000` 不满足 `max(30000)`） |
| B 的 `tests/executor/**` | 11 | `core-process.test.ts` ×9、`http-transport.test.ts` ×1、`normalize.test.ts` ×1 | **B 另开最小分支修复**（A 已同意） |
| （本分支引入的 1 项） | 0 | `daemon.test.ts` 的 `AttemptTrace` 字面量缺 `shortCircuited` | **已在本分支修掉** |

> 为什么本分支只修了 1 项：`shortCircuited` 是 B12 自己加进 `AttemptTrace` 的字段，
> 漏改字面量是本分支的回归，必须随本分支修好；其余 10 项是 B11 之前就存在的
> 历史欠账，按 A 的裁定走独立最小分支，不与 B12 混在一起。

**根配置未被本分支修改**：`tsconfig.json`、`package.json`、
`.github/workflows/**`、`packages/protocol/**`、`apps/coordinator/**` 一律未动。
