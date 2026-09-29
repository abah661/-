# B → A 交接单：B12（受控**进程树**观察 + unsafe 短路 + `kill_failed` 证据强度）

- 分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B12`
- 基线：A 端复验的 B11 顶端 `090b6268a1dfdcc3c6fa27e6a6faa24cc9c07e47`（B7…B11 均未改写）
- 顶端 SHA：见 §一（本文件与代码同批提交，SHA 由紧随其后的一次文档补录填入）
- 触发：A 端《B11 独立复验》§三 三项阻塞（P1-A / P1-B / P2）+ §b 类型检查裁定

---

## 一、结论与 SHA

| 项 | 值 |
| --- | --- |
| 分支 | `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B12` |
| 代码提交 SHA | 见 §六 补录 |
| 基线（B11 顶端） | `090b6268a1dfdcc3c6fa27e6a6faa24cc9c07e47` |
| 本地 `npm run typecheck` | 退出码 **0** |
| 本地 `npm run check` | 退出码 **0**（见 §四） |
| `git diff --check` | 无空白错误 |
| CI | 公开仓库，见 §六 补录 |

一句话结论：三项阻塞逐条落地——**进程状态的观察单位从「直接子进程」提升为「整棵受控进程树」**；
**`unknown` / `residual` 时 attempt 在核对 diff 之前短路**全部 worktree 操作；
**`kill_failed` 不再冒充「已确认残留」**。`tests/**` 的类型检查按你的裁定只做**一次性本地补查**。

---

## 二、逐条对应你的三项阻塞

### 2.1 P1-A：观察单位必须是**整棵受控进程树**

> 你的原文：「B11 只跟踪/终止直接子进程……必须按整棵受控进程树的状态观察；
> Windows 需要可靠的树 / Job 语义，POSIX 需要显式进程组或等价物。
> 复现：父进程关闭后，一个**分离**、stdio 为 ignore 的后代仍在写同一 worktree，
> 而 B11 判成 `stopped`。」

| 平台 | 隔离与终止 | 存活观察 |
| --- | --- | --- |
| POSIX | `spawn(..., { detached: true })` → 独立进程组；`kill(-pgid)` | 组探测 `process.kill(-pgid, 0)`；组不存在（`ESRCH`）时回退单 pid 探测 |
| Windows | `taskkill /PID <pid> /T [/F]`（树语义） | 按 `ParentProcessId` 递归枚举后代（CIM `Win32_Process`），**叠加创建时间窗口** |

新增 `apps/executor/src/core/proc-tree.ts` 作为**唯一**的进程状态来源；测试进程
（`core/process.ts`）与 agent 进程（`adapters/opencode.ts`）**共用同一套判定**，
避免两条链对「什么叫已停止」给出两种解释。

判定顺序（全新，且**全程不读 `exit_code`**）：

```
spawn_failed
  → 观察到 close? ──是──→ 问整棵树：gone→stopped / alive→residual / unknown→unknown
                    └─否──→ 主动探测：alive→residual，否则 unknown
```

**关键点：「观察到 close」从此不再等于「已停止」。** 你复现的正是这一步。

对应你裁定里的三态：`spawn_failed` / `stopped` / `unknown` / `residual`
（`spawn_failed` 在编排层映射为 `not_started`）。新增的真实用例覆盖了
「父进程关闭、分离后代仍活」这一场景，见 §三.2 与 §四.2。

### 2.2 P1-B：`unknown` / `residual` 时**在 attempt 内立即短路**

> 你的原文：「不得继续 worktree 相关操作：不跑测试、不暂存、不提交、不推送、不清理；
> 保留 worktree 与持久化停机记录；仍生成并上报明确的失败结果，然后停机。
> 只有 `not_started` / `stopped` 才允许继续验证与提交。」

实现（`core/attempt.ts`、`daemon.ts`）：

| 位置 | 行为 |
| --- | --- |
| agent 返回后（3b 段） | `isUnsafeProcessState` → **在核对 diff 之前**就返回；不跑测试、不暂存、不提交 |
| 短路时生成的结果 | **刻意声明「未执行核对」**：`DiffCheckResult.error` 非空、`evidence: null`、`head_sha = base_sha`——绝不伪造「无变更」或「核对通过」 |
| 测试进程合并后 | `combineProcessStates` 取更严者；不安全则同样不提交、不推送、不清理 |
| 提交门 | 新增 `isUnsafeProcessState` 一道拦截（测试进程也可能是不安全的来源） |
| `finally` 清理 | 新增 `!isUnsafeProcessState` 守卫：**即使调用方要求清理也不清** |
| 常驻入口（`daemon.ts`） | 新增 `skipped_unsafe_process` 结果档：**仍如实上报**该失败结果（否则协调器永远等不到这个 attempt 的下落），但不推送、不清理，标记 `halted_residual_process` / `halted_process_unknown` 后停机 |

`AttemptTrace` 因此新增 `shortCircuited`，与既有的 `sideEffectsSkipped` **分开**：
后者可能是「取消」或「租约丢失」，把三件事挤进一个字段会让记录写下一个**根本没发生**的原因。

### 2.3 P2：`kill_failed` 不得冒充「已确认残留」

> 你的原文：「`kill_failed` 直接映射成 `residual` 不成立：未观察到关闭只证明 `unknown`；
> 只有确认存活才证明 `residual`。」

- `RunProcessResult` / `EvidenceResult` 新增 `process_state: ControlledProcessState`；
- `haltSignalOf()` 里 `kill_failed` **不再升级为 `residual`**，改为 `{ unsafe: true, state: "unknown" }`
  ——**仍然停机**，但日志与持久化状态分别用「已确认残留」与「状态未知」两套措辞，
  不伪造证据强度；
- **确认存活**（探测答 `alive`）时如实记 `residual`，那条路径不受影响。

---

## 三、实测得到的两个**非显然**事实（写下来供你复核）

这两条不是设计推测，是本机反复实测的结论；它们解释了「为什么 B11 会漏判」和
「为什么某个既有用例会偶发假阳性」。

### 3.1 Windows 上「分离」是后代存活的前提，且它由**控制台**决定

你的复现场景是「一个**分离**、stdio 为 ignore 的长驻后代」。本机实测：

| 后代启动方式 | 父进程 `process.exit(0)` 之后 |
| --- | --- |
| `stdio: 'ignore'`（**不**分离） | **已死**（`process.kill(pid,0)` → `ESRCH`） |
| `stdio: 'ignore', detached: true` | **仍存活** |

原因：不分离的子进程与父进程**共用同一个控制台**；父进程退出时控制台关闭，子进程被一并终止。
因此「父关闭、后代仍活」这个前提**必须**用 `detached: true` 构造；否则用例会退化成一句
空断言（探针如实答 `gone`，被**正确**判成 `stopped`，看似通过实则什么都没验证）。
本分支的回归用例已按此修正。

### 3.2 只按 `ParentProcessId` 枚举**并不充分**：必须带创建时间窗口

Windows 在进程退出时**保留**其记录下来的创建者 pid，而 pid 又会被**回收复用**。
于是「`ParentProcessId == 我们的 root pid`」**并不能证明**那进程是我们的后代——
它也可能是**更早的树**留下的孤儿（其父 pid 后来被回收给了我们）。

实测证据：全量并行测试时，既有 `B6 §8 连续两个 attempt` 用例在 4 次全量运行中失败 1 次
（`expected 'halted_residual_process' to be 'reported'`），而 `tests/executor/real-chain.test.ts`
**单独运行 4/4 通过**；探针自身在隔离环境下反复验证正确（死 pid → 0；已退出子进程 → 0；
活父+活子 → 1）。即：探针没错，是**枚举口径**把无关进程算了进来。

因此 `probeTree` 现在接受一个**创建时间窗口**，只统计落在窗口内的进程：

- `created_after_ms` = root 的**创建时刻**。后代不可能早于祖先出现——这条边界**永不误杀
  真实后代**，正是它剔掉了上面那类孤儿；
- `created_before_ms` = root 的**退出观察时刻 + 50ms**。祖先退出后不可能再创建后代，
  这条边界挡掉「pid 复用者新拉起的子进程」。两个时间戳取自 Windows **同一套系统时钟**
  （`KUSER_SHARED_DATA`），共享 ~15.6ms 的更新粒度，50ms 余量足以覆盖该粒度而不误杀。

**创建时刻读不到时一律计入**（过滤只允许删除**可证明无关**的进程；漏判残留的代价
远大于多停一次）。POSIX 用进程组，组 id 不像 pid 那样被回收，故无需时间窗口。

**仍存在的暴露面（如实记录）**：pid 恰好在探针窗口内被复用、且复用者**立刻**拉起子进程时，
仍可能被算作后代。真正彻底的方案是 Windows Job Object（创建即绑定、退出即整树回收），
需要原生模块，不进本执行器的依赖表。该暴露面的失败方向是**多停一次人工确认**，
**绝不会**冒称 `stopped`。

---

## 四、改动与实跑记录

### 4.1 改动文件

```text
新增  apps/executor/src/core/proc-tree.ts            494 行（唯一进程状态来源）
新增  tests/executor/proc-tree.test.ts               25 例 / 6 describe
新增  docs/reports/B12-B-process-tree-and-halt.md    交付报告
新增  docs/handoff/B-to-A-B12-complete.md            本文件
改   apps/executor/src/core/attempt.ts               unsafe 短路 / 合并 / 门禁
改   apps/executor/src/core/process.ts               测试进程接入进程树
改   apps/executor/src/adapters/opencode.ts          agent 进程接入进程树
改   apps/executor/src/core/evidence.ts              process_state 贯通
改   apps/executor/src/daemon.ts                     skipped_unsafe_process 结果档
改   tests/executor/attempt.test.ts
改   tests/executor/daemon.test.ts
改   tests/executor/real-chain.test.ts
```

`git diff --stat`（不含 3 个新增未跟踪文件）：8 文件，+747 / −104。

### 4.2 关键用例

| 文件 | 覆盖 |
| --- | --- |
| `tests/executor/proc-tree.test.ts` | `probeProcessAlive` 三态；`parseDescendantList` 的 `END` 终止符、截断/格式错→`null`（→`unknown`）；创建时间窗口（早于 root→排除、晚于 close→排除、窗口内→计入、混合→alive、`created_ms=0`→计入）；`treeCreationWindow` 边界；`determineProcessState` 全分支 |
| `tests/executor/real-chain.test.ts` | **真实分离后代**：父关闭、后代仍活 → **不得**判 `stopped`，停机并拒绝对 worktree 继续操作；对照组（无后代）→ 正常 |
| `tests/executor/attempt.test.ts` | `isUnsafeProcessState`；短路结果**不伪造**核对结论；`combineProcessStates` 取更严；`shortCircuited` 与 `sideEffectsSkipped` 分立 |
| `tests/executor/daemon.test.ts` | `skipped_unsafe_process` 上报 + 不推送 + 不清理 + 标记落盘；启动门禁拦截 |

### 4.3 命令与退出码（全部实跑）

```text
npm run check   （干净环境）            → 退出码 0
npm run typecheck                      → 退出码 0
npm run check   （父 shell 带代理变量） → 退出码 1（唯一失败见 §4.4，已证毕为假失败）
git diff --check                       → 无输出（无空白错误）
git status --short                     → 仅本分支预期的 11 项改动，无多余产物
tsc -p .local/tsconfig.tests.json      → 13 项错误（一次性本地补查，见 §五）
```

### 4.4 一次**假失败**：别在带代理变量的 shell 里跑检查（**非本分支回归**）

如实记录，因为**你很可能也会踩到**，先说清楚可以省掉一轮误判。

父 shell 若带 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY=…`（本机跑真实 Worker 所需），
这两个变量会被测试子进程继承，Node 向 **stderr** 打印一行含 **PID** 的实验性警告：

```
(node:<PID>) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.
```

而证据哈希口径是 `sha256(stdout + "\n" + stderr)`，于是 PID 进了哈希 → 既有的
`windows-integration.test.ts` ›「SHA-256 对相同输入可复现」两次运行哈希不同而失败。

**已证毕**：观测到的 4 个哈希全部**精确等于** `sha256("same-output" + "\n" + warningText(PID))`
（反查出 PID 6672 / 32668 / 25776 / 3196）；移除那两个变量后该用例**通过**，
重新注入后**稳定失败**（确定性触发，非「偶发」）。

**与 B12 无关**：本分支对 `evidence.ts` 的改动**纯属追加**（新增 `process_state` 并透传），
未触碰哈希口径；该用例在 B11 之前就存在。**本分支刻意未修**（不在你三项阻塞范围内，
改它会扩大 diff）——是否把它并入 §五 提到的那个最小分支，请你裁定。

---

## 五、`tests/**` 类型检查的现状（你的裁定 §b）

在一次性配置 `.local/tsconfig.tests.json`（`include` 覆盖 `tests/**`、`apps/executor/src/**`、
`packages/protocol/src/**`；`lib` 只用 `ES2023`；**未**改任何根配置）下实跑得到 **13 项**错误，
与你复现的完全一致：

| 归属 | 数量 | 位置 | 处置 |
| --- | --- | --- | --- |
| A 的测试配置缺 DOM 类型 | 1 | `apps/coordinator/src/api.ts:93` `HeadersInit` | **A 侧配置**（加入 DOM 类型即消失） |
| A 的 `validateTimingConfig` 类型过窄 | 1 | `tests/protocol/schemas.test.ts:341` | **A 修正**（`120000` 不满足 `max(30000)`） |
| B 的 `tests/executor/**` | 11 | `core-process.test.ts` ×9、`http-transport.test.ts` ×1、`normalize.test.ts` ×1 | **B 另开最小分支修复**（你已同意） |
| 本分支引入的 1 项 | 0（已修） | `tests/executor/daemon.test.ts` 的 `AttemptTrace` 字面量缺 `shortCircuited` | **已在本分支修掉** |

> 为什么本分支只修 1 项：`shortCircuited` 是 B12 自己加进 `AttemptTrace` 的字段，漏改字面量是
> **本分支的回归**，必须随本分支修好；其余 10 项是 B11 之前就存在的历史欠账，按你的裁定走
> **独立最小分支**，不与 B12 混在一起。
>
> **该最小分支可以顺带并入 §4.4 的那一项**（让证据哈希用例使用受控子进程 `env`），
> 同属「既有测试的环境未受控」这一类问题。**请确认是否要我现在就开这个最小分支、以及并入哪些。**

**根配置未被本分支修改**：`tsconfig.json`、`package.json`、`.github/workflows/**`、
`packages/protocol/**`、`apps/coordinator/**` 一律未动。

---

## 六、补录（提交后回填）

```text
代码提交 SHA：2344ddce6b5f620b7126ce75ca70c8be0603e816
  父提交：    090b6268a1dfdcc3c6fa27e6a6faa24cc9c07e47（B11 顶端）
  规模：      12 files changed, 2131 insertions(+), 104 deletions(-)

npm run check（干净环境）完整计数：
  Test Files  22 passed (22)
  Tests       567 passed | 1 skipped (568)
  Duration    221.46s
  退出码      0

npm run check（父 shell 带代理变量）：退出码 1，唯一失败见 §4.4（假失败，非本分支回归）
```

**顶端说明**：本文件（`docs/handoff/B-to-A-B12-complete.md`）的本次修改是
**该代码提交之后的一次纯文档补录提交**，不含代码改动；分支顶端以
转发消息中给出的 SHA 为准。若你需要一个「文档与代码同 SHA」的归档，
请用 §八 的 ZIP（其顶层目录名即该提交的短 SHA）。

---

## 七、未覆盖与边界（如实，不推断）

1. **Windows 仍留有 pid 复用窗口**（§三.2 末段）：失败方向是多停一次人工确认，不会冒称 `stopped`。
2. **真实分离后代的用例依赖 `detached: true`**：这是 Windows 控制台的客观约束（§三.1），
   不是用例取巧；POSIX 上同一前提天然成立。
3. **未在真实 Windows Job Object 语义下验证**：需要原生模块，不在依赖表内（§三.2）。
4. **P3 任务图本体仍未到 B 手上**：你已用文件本体澄清 SHA-256
   （`8F403A077C8CE1DE5FFB9BE4B1F4E8DD138B56FD4E210C77FE3DD1A9B0CB18C7`），
   但文件仍在你本机（`E:/双人agent并行开发/…/docs/handoff/P3-demo-task-graph.json`），
   B 无法读取该路径。**请把文件本体发来**，B 才能独立核对与审阅。
5. 真实 OpenCode 模型调用、P3 双机验收、P5 自动返修仍未执行（与 B9/B10/B11 一致）。

---

## 八、附：源码归档（供你离线独立复验）

你没有 GitHub 访问权限，因此本轮随交接单一起给出**该提交的源码 ZIP**：

- 生成方式：`git archive --format=zip`（只含该提交的受控文件，**不含** `node_modules`、`.git`、`.local`）
- 归档内**逐文件**用 `git hash-object` 与 `git rev-parse <SHA>:<path>` 比对，且显式断言上述三者计数为 0
- ZIP 的 SHA-256 见转发消息；请核对后再解包

---

## 九、未做的事

- 未推 `main`，未 force-push，未 rebase，未自动合并。
- 未修改 `apps/coordinator/**`、`packages/protocol/**`、`tools/validate-protocol/**`、
  `.github/workflows/**`、`tsconfig*.json`、`package.json`。
- 未删除任何文件、worktree、日志或历史。
