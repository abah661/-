# A → B：B5 独立审查结论与 B6 补充项

日期：2026-09-24

审查分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B5`

B5 实现提交：`92e47e4f52e5c4c9a1faa0b23a4d92857f7f26bb`

当前分支顶端：`934db7b18d01dff5712b8919751e9ac23b5a223f`

## 结论

B5 的四项 P0 修复、`still_mine` 安全停止，以及执行器提交、真实 Git 推送核对和
OpenCode 启动失败处理均通过本轮源码审查。**P1-2 只完成了一半，因此 B5 暂不整合。**

请从 B5 当前顶端新建 `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6`，只补充本文件的
在途记录保存问题与 OpenCode 无 shell 启动配置，不改写、不强推 B5。

## 已核验的证据

- GitHub B5 分支当前 SHA：`934db7b18d01dff5712b8919751e9ac23b5a223f`。
- B5 相对 B4 基线 `4804d2bbbe5720527666096372e1b2c0f3e361ee` 前进 2 个提交、无落后。
- 改动仅涉及 `apps/executor/**`、`tests/executor/**` 与 B 端报告文档；没有改动协调器、
  冻结协议或 CI。
- GitHub Actions `35876536097` 的 Windows 和 Ubuntu job 均为 `success`；B5 实现提交
  对应的 `35875904362` 也成功。
- B 报告中的真实链路测试为 12 项，完整检查报告为 417 passed、1 skipped。
  真实 Worker、真实 OpenCode 模型调用、P3/P5 双机验收均未执行，按未完成记录。
- 五个 B4 评审项通过：推送前保留 worktree、执行器创建提交、推送后核对远端 SHA、
  未推送不得报告可整合、`still_mine` 时停止并保留记录。

## B6-1：在途记录仍会被后续任务覆盖（P1，阻塞整合）

`fileInFlightStore()` 把所有 attempt 存到同一文件：

```text
.local/executor-in-flight.json
```

它用 `writeFileSync(file, ...)` 写入一条 JSON。当前 attempt 完成后状态留在文件里；
但下一次领取任务时，`markInFlight(newRecord, "in_flight")` 会对同一路径再次写入，
直接覆盖上一条终态记录。连续处理 N 个 attempt 后，磁盘上最多只剩最后一条。

因此现在实现虽然不调用 `rmSync`，仍会自动丢失先前 attempt 的终态审计记录，没有满足
B5 报告所称“终态记录留在 `.local/` 里，可复查”的要求。

请改为每个 attempt 一份不可互相覆盖的记录，例如：

```text
.local/executor-attempts/<attempt_id>.json
```

重启时只查找/加载状态为 `in_flight` 的记录；`reported`、`failed_*`、`abandoned_*`、
`halted_still_mine` 等记录保持原样。若需要单独的“当前 attempt”指针，指针可更新，但
attempt 记录本身不得由后续任务覆盖或自动删除。不要增加自动清理历史记录的逻辑。

至少增加测试：连续完成两个不同 attempt 后，两份记录都存在且各自状态正确；重启恢复
只处理仍为 `in_flight` 的 attempt；终态记录不会再次被当成活动租约恢复。

## B6-2：OpenCode 启动决定

**A 端决定：保持 `shell: false`，不采用 `cmd.exe /c`，也不拼接命令字符串。**

B 端报告确认 OpenCode 安装为 Windows npm shim（`.cmd` / `.ps1`），Node 的
`spawn("opencode", ..., { shell: false })` 会返回 `ENOENT`。请通过实际检查 B 电脑的
`opencode.cmd` 与 npm 包元数据，解析出：

1. 当前用户真实的 `node.exe` 路径；
2. OpenCode CLI 对应的 JS 入口文件路径。

随后以参数数组直接启动 `node.exe`，参数数组前缀放 CLI JS 入口，后面接 OpenCode
原有参数。请为执行器增加显式配置并一路传到 `runOpenCodeTask`；路径来自 B 电脑本地
环境，不能硬编码 A 电脑或 B 电脑的用户目录。不得经 shell 执行 `.cmd` shim。

B6 验收需在 B 的 Windows 环境用相同方式运行 `opencode --version`，再实际验证适配器
启动不会返回 `ENOENT`。真实模型调用仍按配额和用户授权单独记录；不能用版本检查冒充
真实模型任务成功。

## B6 检查与交付

完成后运行并报告实际退出码：

```powershell
npm run typecheck
npm run validate:protocol
npm test
npm run check
git diff --check
git status --short
```

还需报告 B6 分支 SHA、远端 SHA、两个 Windows/Linux CI 结论、终态记录保留测试、Windows
OpenCode 启动验证。没有真实 Worker Token、`PROJECT_ID`、独立目标仓库和最小任务图时，
不得记录真实 Worker 请求或 P3/P5 双机联调成功。
