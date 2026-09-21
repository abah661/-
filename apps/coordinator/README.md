# apps/coordinator —— Worker API 与 Durable Object（A 负责）

本目录由 **A 端（Codex）** 负责实现。B 端不得直接修改。

依据《项目书》第 7 节与第 P2 节，本目录将包含：

```
apps/coordinator/
  src/
    index.ts              Worker 入口
    routes/               HTTPS JSON API
      register-executor.ts   注册执行器
      submit-requirement.ts  提交需求
      lease-task.ts          领取任务
      renew-lease.ts         续约
      report-result.ts       回报结果
      get-context.ts         获取上下文
      contract-proposal.ts   提交契约提案
      query-status.ts        查询状态
      github-webhook.ts      接收 GitHub 事件
    do/
      project-do.ts       每项目一个 Durable Object，事务处理领取与状态转移
    auth/
      executors.ts        执行器身份认证映射（不能靠请求字段冒充）
      github-app.ts       GitHub App 签名验证与去重
    idempotency.ts        写请求幂等键
    batch/
      queue.ts            自建串行批次队列
      integration.ts      固定提交整合逻辑
```

## 首版数据（第 7 节）

项目、执行器、任务、尝试、租约、契约、消息、事件、整合批次与授权记录。
每个项目一个 Durable Object，**领取和状态转移在事务中处理**。

> 此为待实施 schema，不表示已获准初始化或迁移。

## 关键约束

| 约束 | 来源 |
| --- | --- |
| 写请求使用幂等键 | 第 7 节 |
| 回调验证签名并去重 | 第 7 节 |
| 身份由认证映射，不能靠请求字段冒充 | 第 11 节 |
| 测试候选代码的 job 不持有协调器密钥或仓库写凭据 | 第 9 节 |
| 不接受 agent 自报的 CI 成功，需回查 run 的仓库、工作流、批次和结论 | 第 9 节 |

## 部署授权

Worker 部署、凭据创建、初始数据库 schema 均属第 11 节授权表范围，
**需明确账号、环境、资源和变更后批准**。参见 `docs/authorization.md`。

## 状态

⬜ 尚未实现。前置条件：协议 v1 冻结（P1 完成）。
