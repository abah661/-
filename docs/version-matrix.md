# 版本矩阵

依据《项目书》第 4.1 节："将实际版本记录到版本矩阵，项目依赖锁定并提交锁文件。
不要使用未经验证的'永远跟随最新版'配置。"

记录日期：2026-09-21（B 端本机实测）

## 运行时与工具

| 项目 | 版本 | 来源 / 验证方式 |
| --- | --- | --- |
| 操作系统 | Windows | B 端本机 |
| Node.js | v22.22.2 | `node -v` 实测 |
| npm | 10.9.7 | `npm -v` 实测 |
| Git | 2.55.0.windows.3 | `git --version` 实测 |

## 开发依赖（锁定于 package-lock.json）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| typescript | 5.9.3 | 类型检查与构建 |
| vitest | 3.2.4 | 测试运行器 |
| tsx | 4.20.6 | 直接运行 TS CLI |
| @types/node | 22.18.6 | Node 类型定义 |
| zod | 4.1.13 | 协议 schema 校验 |

## Agent 工具（待各自填写）

| 项目 | A 端 | B 端 |
| --- | --- | --- |
| Agent CLI | Codex CLI `<版本待填>` | OpenCode CLI `<版本待填>` |
| 模型服务 | 自己的订阅 | `<待确认，不假定可复用对方订阅>` |
| 登录状态 | `<待确认>` | `<待确认>` |

> **第 4.1 节要求**：双方确认各自模型配额可用。
> OpenCode 使用何种模型服务单独确认，**不假定另一人的 Codex 订阅可直接复用**。

## 环境变量与路径（占位符）

| 字段 | 填写值 |
| --- | --- |
| `<PROJECT_NAME_AND_GOAL>` | 双人 Agent 自动并行开发系统 |
| `<COORDINATOR_REPO_URL>` | `https://github.com/abah661/-.git` |
| `<TARGET_REPO_URL>` | 待填（需另建，与协调系统仓库分开） |
| `<A_PROJECT_ROOT>` | 待 A 端填写 |
| `<B_PROJECT_ROOT>` | `C:\Users\lenovo\Desktop\双端连接` |
| `<ENVIRONMENT_AND_OWNER>` | 资源所有者：**A 端** |
| `<EXECUTOR_A_ID>` | 建议 `EXE-A-<主机名>` |
| `<EXECUTOR_B_ID>` | 建议 `EXE-B-<主机名>` |
| `<DAILY_BUDGET_AND_LIMITS>` | 见 `docs/budget-and-limits.md` |
| `<SYNCTHING_ENABLED>` | **启用** |

## 网络环境（B 端本机实测）

| 项目 | 值 | 说明 |
| --- | --- | --- |
| HTTP/HTTPS 代理 | `http://127.0.0.1:7897` | git 可用的代理端口 |
| 备用代理 | `http://127.0.0.1:59723` | 可用于 Web，但 git CONNECT 返回 502 |
| git 代理配置 | 仓库级 `http.proxy` / `https.proxy` | 仅本仓库生效，不污染全局 |
| 直连（无代理） | ❌ 不可用 | 连接 github.com:443 超时 |

> 代理配置写在**仓库级**（`--local`）而非全局，
> 避免影响你其他项目的 git 行为。
> 本机 git 全局配置中已有 `user.name=abah` / `user.email=1587548960@qq.com`，
> 未做改动。

## Syncthing（启用，待安装）

| 项目 | 值 |
| --- | --- |
| 同步根目录 | `C:\Users\lenovo\Desktop\双端连接-sync` |
| 发布目录（Send Only） | `from-b` |
| 接收目录（Receive Only） | `from-a` |
| Folder ID | `dual-agent-from-a` / `dual-agent-from-b` |
| 程序版本 | ⬜ 未安装（待批准） |

> 同步根目录已验证为 Git 仓库的**同级独立目录**，
> 不在仓库内，符合第 10.1 节与第 10.2 节步骤 5。

## 更新规则

- 升级任何依赖或工具后，必须同步更新本文件与锁文件。
- 版本改动需在 PR 中说明理由，并重新运行 `npm run check`。
- 工具版本属于"实施时核对"项（第 4.1 节），不得凭推测填写。
