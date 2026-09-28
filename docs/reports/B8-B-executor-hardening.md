# B8-B：执行器加固返修报告（A 端 B7-1 ～ B7-6）

日期：2026-09-28

审查依据：《A → B：B7 独立验收与 P3 输入清单》第二节「仍阻止整合的事项」六项
（B7-1 ～ B7-6），A 端要求「可从精确 B7 HEAD 开新的返修尝试分支，保留 B7 历史」。

## 结论

**A 端六项全部成立，已逐项修复，并各配确定性回归。**
本地 `npm run check`（typecheck + validate:protocol + test）**退出码 `0`**，
`21` 个测试文件全部通过、**494 passed / 1 skipped / 0 failed**（495）。

本轮同时暴露并修掉了一个**测试自身的缺陷**（见第六节）：worktree 的 `.git` 是
隐藏文件，普通写法覆写会 `EPERM`，导致一条用例退化成空断言而**假绿**。

## 一、逐项修复

### 1.1 B8-1 执行器停机门槛（A 端 B7-1）

**A 端判定**：`process.ts` 能有界返回并给出 `kill_failed`，但 `attempt.ts` 只把终止异常写进
`report.note`，`daemon.ts` 上报后仍进入下一轮轮询。

**修复（`kill_failed` 现在是一条能停机的信号，而不只是一句备注）**

| 落点 | 改动 |
| --- | --- |
| `core/evidence.ts` | `EvidenceResult` 新增 `kill_failed`，由 `collectEvidence` 从 `runProcess` 的结果带出 |
| `core/attempt.ts` | `AttemptTrace` 新增 `kill_failed`；`collectEvidence` 之后写入 |
| `core/recovery.ts` | `InFlightState` 新增 `halted_residual_process` —— 与 `halted_still_mine` **分开**，因为下次启动时的处置不同（后者是「任务仍归我，可续」，前者是「本机有残留进程，需人工」） |
| `daemon.ts` | 上报**之后**加停机门：不再领取新任务、**不推送**、**不清理 worktree**，`stop_reason = "halt_residual_process"`；在途记录写 `halted_residual_process` |
| `daemon.ts` 推送门 | `ready_for_integration` 且 `kill_failed` 时**拒绝推送**并降级 `failed` / `INTERNAL_ERROR` |
| `daemon.ts` 退出码 | `halt_residual_process` 与非零码退出，调用方不会把它当成一次正常收工 |

三个顺序决策，各自的理由：

1. **停机门放在上报之后**：结果必须如实上报，否则协调器永远等不到这个 attempt 的下落，
   租约要等到自然过期才回收。
2. **不清理 worktree**：清理动作可能被残留进程的文件锁挡住，而「清理失败」会把
   「需要人工处理」伪装成一次普通的清理告警。
3. **推送门在停机门之外**：`kill_failed` 时工作区可能仍被残留进程改写，
   那一刻推上去的提交无法保证对应代码的真实状态——宁可不推。

**回归**：`tests/executor/daemon.test.ts` `describe("B8 §B7-1 残留进程停机门槛")`，2 例：
队列里放**两个**任务（若没有停机门会继续领第二个），断言不再领取、不推送、不清 worktree；
以及反例 `kill_failed=false` 时循环照常继续（避免把停机做成无条件停机）。

### 1.2 B8-2 Git 失败 fail-closed（A 端 B7-2）

**A 端复现**：在不存在的仓库路径调用 `checkDiffScope()` 得到 `ok:true`、空违规列表。

**根因**：对每一条 Git 命令都是「失败就跳过」——`git diff` 失败被当成「没有变更」、
`git status` 失败被当成「工作区干净」。**这不是「检查通过」，而是「根本没检查」。**

**修复（`core/diff-check.ts` 重写核对路径）**

| 改动 | 作用 |
| --- | --- |
| `DiffCheckResult` 新增 `error: string \| null`；**`error` 非 null 时 `ok` 必为 false** | 让「无法确认」与「确认没有越界」在类型上就分得开 |
| `listChangedFiles()` 返回 `{ files, error }`，任一 Git 命令非零退出即整次失败 | 不再吞掉失败 |
| 变更列表改用 `git diff --name-status -z -M`，`parseNameStatusZ()` 解析 | `-z` 避开 `core.quotePath` 把非 ASCII 路径转义成 `"\344\270\255"` 从而绕过范围比对；**`-M` 的重命名源与目标都返回**，否则「把越界文件改名成允许范围内的名字」就能溜过检查 |
| 新增 `verifyWorktreeRoot()`：要求 `rev-parse --show-toplevel` 与 worktree 路径指向**同一位置** | 最隐蔽的情况不是「不是仓库」，而是**worktree 的 `.git` 指针坏了、但它在主仓库目录树内**——此时 Git 向上找到主仓库并正常回答，核对的是**另一个仓库**，「错误的通过」比失败更危险 |
| `globToRegExp` 末尾改为 `new RegExp(out, "i")` | `deny` 是硬边界，宁可比对更宽 |
| 新增 `sameRepoPath()`（`realpathSync.native` + 分隔符归一 + Windows 小写） | 避免 8.3 短路径（`%TEMP%` 常被折叠成 `RUNNER~1`）与大小写造成误判 |

**上游两道门同步收紧**

- `core/attempt.ts` 提交门：`diff.error !== null` 的分支排在「与基线无差异」**之前** ——
  否则 `files` 为空会先命中「无差异」，把核对失败伪装成一次干净的提交。
- `core/commit.ts`：`listStagedFiles()` 由「失败返回空数组」改为返回 `{ files, error }`。
  空数组会让「暂存内容越界 / 敏感 / 为空」三个判断全部落空，于是**读不出暂存内容
  反而被判成「无待提交内容」而放行**。现在返回 `error` 即不提交。
- `result/normalize.ts`：`diff.error !== null` 时 `status = "failed"` +
  `error_code = "INTERNAL_ERROR"`，并排在其他判定之前。选 `INTERNAL_ERROR`（`fatal`）
  而不是 `repair_pending` 的理由：**这不是代码写错，而是环境不可信**，
  自动返修只会在同一个坏环境里再失败一次。备注同步写明原因，避免云端只看到
  `INTERNAL_ERROR` 而不知为何。

**回归（14 例）**

- `core-process.test.ts`：`checkDiffScope fail-closed` 7 例（仓库路径无效 / worktree 被父仓库顶替 /
  基线不存在 / **仅 `git status` 失败** / 全绿反例 / 跨范围重命名 / 未跟踪文件 + `ls-files` 失败）、
  `parseNameStatusZ` 4 例（含空格与非 ASCII 路径不被拆开）、归一化层 1 例
- `windows-integration.test.ts`：`真实 Git fail-closed` 4 例，**用真实 Git 跑**无效路径、
  不存在的基线、真实跨范围重命名、以及真实正常改动仍判 `ok:true`（证明 fail-closed
  没有把正常路径也判失败）
- `real-chain.test.ts` 1 例：真实 worktree 的 git 元数据被破坏 → **不创建提交**、
  `failed` / `INTERNAL_ERROR`、`git_error` 非空

### 1.3 B8-3 敏感边界与子进程环境（A 端 B7-3）

**A 端判定**：`.env`、`.ENV`、`B-token-public.cer`、`.codex/config.toml` 四个样例只命中 `.env`；
且 `process.ts` 会把 `process.env` 继承给测试子进程。

**修复 A：敏感路径模式（`diff-check.ts`）**

- **大小写不敏感**（`globToRegExp` 加 `i`）。Windows/macOS 默认文件系统不区分大小写，
  `.ENV` 与 `.env` 是同一个文件，区分大小写等于给出一条绕过路径。
- **凭据容器扩展名**：新增 `*.cer` `*.crt` `*.der` `*.p7b` `*.jks` `*.keystore`
  （项目自己的 Token 交接第一棒就是 `B-token-public.cer`；交接单 §6.3 明确
  「公钥证书和本地加密副本都不得加入 Git」）。
- **本地凭据目录**：`**/.codex/**`（AGENTS.md 第 7 节点名）、`**/.ssh/**`、`**/.aws/**`、
  `**/.npmrc`、`**/.netrc`。
- 刻意**不**用 `**/*secret*`：那会把 `redact-secret.test.ts` 这类正常源文件判成敏感，
  而敏感命中会直接把结果降级为 `blocked_approval`（阻断提交），误报的代价是
  **正常任务被人为卡住**。宁可精确到「文件名就是凭据容器」。

**修复 B：子进程环境过滤（新增 `core/child-env.ts`）**

缺陷原文是 `env: spec.env ? { ...process.env, ...spec.env } : process.env` ——
执行器环境里带着 `COORDINATOR_API_TOKEN`，于是测试子进程和 agent 拉起的任何进程都能
直接读到协调器凭据；一旦打印到 stdout 就顺着「原始输出 → artifact → 上报」外泄。
`adapters/opencode.ts` 的 `NodeOpenCodeProcessRunner` 有同一处问题（完全继承），
因此过滤逻辑抽成共用模块。

| 导出 | 语义 |
| --- | --- |
| `SENSITIVE_ENV_NAMES` | 精确名单：`COORDINATOR_API_TOKEN`、`CLOUDFLARE_*`/`CF_*`、`GH_*`/`GITHUB_*`、`NPM_TOKEN`/`NODE_AUTH_TOKEN`/`NPM_CONFIG__AUTH` |
| `isSensitiveEnvName(name)` | 精确名单 → 其次「提供方前缀 **且** 凭据词」（`COORDINATOR|CLOUDFLARE|CF_|GITHUB|GH_|NPM_|NODE_AUTH|AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_|DIGITALOCEAN_` × `TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY|_PAT$|…`） |
| `scrubbedChildEnv(inherited, extra?)` | **先合并再过滤**：显式注入与继承来的变量一视同仁，不存在「换个入口就能把 token 塞进去」的旁路 |
| `droppedEnvNames(...)` | 启动时打印被挡住的**变量名**（不含值），排查「agent 为什么读不到某个变量」时有据可查 |

**两条刻意的取舍**：

1. **不做全量关键字屏蔽**（名字含 `KEY`/`TOKEN` 就删）。那样会把 agent 自己连模型服务要用的
   provider 凭据一起删掉——等于用一个新的故障换掉旧的漏洞。只覆盖「云端**写入**凭据」。
2. **不按值过滤**。按值判定需要执行器持有 token 明文来做匹配，那会让过滤逻辑本身成为
   新的泄露点；而名字是确定且可测的。

**回归（10 例）**：`core-process.test.ts`
`子进程环境过滤` 5 例 —— 其中一条**起真实子进程**，把假 Token 放进环境，
断言子进程在任何输出位置都读不到它；另一条反向断言过滤没有把 `PATH` 一起删掉。
`敏感文件边界` 4 例 —— A 端给的四个样例必须全部命中、大小写变体与非 ASCII 路径、
凭据容器与凭据目录、以及**正常源文件不被误判**。
`real-chain.test.ts` 1 例：真实链路 `.ENV` / 公钥证书 / `.codex` 会话目录全部拦截。

### 1.4 B8-4 身份与实际适配器一致（A 端 B7-4）

**A 端判定**：`daemon.ts` 接受 `codex`/`mock` 身份，但 `core/attempt.ts` 仍调用
`runOpenCodeTask()`。

**修复**：新增 `SUPPORTED_AGENT_KIND = "opencode"`、`resolveAgentKind()`、
`isSupportedAgentKind()` 三个导出。配置装配层对非 `opencode` **启动即失败**；
`runDaemon()` 在**健康检查之前**再加一道身份守卫，未支持的身份直接返回
`stop_reason = "agent_kind_unsupported"` 且**不做任何云端写操作**。
退出码同样为 1。

**回归**：`daemon.test.ts` `describe("B8 §B7-4 身份与实际适配器一致")`，5 例：
只支持 `opencode`、未设置时默认 `opencode`（缺省**不**等于放宽）、`codex`/`mock`
被拒且错误信息说明为什么、从环境变量装配时启动即失败、以及绕过配置层直接调
`runDaemon()` 同样被挡住且不做云端操作。

> 边界：A 的 Codex 适配器仍由 A 负责，B 端**不**实现、也不假装支持。

### 1.5 B8-5 接口对齐逐项证据（A 端 B7-5）

A 端要求「逐项给出实测与未测，不把成功 CI 当作接口联调」。逐项证据表在
**交接单 `docs/handoff/B-to-A-B8-complete.md` 第四节**，此处不重复。结论摘要：

- 401/403/409、旧租约、报告形状在**本地**有覆盖，但服务端是 `FakeFetch`
  （按脚本返回响应的假 fetch）——那是**客户端契约测试，不是接口联调**。
- 唯一一次**对真实测试 Worker 的 HTTP 实跑**是注册：假 token → `HTTP 401 / AUTH_EXPIRED`，
  `polls=0 attempts=0 registered=false`（零副作用）。**403 未对真实 Worker 实测。**
- **单活动租约**在 B 端无直接证据：它是服务端（Durable Object）的保证，B 端只能
  证明自己「不制造第二个租约」（领取重试复用同一幂等键）。真实语义未在本地复现。

### 1.6 B8-6 测试命令结构化配置（A 端 B7-6）

**A 端判定**：任意非空 `EXECUTOR_TEST_COMMAND` 都被映射为 `npm run check`；
不设则该无测试命令；而目标示例仓库只有 `npm test`。

**修复**：删除 `EXECUTOR_TEST_COMMAND → npm run check` 的映射，改为**结构化配置**：

| 变量 | 语义 |
| --- | --- |
| `EXECUTOR_TEST_EXECUTABLE` | **必填**，可执行程序名或路径；缺失即**启动失败**（缺配置不许开工） |
| `EXECUTOR_TEST_ARGS` | 可选，**JSON 字符串数组**；`JSON.parse` 失败或类型不符同样启动失败——不猜、不忽略 |

程序与参数以**数组**交给进程 API，永不经 shell，因此云端下发的字符串仍是数据而非命令；
最后仍额外拒绝可执行名里出现 shell 元字符。`options.test_command` 会真的被传进
`runAttempt`（`daemon.ts:941`），不是只在启动时不报错。

**回归**：`daemon.test.ts` `describe("B8 §B7-6 测试命令结构化配置")`，8 例：
显式程序与参数被原样采用、参数可省略、绝对路径含空格不被拆开、缺可执行程序即拒绝、
参数非法 JSON/非字符串数组即拒绝、可执行名含 shell 元字符即拒绝、
**含空白的真实绝对路径仍被接受**、装配后的 `test_command` 与配置一致。

## 二、本轮新增回归总览

| 文件 | 新增 | 覆盖 |
| --- | --- | --- |
| `tests/executor/core-process.test.ts` | **21** | 子进程环境 5、敏感边界 4、`parseNameStatusZ` 4、`checkDiffScope` fail-closed 7、归一化 1 |
| `tests/executor/daemon.test.ts` | **15** | 身份 5、测试命令 8、停机门槛 2 |
| `tests/executor/windows-integration.test.ts` | **4** | 真实 Git fail-closed |
| `tests/executor/real-chain.test.ts` | **2** | 敏感边界端到端、Git 核对失败端到端 |
| 合计 | **42** | 与总数变化一致（453 → 495） |

`normalize.test.ts` / `attempt.test.ts` 只做了夹具适配（`DiffCheckResult` 新增 `error` 字段）。

## 三、兼容性（逐条对照 A 端「不得触碰」）

- `packages/protocol/**`：**零改动**（`git diff --name-only` 实测）。
- `apps/coordinator/**`、`.github/workflows/**`、`tools/validate-protocol/**`：**零改动**。
- B7 历史：新分支从 B7 顶端 `3c144a51b74c09d1c4383368ba5261e3e3345442` 开出，
  **未改写、未强推** B7。
- 既有语义保留：B6 在途记录只写不删、`shell:false`、参数数组、OpenCode 启动解析、
  `settledWithin` 有界等待原语均未动。

## 四、实际执行的校验（以命令输出为准）

Windows，Node `v22.22.2`（managed，仓库 `engines` 要求 `>=22 <23`），`CI=1`：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | `tsc -b --pretty` 通过 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` + 全部样例 PASS |
| `npm test` | `0` | **21 文件 494 passed / 1 skipped / 0 failed**（495），176 s |
| `npm run check` | `0` | 三项串联 |
| `git diff --check` | `0` | 无空白问题 |

> 本机 npm 的 `run-script` 会经 shell 起动子命令，本环境对 `cmd /c` 有策略限制，
> 因此 `npm run check` 是以 managed Node 直接调用 npm 自身（`npm-cli.js run check`）
> 执行的：同一 node、同一 `package.json` 脚本、同一二进制，不是手抄命令。

CI（Windows / Ubuntu）：见交接单第五节。第一版 `0897984` 的 Ubuntu 失败
（Windows 同版本 success）已在 §6.2 定位并修正。

## 五、A 端原复现场景的等价验证

A 端对 B7-2 的原始复现是「在不存在的仓库路径调用 `checkDiffScope()` → `ok:true`」。
现在：

- 非 Git 路径 → `ok:false` + `error`（`core-process.test.ts` + `windows-integration.test.ts` 各一例，真实 Git）
- worktree 的 `.git` 指针被破坏 → `ok:false` + `error`（真实 Git）
- 仅 `git status` 失败 → `ok:false` + `error`（这正是原来被当成「工作区干净」的那条）
- worktree 被父仓库顶替 → `ok:false`（防「核对对象不对却通过」）

## 六、本轮暴露的两类**测试自身缺陷**（值得记录）

两类都属于「CI/用例没有在检验它声称在检验的东西」，比被测代码失败更危险。

### 6.1 假绿：用例自己没生效，却显示通过

第一次跑全量时，B7-2 的端到端用例失败：期望 `commit_skipped_reason` 含「Git 核对失败」，
实际是「与基线无差异」。原因**不在被测代码**，而在用例：

- 用例的写法是把 worktree 里的 `.git` 覆写成垃圾内容（它在 worktree 里是一个**文件**）。
- 实测：`git worktree add` 生成的 `.git` 带 `A H` 属性（archive + **hidden**），
  在 Windows 上 `writeFileSync`（即 `open(..., "w")`）得到 **`EPERM`**；
  `chmodSync(0o666)` 不能解锁，`open(..., "r+")` 可以，`attrib -H` 后也可以。
- 于是覆写**静默失败**，`.git` 完好，`checkDiffScope()` 诚实地报告「无差异」——
  **用例退化成空断言，而且它在旧代码下也会通过。**

修法：新增 `overwriteExistingForce()`（`open(..., "r+")` 就地覆写 + `ftruncate`，
不依赖 `cmd`），只在 `EPERM` 且目标已存在时启用，其余错误照旧抛出。
修好后该用例耗时 7.6 s，且要求真实发生 git 失败时才通过。

### 6.2 平台假设：用例硬编码 Windows 绝对路径 → Ubuntu CI 失败

**已推送的第一版（`0897984`）CI 结果：`windows-latest` success（32 s）、
`ubuntu-latest` **failure**（19 s）。** 本地之所以没发现，是因为该用例在 Windows 上
**恰好**通过：

```ts
const exe = "C:\\Program Files\\nodejs\\node.exe";   // ← 硬编码
expect(parseTestCommandConfig({ [ENV_KEYS.test_executable]: exe }).executable).toBe(exe);
```

B8-6 新增的规则是「可执行名含空白时，必须是**绝对路径且盘上存在**」。
`C:\Program Files\nodejs\node.exe` 在 Windows 上 `isAbsolute() === true` 且本机确实存在
→ 通过；在 Linux 上 `path.isAbsolute()` 对 Windows 盘符路径返回 `false`
→ 被「空白词」规则判成命令行 → 抛错 → 失败。

**这条失败恰好证明新规则在两个平台上都按预期工作**，错的是用例的平台假设。

修法：改用**本平台**真实存在、且目录名带空格的绝对路径
（`mkdtempSync(join(tmpdir(), "b8 abs path "))`），维持「含空格的绝对路径被接受」的语义；
把「绝对路径夹带参数」单独拆成一条拒绝用例，避免两条用例重复断言同一件事。

**教训**：跨平台仓库里，任何「绝对路径」的判定都不能用硬编码的外平台路径做例子，
否则用例在开发者本机会绿、在另一个 OS 的 CI 上才红。

## 七、未执行（不得写成成功）


- 真实 OpenCode 模型调用、真实任务领取/上报、P3 双机验收、P5 自动返修：**均未执行**。
- 对真实测试 Worker 的 HTTP 实跑仅到**注册**一步（假凭据，零副作用）；401 之外的
  403/409 未对真实服务端实测。
- 目标业务仓库推送：**未执行**，且需按仓库与分支单独核对授权。
- B6 中间 run `36004505007` 的 Windows 失败原因：**仍未查明**，本轮新证据见交接单。

## 八、不自行合并

整合主分支需要另行满足授权表里的目标分支与验收门槛。**B 端不会自行合并、不会推 `main`。**
