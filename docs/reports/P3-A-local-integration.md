# P3 A 端交付记录：离线与本地集成

## 本次交付

- `packages/integration/`：固定 `base_sha`、候选提交顺序、四项版本绑定和受信任 workflow 的整合计划；生成参数数组，不拼接 shell 字符串。
- 独立证据验收：必须同时具备批次绑定一致、退出码为 0、组合测试失败数为 0、clean 工作区、CI run ID、实际 `merged_sha` 和 `tree_sha`。
- `apps/coordinator/`：租约到期检查；到期租约不允许续约或回报，下一次领取会回收 `leased` 任务并生成新 attempt。
- `tools/cli/`：`plan-integration` 和 `verify-integration` 命令。
- `packages/integration/samples/`：脱敏整合批次与通过证据夹具。

没有修改 `apps/executor/`，没有修改协议字段，没有推送、CI、Cloudflare、数据库或部署操作。

## 实际验证证据

在 `E:\双人agent并行开发\双人Agent自动并行开发系统-A端` 执行：

```text
npm run check
```

结果：

- 类型检查：通过
- 协议元数据与 5 个样例：通过
- 6 个测试文件、76 个测试：全部通过
- 协调器覆盖：正常领取/回报、重复回报幂等、旧 epoch 拒绝、租约过期拒绝续约并重派、Bearer 认证
- 固定整合覆盖：顺序固定、重复候选拒绝、base 混入拒绝、CI/测试/clean/合并对象证据验收

另执行：

```text
npm exec --workspace @dac/cli -- tsx src/index.ts plan-integration ../../packages/integration/samples/batch.pending.json
npm exec --workspace @dac/cli -- tsx src/index.ts verify-integration ../../packages/integration/samples/batch.pending.json ../../packages/integration/samples/evidence.passed.json
```

实际输出分别生成固定 Git 参数计划，并输出 `整合验收通过：BATCH-0001`。

## 边界与未完成项

当前是本地离线整合计划和证据验收，不是已经执行真实 merge、GitHub Actions 或自动合并。远端协议元数据仍为 `draft`；Node 当前为 `v24.14.1`，项目要求为 `>=22 <23`，npm 安装只产生 engine 警告。

Codex 非交互适配器已在 P2 补上；真实调用已启动并产生 JSONL，但当前环境到 `api.openai.com` 的连接被拒绝/超时，因此真实模型联通性仍待网络恢复后重试。
