# P3/P5 目标示例仓库：本地准备记录

日期：2026-09-25

## 已准备

- 与协调系统分开的本地 Git 仓库：
  `E:\双人agent并行开发\P3验收目标示例仓库`。
- 本地基线提交：`a9434a87f6f2513e7c32185a8f9a6e365162e253`；工作区干净。
  该提交包含 `AGENTS.md`、`contracts/user-profile.v1.json`、
  `docs/acceptance-v1.md` 和独立验收程序 `acceptance/run.mjs`。
- 候选任务图：`docs/handoff/P3-demo-task-graph.json`；两项 ready 实现任务分别只写
  `src/provider/**`/`tests/provider/**` 与 `src/display/**`/`tests/display/**`。
  四项绑定 SHA 和契约引用均指向上述真实基线提交。
- A 端管理 CLI `validate-graph` 实际退出码 `0`，两任务的
  `canRunInParallel()` 实际返回 `true`。
- Node `v22.22.2` 下目标仓库 `npm test`：1 passed、0 failed、退出码 `0`。
- 独立验收程序在受控正确样例上退出码 `0`、输出 `Ada (u-1)`；在 display
  错读 `userId` 的受控错误样例上退出码 `1`、实际结果 `Ada (undefined)`。
- 已部署测试 Worker 的 `/v1/health` 于当日只读复核为 HTTP `200`。

## 尚未完成

- 目标仓库只有本地提交，**没有远端 `<TARGET_REPO_URL>`**；未对外推送、未在云端
  提交任务图。不能让 B 电脑凭本机路径取得同一基线。
- B6 已按上次评审完成记录保留与 OpenCode 启动修复，但 A 的独立验收发现进程
  超时路径可能无界等待，见 `A-to-B-B6-review.md`；需 B7 修复后再整合。
- B 执行器仍缺安全交接的独立 Token。A 本地没有 B 的公钥证书文件，不能生成
  只供 B 解密的交接密文；不应把明文 Token 放进文档、聊天或 Git。
- 尚未真实运行 A/Codex 与 B/OpenCode 的双机写代码任务；P3/P5、真实并行重叠、
  组合失败与自动返修均未验收。

## 可执行的后续顺序

1. B 从 B6 顶端修复 B7，A 独立验收。
2. 给本地目标仓库选择**独立于协调系统**的远端地址，按该地址单独确认推送范围，
   将基线提交推送后复核远端 SHA。
3. B 提供仅含公钥的证书文件；A 按已批准的测试环境范围完成 Token 加密交接，
   B 在自己的电脑解密并运行执行器。
4. 核对双方注册身份与目标仓库，提交固定任务图，记录两台电脑真实运行、提交、
   测试与组合验收证据。再执行 P5 的受控故障与返修。

未取得远端地址、公钥文件和 B7 通过证据前，不提交此任务图到 Cloudflare。
