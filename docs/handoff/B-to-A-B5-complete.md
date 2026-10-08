# B → A：B5 完成回报（B4 评审返修）

## B 端阶段回报

- **阶段**：B5（B4 评审返修）
- **分支**：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B5`
- **B5 基线**：`4804d2bbbe5720527666096372e1b2c0f3e361ee`（= B4 顶端）
  — 未改写、未强推 B4；B4 远端仍是 `4804d2b`
- **B5 实现提交**：`92e47e4f52e5c4c9a1faa0b23a4d92857f7f26bb`
  （10 文件，+1970/−161；新增 `apps/executor/src/core/commit.ts` 与
  `tests/executor/real-chain.test.ts`）
- **远端 SHA**：`92e47e4f52e5c4c9a1faa0b23a4d92857f7f26bb`
  —— `git ls-remote origin refs/heads/task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B5`
  与本地 `git rev-parse HEAD` **逐字一致**
- **`main` 未被改动**：远端仍为 `ae659a9f5bbf59c08c0c435b916a2eaa0a4ad25e`；
  未推送任何其他分支、未 force-push
- **CI**：`CI` 运行 **#14** —— **conclusion: `success`**
  <https://github.com/abah661/-/actions/runs/35875904362>
  （head_sha `92e47e4…`；Windows 与 Ubuntu 均通过）

### 实际执行命令 / 退出码（Node v22.22.2）

| 命令 | 退出码 |
| --- | --- |
| `npm run typecheck` | `0` |
| `npm run validate:protocol` | `0` |
| `npm test` | `0` |
| `npm run check` | `0` |
| `git diff --check` | `0` |
| `git status --short` | `0`（提交后干净） |

### 测试数字

**20 个测试文件：417 passed \| 1 skipped \| 0 failed（共 418）**

- 新增 `tests/executor/real-chain.test.ts`：**12/12 通过**（81.7 s）
- `tests/executor/daemon.test.ts`：**42/42 通过**
- 1 个 skip 是既有的平台门控；**未删除断言、未跳过失败用例、未降低标准**

### 未执行（不得写成成功）

- 未对真实 Worker 发起任何请求（仍无 Token）
- 未做真实 OpenCode 模型调用
- 未做 P3 / P5、未做双机联调

---

## 一、评审 4×P0 + 2×P1：全部返修完成

| 条目 | 修法一句话 | 锁定测试 |
| --- | --- | --- |
| P0-1 | 常驻入口**固定** `cleanup_worktree: false`；清理点唯一且在上报之后，默认不清理 | §1（推送时 worktree 仍存在）、§5 |
| P0-2 | 新增 `core/commit.ts`；四道门 + 提交前对**暂存内容**重查；`head_sha` 只来自 `git rev-parse HEAD` | §2（三种情形都不创建提交） |
| P0-3 | push 后读本地 HEAD，再 `git ls-remote` **逐字核对**，不一致即 `PUSH_REJECTED` | §3（3 例，含独立路径二次证实） |
| P0-4 | 无授权 → `blocked_approval`/`UNAUTHORIZED_OPERATION`；推送或核对失败 → `failed`/`PUSH_REJECTED` | §3、§4 |
| P1-1 | `still_mine` → `halt_still_mine` 安全停止：不领取/不推送/不上报/不删记录 | `daemon.test.ts` §8 |
| P1-2 | `save_in_flight` 签名收窄为不接受 `null`，**类型层面没有删除入口**；结束只推进 `state` | P1-2 用例 |

评审单要求的 6 组真实测试全部落地，详见
`docs/reports/B5-B-executor-review-fixes.md` 第三节。

## 二、真实链路额外逼出 3 个 B 端缺陷 + 1 个 P3 阻塞事实

前两个的严重程度不低于评审单里的 P0——它们会让执行器在真实环境下**永久挂死**：

1. **`runProcess` 无条件空等满超时**：`collectEvidence` 每次采集证据都白等
   `test_timeout_ms`。实测 **10 分钟 → 修复后 367 ms**。
2. **假 agent 只注入到 `runAttempt`、没注入常驻入口**：真实链路测试里
   5 个走 `runDaemon` 的用例其实在真实 `spawn opencode`。
   已在 `DaemonDeps` 增 `agent_runner` 并透传。
3. **`spawn` 失败时句柄永不结束**：`error` 事件无监听者 → 升级为**进程级未捕获异常**；
   `exit_code` 永不兑现 → 执行器**永久死等**（实测 120 s 仍未返回，只能被测试超时杀掉）。
   已给 `adapters/opencode.ts` 与 `core/process.ts` 增加启动失败通道
   （立刻挂 `error` 监听、`exit_code` 按「未取得」返回而**不伪造 0**、
   失败文本并入 `stderr`、`RunProcessResult` 增 `spawn_failed`）。§6 锁定。

这三条都**只能由真实链路测出**——假体里 `sleep`/`exit_code` 是注入的，
等待时长与「句柄会不会结束」都不影响断言。这印证了评审单的判断。

### 2.1 ⚠️ 需要 A 端裁决：`opencode` 在 Windows 上以裸名 `spawn` 不到（P3 前置）

实测本机（Node 22.22.2）：

- `opencode` **确已安装**，但装的是 npm 全局 shim：
  `C:\Users\lenovo\AppData\Roaming\npm\opencode.cmd`（另有 `.ps1` 与无扩展名脚本）
- `spawnSync("opencode", ["--version"], { shell: false })` → `status = null, error = ENOENT`

即 Node 在 `shell: false` 下**不会**解析 Windows 的 `.cmd` shim。
当前适配器默认 `executable: "opencode"` + `shell: false`，
因此在真实链路上**必然 ENOENT**。这与 B4 报告「OpenCode 已安装 1.18.31」不矛盾，
但含义是：**「已安装」不等于「能被执行器拉起」**，P3 之前必须解决。

B5 **没有**擅自改动 `shell: false`（那是本项目明确的安全红线，属契约变更），
只把「起不来时必须快速且如实地失败」修好并锁定。请 A 端在三个方向里定一个：

1. 配置传入**真实可执行文件路径**（保持 `shell: false`）；
2. 适配器内解析 `.cmd` 后以 `cmd.exe /c` 启动 —— **引入 shell 语义，需确认**；
3. 环境准备阶段暴露一个真正的 `.exe` 入口。

## 三、仍等 A 端提供

1. `B-executor-token.p7m`（仅 `EXE-B-OPENCODE`）
2. `PROJECT_ID`
3. 独立目标业务仓库 `<TARGET_REPO_URL>`
4. 最小任务图
5. 2.1 的 `opencode` 启动方式裁决

## 四、其他观察（不影响本轮审查）

`git ls-remote origin 'refs/heads/task/*'` 显示 A1 分支远端已前进到
`7f5873217b787fefea886a5e885e2107561ce2a0`。B5 未改动 `packages/protocol/**`
与 `apps/coordinator/**`，协议版本仍为 `1`（冻结）。
