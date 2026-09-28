# B → A：B8 完成交接单（执行器加固：B7-1 ～ B7-6）

日期：2026-09-28

审查依据：《A → B：B7 独立验收与 P3 输入清单》第二节六项未通过项。

## 一、一句话结论

A 端 **B7-1 ～ B7-6 六项全部成立，已逐项修复并各配确定性回归**（新增 42 例）。
本地 `npm run check` 退出码 **`0`**，`21` 文件 **494 passed / 1 skipped / 0 failed**。
分支从 B7 顶端**原样开出**，B7 历史未被改写；`packages/protocol/**`、`apps/coordinator/**`、
CI 零改动。**B7-5 的逐项证据见第四节——其中只有 401 注册一项真正打到过真实 Worker，
其余全部是本地假服务端契约测试，我没有把 CI 当联调。**

## 二、交付物与提交

分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B8`
基线：**B7 顶端 `3c144a51b74c09d1c4383368ba5261e3e3345442`**（未改写、未强推）

| # | 提交 SHA | 内容 |
| --- | --- | --- |
| 1 | 见 §5.3 实测 | B8 实现 + 测试 + `docs/reports/B8-B-executor-hardening.md` + 本交接单 |
| 2 | 见 §5.3 实测 | 仅补录 CI 结果（本文件 §五） |

**SHA 核对方式**（本文件随文档提交前进、顶端 SHA 无法自指，故以实测为准）：

```bash
git ls-remote origin refs/heads/task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B8
git rev-parse HEAD        # B 端 worktree 内
```

改动范围（`git diff --name-only 3c144a5..HEAD` 实测）：

```
apps/executor/src/core/attempt.ts
apps/executor/src/core/child-env.ts          （新增）
apps/executor/src/core/commit.ts
apps/executor/src/core/diff-check.ts
apps/executor/src/core/evidence.ts
apps/executor/src/core/process.ts
apps/executor/src/core/recovery.ts
apps/executor/src/adapters/opencode.ts
apps/executor/src/daemon.ts
apps/executor/src/result/normalize.ts
tests/executor/attempt.test.ts
tests/executor/core-process.test.ts
tests/executor/daemon.test.ts
tests/executor/normalize.test.ts
tests/executor/real-chain.test.ts
tests/executor/windows-integration.test.ts
docs/reports/B8-B-executor-hardening.md      （新增）
docs/handoff/B-to-A-B8-complete.md           （新增）
```

全部在允许范围内（`apps/executor/**`、`tests/executor/**`、`docs/**`）。

## 三、逐条对照 A 端 B7-1 ～ B7-6

| A 端项 | A 的判定 | B 的落实 | 回归 |
| --- | --- | --- | --- |
| **B7-1** 停机门槛 | `kill_failed` 只进 `report.note`，上报后继续轮询 | `kill_failed` 提升为一等信号写入 `AttemptTrace`；上报后停机（不领取、不推送、不清理 worktree、`stop_reason=halt_residual_process`、退出码 1）；在途记录新增 `halted_residual_process` 与 `halted_still_mine` 分开 | daemon ×2 |
| **B7-2** Git fail-closed | 不存在的仓库路径得到 `ok:true`、空违规列表 | `checkDiffScope` 任一 Git 命令失败即 `ok:false` + `error`；`-z` + `-M` 与重命名两侧；`verifyWorktreeRoot` 防「被父仓库顶替」；提交门错误分支排在「无差异」之前；`listStagedFiles` 失败不再返回空数组；归一化降级 `failed`/`INTERNAL_ERROR` | core-process ×12、windows-integration ×4（真实 Git）、real-chain ×1 |
| **B7-3** 敏感边界 | 四样例只命中 `.env`；`process.env` 继承给子进程 | 路径模式加 `i` 标志并补齐凭据容器/凭据目录；新增 `core/child-env.ts`，`process.ts` 与 `adapters/opencode.ts` 两处 spawn 前过滤；启动日志打印被挡变量名（不含值） | core-process ×9（含真实子进程读不到假 Token）、real-chain ×1 |
| **B7-4** 身份一致 | 接受 `codex`/`mock` 却始终调 `runOpenCodeTask()` | 只接受 `opencode`；配置层启动即失败 + `runDaemon` 健康检查前守卫 + `stop_reason=agent_kind_unsupported` + 退出码 1（A 的 Codex 适配器仍由 A 负责） | daemon ×5 |
| **B7-5** 接口逐项证据 | 无逐项实测/未测 | 见**第四节** | — |
| **B7-6** 测试命令 | 任意非空值 → 固定 `npm run check` | 删除该映射；改为 `EXECUTOR_TEST_EXECUTABLE`（必填，缺则启动拒绝）+ `EXECUTOR_TEST_ARGS`（JSON 字符串数组）；数组交进程 API，永不经 shell；`options.test_command` 真的传进 `runAttempt` | daemon ×8 |

## 四、B7-5 接口对齐：逐项证据（实测 / 未测）

**先说清证据等级**，避免把不同强度的东西混在一起：

- **L1 真实服务端**：打到 `https://dual-agent-coordinator-test.dual-agent-coordinator.workers.dev`
- **L2 本地假服务端**：`tests/executor/http-transport.test.ts` 用 `FakeFetch`（按脚本返回响应的假 `fetch`）——**这是客户端契约测试，不是接口联调**
- **L3 本地假传输**：`daemon.test.ts` / `normalize.test.ts` 注入假 `lease_transport` 等
- **L4 A 的代码、本机跑**：`tests/coordinator/project-do.test.ts` 跑的是 A 的 DO 实现（in-process），不是部署态 Worker

| 接口项 | 本地覆盖 | 等级 | 真实服务端 | 未测 |
| --- | --- | --- | --- | --- |
| **401** 认证失效 | `daemon.test.ts:931` `401 → auth_blocked（凭据问题，不计返修）`；`http-transport.test.ts:218` `401/403 → AUTH_EXPIRED 且不重试`；`:337` `401 只请求一次`；`:549` `401 不转成丢失（认证失效 ≠ 被抢走）` | L2/L3 | ✅ **已实测**（2026-09-28）：假 token 注册 → `HTTP 401 / AUTH_EXPIRED`，`stop_reason=registration_rejected`，`polls=0 attempts=0 registered=false`（零副作用） | — |
| **403** 身份不匹配 | `daemon.test.ts:678` `身份不匹配（403）→ registration_rejected，且不领取任何任务`；`:938` `403 → auth_blocked` | L3 | ❌ 未测 | 真实 403；以及 A 侧 `project-do.test.ts:353`「token 不能冒充其他 executor_id」是 L4 |
| **409** 冲突 / 旧 epoch | `http-transport.test.ts:238` `409 → LEASE_EPOCH_STALE 且不重试`；`:346` `409 立刻放弃`；`:520` `409 → lost(lease_epoch_stale)`；`:769` `旧 epoch 上报 → 409 上抛，不得伪装成功`；`daemon.test.ts:963` `上报遇 409 → lease_lost，停止且不伪造成功`；`:994` `sideEffectsSkipped → 既不推送也不上报` | L2/L3 | ❌ 未测 | 真实 409 全链路 |
| **旧租约 / epoch 倒退** | `http-transport.test.ts:534` `服务端 epoch 倒退 → 按丢失处理`；`:527` `应答缺 expires_at → 不当作成功`；`project-do.test.ts:175` `拒绝旧 lease_epoch 的报告`（L4）、`:217` `过期租约拒绝续约，并在下一次领取时恢复为新尝试`（L4） | L2/L4 | ❌ 未测 | 部署态的行为 |
| **单活动租约** | **B 端无直接证据。** 它是服务端（DO）的保证；B 端只能证明自己**不制造第二个租约**：`daemon.test.ts:758` `同一次领取的网络重试复用同一个幂等键（重试不产生第二个租约）` + `:778` 反例（不同领取必须用不同键）；`lease-recovery.test.ts:446` 心跳幂等键每次不同 | L3 | ❌ 未测 | **「同一任务只有一个活动租约」本身未验证** —— 需 A 侧在 DO 上给证据，或留到 P3 联调 |
| **报告约束** | schema 正/反向样例校验（`npm run validate:protocol` 退出 `0`，含全部样例）；`normalize.test.ts` 降级矩阵；`http-transport.test.ts:750` `请求体是平铺的 ResultReport，且路径与体内标识一致` | L2 + 本地 schema | ❌ 未测 | 真实 Worker 侧对上报的校验（400/422 只测过客户端分类：`http-transport.test.ts:244`） |
| **health 免认证** | `http-transport.test.ts:425` `health() 不带认证头` | L2 | ✅ 已实测：`GET /v1/health` → `200 {"ok":true,...}` | — |

**结论**：B7-5 在本地是「客户端契约已测、真实服务端未联调」。除 401 注册与 health 外，
**其余接口项都没有对真实 Worker 跑过**；`单活动租约` 与 `报告约束` 的真实语义需要
A 侧配合或 P3 联调才能给结论。我不把 CI 绿灯当作接口联调。

## 五、本地校验与 CI

### 5.1 本地（Windows，Node `v22.22.2` managed，`CI=1`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | `0` | `tsc -b --pretty` 通过 |
| `npm run validate:protocol` | `0` | `PROTOCOL_META` + 全部样例 PASS |
| `npm test` | `0` | **21 文件 494 passed / 1 skipped / 0 failed**（495），176 s |
| `npm run check` | `0` | 三项串联 |
| `git diff --check` | `0` | 无空白问题 |

> 说明：本机 npm 的 `run-script` 需经 shell 起动子命令，本环境对 `cmd /c` 有策略限制，
> 因此 `npm run check` 是以 managed Node 直接调 npm 自身（`npm-cli.js run check`）执行的：
> 同一 node、同一 `package.json` 脚本、同一二进制，不是手抄命令。

### 5.2 与 A 端基线的数量关系

A 端在 2026-09-28 对**自己的基线**（未整合 B7）跑 `npm run check` 得到
`414 passed / 2 failed / 1 skipped`，两处失败都在 `windows-integration.test.ts`
（30 s / 60 s 用例超时）。B8 本地 494/1/0。**这不能互证**——两者跑的是不同代码。

### 5.3 CI

| 运行 | 提交 | `windows-latest` | `ubuntu-latest` |
| --- | --- | --- | --- |
| **#26** | `0897984` | **success**（32 s） | ❌ **failure**（19 s） |
| **#27** | 修正后（见下） | 待补录 | 待补录 |

**#26 的 Ubuntu 失败已定位并修正**，不是未查明项，根因完整记录在
`docs/reports/B8-B-executor-hardening.md` §6.2：

- 失败的是 B8 新增用例 `daemon.test.ts`「可执行程序可以是绝对路径（含空格也不被拆开）」，
  它把例子硬编码成 `C:\Program Files\nodejs\node.exe`。
- B8-6 的新规则要求「含空白的可执行名必须是**绝对路径且盘上存在**」。
  该字符串在 Windows 上 `isAbsolute()` 为 `true` 且本机确实存在 → 通过；
  在 Linux 上 `path.isAbsolute()` 对 Windows 盘符路径返回 `false` → 被判成命令行 → 抛错。
- 也就是说：**规则在两个平台上都按预期工作，错的是用例的平台假设。**
- 修正：改用本平台真实存在、目录名带空格的绝对路径（`mkdtempSync`），
  并把「绝对路径夹带参数」拆成独立的拒绝用例。
- 已核对：`tests/executor/` 内其余 Windows 路径字面量都只经纯字符串辅助函数
  （`isInside` / `join`），不触碰 `isAbsolute` / `existsSync`，因此不受影响。

对照历史基线（同样跑 11–19 s，说明 Ubuntu 上是**跑完整套**后才失败，不是早期中断）：
B7 #25 ubuntu 17 s success、#24 ubuntu 19 s success、B6 #21 ubuntu 11 s success。

### 5.4 B6 中间 run `36004505007` 的 Windows 失败：**仍未查明**

本轮新取得的客观信息：

- 作业 `check (windows-latest)`：`failure`；`Run project checks` 13:17:12 → 13:20:14（**182 s**），
  其余步骤全部 success。
- 该 check run 的失败注解全文仅为 **`Process completed with exit code 1.`**，无用例名、无错误文本。
- 作业日志端点本轮再次实测：`GET /repos/abah661/-/actions/jobs/107649076274/logs`
  → **HTTP 403 `Must have admin rights to Repository.`**（B 端无仓库 admin 权限）。
- 对照：B7 的 run `36367946211`（`8ea0fb3`）两个 OS 均 success，Windows 61 s、
  Linux 19 s，**没有出现 182 s 量级**。

**未查明**，不推断它就是本问题。需要 A 端（有 admin 权限）打开该作业日志给出失败用例名。

## 六、公钥证书交接（**请改用新证书**）

**旧证书即将失效**：`B-token-public.cer`（`B-to-A-B4-complete.md` 记录的那个，
SHA-1 `893EA59AAAFC83C66DB2273E386DBDB92B7F39DF`）**NotAfter = 2026-09-29 17:14**，
距现在不足一天。A 若用它加密，得到的 `.p7m` 会立刻跟着失效。
按交接单 §6.1 同一流程重新签发了一份：

| 项 | 值 |
| --- | --- |
| 文件 | `C:\Users\lenovo\Desktop\B-token-public-2026-09-28.cer`（797 B，DER） |
| **SHA-256 指纹** | `8F103FC4F0EA534CCAECEBD43C8EAC13205183A15C64E84A2D14098683D5E5FF` |
| SHA-1 指纹 | `B59613D7B85332E233CC3149E8D1A3FEB776E7F2` |
| **有效期** | `2026-09-28 11:01` → **`2026-10-05 11:11`**（+08:00，`AddDays(7)`） |
| Subject / 算法 | `CN=DualAgent-B-Token-Handoff`，RSA 2048，EKU = 文档加密 `1.3.6.1.4.1.311.80.1` |
| 私钥 | `certutil -store -user My` 输出 **`私钥不能导出`**（Microsoft Software Key Storage Provider），留在 `Cert:\CurrentUser\My` |

- **未导出 PFX、未导出私钥**；两个 `.cer` 都在**仓库外**，未进 Git。
- 旧 `.cer` **保留未删**（交接单 §6.3：未经用户批准不删交接文件）；请视其为作废。
- 请 A 在核对指纹与有效期后，用**新证书**在内存中加密 `EXE-B-OPENCODE` 的 Token，
  输出 `B-executor-token.p7m` 经非 Git 渠道交付。**不要**发送私钥、登录凭据或明文 Token。
- 证书有效期 7 天，`.p7m` 到手后 B 端立刻解密并以 DPAPI `SecureString` 存放，
  运行时只注入当前进程的 `COORDINATOR_API_TOKEN`。若 10-05 前未能完成交接，我会再签发一份并报新指纹。

## 七、P3：仍需 A 端或用户提供

| 项 | 状态 |
| --- | --- |
| `PROJECT_ID` | `demo-user-profile-p3` 已知，仅用于配置核对，**B 未据此领任务** |
| 最小任务图 | ❌ **A 写的 `docs/handoff/P3-demo-task-graph.json` 不在 B 的检出里**（`docs/handoff/` 下没有该文件）。我无法审阅未拿到的图；请推送或经非 Git 渠道给我，我按冻结契约逐项核对两个任务的写入范围是否真的分离 |
| 目标业务仓库 | ❌ 等**用户**提供独立 URL。A 本地基线 `a9434a87f6f2513e7c32185a8f9a6e365162e253` 需双方核对同一提交；不会拿协调系统仓库 `abah661/-` 充当目标仓库 |
| `B-executor-token.p7m` | ❌ 等 A 用第六节的新证书加密后交付 |
| 目标仓库推送授权 | ❌ 需按仓库与分支单独核对，**不从**协调系统任务分支的推送授权推导 |

**本机额外前置条件（已实测，与 B 无关的环境事实）**：本机直连测试 Worker 会
`ERR fetch failed`，必须走代理 `127.0.0.1:7897`，且执行器用 Node 全局 `fetch`
（默认不读 `HTTP_PROXY`），因此需要 `HTTPS_PROXY` + **`NODE_USE_ENV_PROXY=1`**。
实测三种组合均 `HTTP 200`。详见 `.local/P3-startup-checklist.md`（未提交）。

> 该清单第三节「`EXECUTOR_TEST_COMMAND` 非空即固定用 `npm run check`」一句**已过时**，
> 本轮 B8-6 已改结构，清单已同步更新为 `EXECUTOR_TEST_EXECUTABLE` / `EXECUTOR_TEST_ARGS`。

## 八、未验证项（不得写成成功）

- 真实 OpenCode 模型调用、真实任务领取与上报、P3 双机验收、P5 自动返修：**均未执行**。
- 对真实 Worker 的 HTTP 实跑仅到**注册**一步（假凭据、零副作用）。
- 403 / 409 / 旧租约 / 单活动租约 / 报告约束**均未对真实服务端实测**（见第四节）。
- 目标业务仓库推送未执行。
- B6 run `36004505007` 的 Windows 失败原因**仍未查明**。

## 九、不自行合并

整合主分支需要另行满足授权表里的目标分支与验收门槛。**B 端不会自行合并、不会推 `main`、
不会 force-push、不会改写 B7 及更早的分支。**
