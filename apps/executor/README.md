# apps/executor —— Windows 执行器与适配器（B 负责）

本目录由 **B 端（OpenCode）** 负责实现。A 端不得覆盖。

依据《项目书》第 8 节与第 13 节，本目录将包含：

```
apps/executor/
  src/
    index.ts            常驻进程入口（第一版手动启动，开机自启需另行批准）
    core/               公共内核
      lease.ts            领取、独立续租、租约失效处理
      worktree.ts         Git 基线与独立 worktree 准备
      process.ts          子进程固定参数调用、进程树停止、超时控制
      heartbeat.ts        心跳
      recovery.ts         重启恢复：先向云端核对任务归属
      diff-check.ts       实际 Git diff 与写入范围核对（规则 3）
      evidence.ts         测试证据采集
    adapters/
      codex.ts            Codex 适配器（A 端亦提供独立模块，此处为接口对齐）
      opencode.ts         OpenCode 适配器：非交互调用与结构化事件
    result/
      normalize.ts        结果归一化为协议 ResultReport
    context/
      export.ts           上下文导出（脱敏）
      artifact-verify.ts  资料清单与 SHA-256 校验（第 10.2 节）
```

## 执行流程（第 8 节）

1. 认证并领取任务，核对项目、能力和授权
2. 获取指定 Git 基线，准备独立 worktree；已有未提交内容不能覆盖
3. 加载任务绑定的规则、契约、上下文和测试要求
4. 以固定程序和**参数数组**调用 agent，**不执行云端任意 shell 字符串**
5. 独立续租，采集进度并执行超时控制
6. 检查实际 diff、文件范围、结果结构和测试
7. 创建提交；推送前验证租约与授权，推送后核对远程提交号
8. 回报证据

> **agent 说"完成"或退出码为 0 都不足以判定成功。**

## 必须覆盖的 Windows 重点测试（第 8 节）

- 中文路径与空格路径
- 进程树停止（不能只杀父进程）
- 休眠恢复
- 断线恢复

## 关键约束

| 约束 | 来源 |
| --- | --- |
| 不修改 `apps/coordinator/` 与 `.github/` | AGENTS.md 维护者表 |
| 公共协议变化先提案 | 第 6 节 |
| 凭据本地注入，不进仓库、不进日志 | 规则 5 |
| 断网后停止新操作；无法续租时在租约失效前停止子进程 | 第 7 节 |

## 状态

⬜ 尚未实现。前置条件：协议 v1 冻结（P1 完成）。
