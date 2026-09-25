# A → B：B6 独立验收与 B7 返修项

日期：2026-09-25

> 本日后续审计增加了 Git 检查失败时错误放行、敏感路径遗漏、子进程凭据隔离和
> agent 身份/实际适配器不一致等返修项。请同时执行最新 `B-second-computer-setup.md`
> 中 B7-1 至 B7-6，不能只修复本页的超时问题。

审查分支：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B6`

审查提交：`aa2837408cb98f10b0d619d223c9094b096a1fcd`

## 结论

B6-1（每个 attempt 单独保留记录）和 B6-2（OpenCode 无 shell 启动）已达到上次评审的目标。
**同轮独立测试发现执行器进程超时路径仍可永久挂起，因此暂不整合 B6。**

请以 B6 当前顶端为基线，新建 `task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B7` 修复下述进程控制问题；
不要改写或强推 B6，也不要修改 A 端协调器、冻结协议或 CI。

## B6 已通过的部分

- GitHub B6 顶端为上述 SHA；相对 B5 顶端前进 5 个提交、没有落后。改动仅在
  `apps/executor/**`、`tests/executor/**` 和 B 端报告文档。
- GitHub Actions run `36005891915` 的 Windows、Ubuntu job 均为 `success`。
- `fileInFlightStore()` 将记录写入 `.local/executor-attempts/<attempt_id>.json`，
  `load_in_flight()` 只选活动记录；后续 attempt 不再覆盖先前终态记录。
- B 电脑安装的 `opencode-ai@1.18.31` 经 B 实测以原生 `opencode.exe` 为入口，
  没有可用的 CLI JS 入口。**A 接受以绝对路径直接启动原生 `.exe` 为等价实现**：
  参数仍按数组传递，保持 `shell: false`。B 报告的该机 `--version` 验证不等于
  真实模型任务；A 电脑未装 OpenCode，未在 A 电脑复现该版本检查。
- A 独立取得上述精确提交的源码快照，在本机以官方 Node `v22.22.2` 执行
  `npm ci --offline`，退出码 `0`，安装 104 个包；`npm run check` 的类型检查与协议校验均通过。
  Node 可执行文件与官方 SHA-256 清单逐字一致：
  `AE1A50511BE58E987483FDBC12125407443926D2D394669ADE2352776E920DD3`。
  B6 重点测试在本机通过：`opencode-launcher.test.ts` 17/17、`daemon.test.ts` 44/44、
  `real-chain.test.ts` 17/17。

## B7 阻塞项：强杀失败时 `runProcess()` 无上界等待（P0）

`apps/executor/src/core/process.ts` 的终止链宣称在
`timeout_ms + grace_ms + grace_ms` 之后即使子进程不响应也能返回。
实际在 `kill_failed = true` 之后，代码仍执行：

```ts
await Promise.all([stdoutPromise, stderrPromise]);
```

若子进程或其输出流始终不结束，这里永不返回。除此之外，
`SystemTreeKiller.killTree()` 等待 `taskkill` 结束时也没有自己的上限，且忽略了
`taskkill` 的失败退出码。只要 Windows 拒绝杀进程、`taskkill` 卡住，或流句柄被
子进程继承，执行器就可能一直占用租约，不会生成失败证据或安全退出。

A 端有两类实际证据，结论必须分开：

1. 在受限制的测试进程环境中，本机 B6 全量 `npm run check` 返回 **1**。
   `windows-integration.test.ts` 的“超时后真实子进程被终止”和
   “真实长驻测试命令超时后仍返回可记录的证据”分别耗尽 30 秒、60 秒测试上限。
   完整 Vitest 统计为 **438 passed、3 failed、1 skipped**。随后在正常用户权限下
   单独重跑 B6 的该文件，**21 passed、1 skipped、退出码 `0`**。这两项环境相关失败
   不能单独当作 B6 代码回归。
2. 独立最小复现：给 `runProcess()` 注入不结束的退出承诺与输出流、一个不生效的
   `TreeKiller`，设置 `timeout_ms=20`、`grace_ms=20`；等待 512 毫秒后仍未返回。
   复现脚本位于 A 本机忽略目录 `.local/repro-b6-run-process.ts`，没有提交敏感内容。
   这项确定性复现直接证明终止器不生效时缺少有界返回，与本机权限无关。

第三个失败是 `freeze.test.ts`：A 使用 GitHub 源码压缩包做本地复核，压缩包不含 B6 的
Git 历史，冻结测试把它视为 A 工作树内的子目录，无法列出冻结点文件。这是本次**测试载体
限制**，不能写成协议回归。B6 的双平台 CI 在完整 Git checkout 中通过。

作为对照，A 当前任务分支在受限制环境中运行 `npm run check`：协议冻结测试通过，
相同两项 Windows 用例超时，**357 passed、2 failed、1 skipped，退出码 `1`**；
在正常用户权限下单独重跑该文件，**19 passed、1 skipped、退出码 `0`**。
因此两项真实环境超时并非 B6 新引入，且会受执行权限影响。B7 阻塞依据是源码中的
无界 `await` 与上面的确定性复现，不把受限环境失败误记成 B6 单独缺陷。

请 B7 修复：

- `killTree()` 调用自身也必须有有界等待；调用失败或超时要留下可观察的失败信息。
- 最后一级宽限仍未退出时，不得再无界等待 stdout/stderr、退出码或信号；应及时返回
  `timed_out=true`、`kill_failed=true`、`exit_code=null`，且不得上报测试通过或推送。
- 用可注入的永不退出进程、永不关闭的流、失败/卡住的 killer 增加确定性回归测试；
  断言函数有界返回、失败分类正确、没有“ready_for_integration”副作用。
- 保持 B6 的记录保留语义、OpenCode 启动配置、`shell: false` 和参数数组，不改协议。

交付时报告 B7 本地 Node 22 检查退出码、Windows/Linux CI、远端 SHA 与本地 SHA，
并单独说明是否查到了 B6 中间 run `36004505007` 的 Windows 失败原因；没有证据时
保持“未查明”，不要推断它就是本问题。

## 后续边界

真实 B 电脑尚未连接测试 Worker 运行任务；真实 OpenCode 模型调用、P3 双机验收和 P5
自动返修均未执行。整合主分支需要另行满足授权表里的目标分支与验收门槛。
