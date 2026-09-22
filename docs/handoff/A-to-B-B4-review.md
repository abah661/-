# A → B：B4 独立审查结论与 B5 返修单

日期：2026-09-22  
审查对象：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4`  
远端最终 SHA：`4804d2bbbe5720527666096372e1b2c0f3e361ee`  
核心实现提交：`f9bebbb872aef28d3a730cc0e4a68b8fcd2d342c`

## 结论

**B4 暂不整合。** 五项 HTTP 契约修复与 A 端真实协调器实现一致，但常驻执行器的
“提交 → 推送 → 远端核对 → 上报”真实链路仍有阻塞缺陷。请不要改写或强推 B4；
从 B4 最终 SHA 新建：

```text
task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B5
```

B5 只修改 B 端范围：`apps/executor/**`、`tests/executor/**` 及 B 端交付文档。
A 端不直接修改执行器内核。

## 已核实通过的部分

1. 远端 B4 分支存在，SHA 与交付报告一致；B4 基线包含 A1 的 `2f1d914`。
2. 14 个改动文件均在 B 端执行器、B 端测试和交接/报告范围内；未修改
   `apps/coordinator/**`、`packages/protocol/**` 或 `.github/workflows/**`。
3. `git diff --check` 通过。
4. GitHub Actions `35710989879`：Windows 与 Ubuntu 均为 `success`。
5. A 端独立运行 B4 新增的两个测试文件：85/85 通过：
   - `tests/executor/daemon.test.ts`：37/37；
   - `tests/executor/http-transport.test.ts`：48/48。
6. A 端对照真实协调器源码，确认以下契约理解正确：
   - 写端点的 `idempotency_key` 位于 JSON body；
   - `renewLease` 返回裸 `Lease`；
   - `queryOwnership` 的租约字段位于顶层；
   - 结果上报 body 是扁平 `ResultReport`；
   - 归属查询不需要 `idempotency_key`。说明：当前 Zod 默认会剥离未知字段，
     因此旧字段不一定必然导致 400，但移除它仍是正确实现。

补充环境证据：A 电脑默认 Node 为 24，而项目锁定 Node 22；A 端全量运行在
`windows-integration.test.ts` 的两个既有超时用例上超时（396 passed、2 failed、
1 skipped）。B4 并未修改该文件，且 Node 22 的双平台 CI 已全绿，因此这两个 A 端
Node 24 环境超时不作为 B4 返修项，也不得写成 B4 全量测试失败。

## 阻塞缺陷

### P0-1：默认在推送前删除 worktree，真实推送必失败

`daemon.ts` 调用 `runAttempt` 时把 `cleanup_worktree` 默认设为 `true`。`runAttempt`
在 `finally` 中删除 worktree，然后才返回给 daemon；daemon 返回后才调用
`gitPushBranch(outcome.worktree_path, ...)`。

实际顺序因此是：

```text
runAttempt → removeWorktree → 返回 → git push（cwd 已不存在）
```

现有 daemon 测试注入了假 `attempt_runner` 和假 `push_branch`，不会访问真实目录，
所以没有发现该问题。

要求：

- 常驻入口不得让 `runAttempt` 在推送和上报前清理 worktree；
- worktree 至少保留到提交、推送、远端 SHA 核对、结果上报全部结束；
- 根据本项目清理规则，默认不自动删除 worktree；清理必须有准确范围和用户批准。

### P0-2：没有可靠创建提交，推送可能只推回基线

`runAttempt` 的现有实现明确写着“执行器不自行提交”，只读取当前 `HEAD`。默认任务提示
也没有要求 OpenCode 必须创建 Git 提交。因此常见真实路径是：OpenCode 修改了文件但
没有提交，`HEAD === base_sha`；即使随后运行 `git push`，远端也只得到原基线。

要求：

- diff 范围与敏感文件检查通过、测试通过且租约仍有效后，由执行器以固定参数数组创建提交；
- 提交前再次检查实际 diff；不得提交范围外或敏感文件；
- 提交消息遵守 `<TASK_ID>: <简述>`，正文记录 attempt 与冻结版本；
- 以真实 `git rev-parse HEAD` 形成 `head_sha` 和 `commit_shas`，不能由假体预填。

### P0-3：推送成功只看退出码，没有核对远端 SHA

`gitPushBranch` 在 `git push` 退出码为 0 时直接返回 `pushed: true`，没有执行
`git ls-remote` 并核对远端任务分支 SHA 与本地 HEAD。项目规则明确要求推送后核对
远程提交号。

要求：

- push 后读取本地 HEAD；
- 用结构化参数执行 `git ls-remote <remote> refs/heads/<branch>`；
- 仅在本地与远端 SHA 完全一致时返回 `pushed: true`；
- 不一致或无法核对时返回 `PUSH_REJECTED`，不得上报 `ready_for_integration`。

### P0-4：未推送时仍可上报 `ready_for_integration`

当前测试明确断言 `enable_push=false` 时“不推送但照常上报 ready_for_integration”。
这会让协调器认为提交可供 A 整合，但对应 SHA 可能只存在于 B 本地，A 无法获取。

要求：

- `ready_for_integration` 必须以远端存在且 SHA 核对一致为前提；
- 没有推送授权时，不得把本地提交伪装成可整合成果；应按协议返回
  `blocked_approval` / `UNAUTHORIZED_OPERATION`，或在领取前通过能力匹配避免领取；
- 修改现有反向测试，锁定“未推送不得 ready_for_integration”。

### P1-1：恢复时仍持有有效租约，却清记录并继续领取

重启恢复得到 `still_mine` 后，当前实现删除在途记录并立即进入领取循环。旧租约在服务端
仍有效，执行器可能同时获得新任务；旧 worktree 与旧租约的事实也被本地丢失。

要求：

- B5 不支持断点续跑时，`still_mine` 必须安全停止并保留在途记录，等待租约到期或人工处理；
- 在旧租约仍归本机时不得继续领取新任务；
- 只有服务端确认已过期、已重派或任务不存在后，才可结束该在途记录；
- 新增测试断言 `still_mine` 后不调用 `acquire`、不推送、不上报、不自动删除记录。

### P1-2：自动删除在途记录违反项目清理规则

`fileInFlightStore.save_in_flight(null)` 直接 `rmSync` 删除
`.local/executor-in-flight.json`。仓库 `AGENTS.md` 与用户规则要求删除先取得准确范围授权。

要求：

- 默认保留历史/终态记录，使用状态字段或追加式记录代替自动删除；
- 若确需清理，必须通过显式、已授权的清理动作执行；
- 不得把“运行完成”自动扩展为删除许可。

## B5 必须增加的真实测试

仅增加 mock 顺序断言不够。至少补以下测试：

1. 使用真实临时 Git 仓库、真实 worktree 和本地 bare remote：
   - agent 产生未提交改动；
   - 执行器检查、提交并推送；
   - 远端任务分支 SHA 与本地 HEAD 完全一致；
   - 推送发生时 worktree 仍存在。
2. 远端 SHA 不一致或 `ls-remote` 失败时，结果不得是 `ready_for_integration`。
3. `enable_push=false` 时，不得上报 `ready_for_integration`。
4. `still_mine` 恢复时，不进入领取循环并保留记录。
5. 默认运行不删除 worktree和在途记录。
6. 真实链路测试不得绕过现有 diff、敏感文件、租约与测试证据检查。

完成后实际运行：

```powershell
npm run typecheck
npm run validate:protocol
npm test
npm run check
git diff --check
git status --short
```

推送 B5 后提供本地 SHA、远端 SHA、测试数字和 GitHub CI 链接。未执行的真实 Worker、
真实 OpenCode、P3 或 P5 测试不得写成成功。

## 凭据与 P3 状态

- B 报告中的 `B-token-public.cer` 位于另一台电脑的
  `C:\Users\lenovo\Desktop\B-token-public.cer`；A 电脑不能跨机器直接读取该路径。
- 请把**公钥证书文件本身**作为附件交给 A；不要发送 PFX、私钥、Token 或登录文件。
- 在 B5 通过独立审查前，A 暂不把 B4 标为已整合，也不把 P3 标为开始。
- Token 加密交接、`PROJECT_ID`、最小任务图和独立目标仓库将在 B5 通过后继续。

