# 授权记录

依据《项目书》第 11 节："授权记录只保存非敏感范围与确认依据。
相同有效范围不重复询问；新增高权限操作不得自动扩展许可。"

**本文件不得包含任何凭据、token、私钥或登录文件内容。**

---

## 授权要求对照表

| 操作 | 授权要求 | 当前状态 |
| --- | --- | --- |
| 只读检查、文档、允许目录中的代码与测试 | 按项目规则执行 | ✅ 无需额外批准 |
| 任务分支 push | 明确仓库、分支前缀、有效期 | ✅ 已授权并已执行 |
| CI/CD 配置 | 审核具体文件和权限后批准 | ✅ 已授权测试 CI：`.github/workflows/ci.yml`，只读仓库权限 |
| Worker 部署 | 明确账号、环境、资源后批准 | ✅ 测试 Worker `dual-agent-coordinator-test` 已部署；2026-09-25 健康端点返回 `200` |
| 凭据创建 | 明确账号、环境、资源后批准 | ✅ Wrangler OAuth 已完成；仅由系统凭据管理器保存，不记录凭据内容 |
| 初始数据库 schema | 明确账号、环境、资源后批准 | ✅ 已授权 Durable Object SQLite migration `v1` |
| 自动合并 | 单独明确目标分支、门槛、范围 | ⬜ 未授权 |
| 系统安装 / 自启 | 按准确对象另行批准 | 🟡 B 端 Syncthing 安装已授权；自启未授权 |
| 删除 / 迁移 | 按准确对象另行批准 | ⬜ 未授权 |
| 生产发布 | 按准确对象另行批准 | ⬜ 未授权 |
| 同伴项目通知 | 首次确认接收者与消息范围 | ⬜ 未授权 |

---

## 授权记录格式

每条授权记录包含：

```yaml
- id: AUTH-0001
  scope: task_branch_push          # 授权范围标识
  target:                          # 准确对象
    repo: <REPO_URL>
    branch_prefix: task/
  granted_at: 2026-09-21T10:40:00+08:00
  expires_at: 2026-10-21T00:00:00+08:00   # 有效期，可空
  basis: "用户在对话中明确同意"               # 确认依据，非敏感描述
  status: active | expired | revoked
```

---

## 当前已批准范围

| ID | 范围 | 目标 | 生效 | 有效期 | 依据 |
| --- | --- | --- | --- | --- | --- |
| AUTH-0001 | 本地仓库初始化与提交 | 本机 `双端连接` 目录 | 2026-09-21 | 无 | 用户确认"先只做本地 git 仓库" |
| AUTH-0002 | 配置远程 origin 与仓库级代理 | `https://github.com/abah661/-.git` | 2026-09-21 | 无 | 用户提供仓库地址并要求连接 |
| AUTH-0003 | 建立同步资料目录（不安装程序） | `C:\Users\lenovo\Desktop\双端连接-sync` | 2026-09-21 | 无 | 用户要求"启用 Syncthing" |
| AUTH-0004 | **安装 Syncthing 程序** | `C:\Users\lenovo\AppData\Local\Programs\Syncthing` | 2026-09-21 | 无 | 用户明确"Syncthing 批准安装" |
| AUTH-0005 | **测试环境 CI、Cloudflare Worker、Durable Object 初始迁移和部署准备** | 本仓库 `.github/workflows/ci.yml`、`apps/coordinator/wrangler.toml`、Worker `dual-agent-coordinator-test`；仅测试环境 | 2026-09-21 | 无 | 用户明确授权"测试环境的 CI、Cloudflare、数据库和部署" |
| AUTH-0006 | **任务分支 push** | `https://github.com/abah661/-.git`，`task/TASK-A-COORDINATOR/**` | 2026-09-21 | 无 | 用户明确要求执行第 1 项 GitHub 推送 |

> **AUTH-0002 边界**：仅覆盖**配置**远程地址与代理。
> **不包含**任何 `git push`。推送需单独授权（见下）。
>
> **AUTH-0003 边界**：仅覆盖**目录与配置文档的建立**。
>
> **AUTH-0004 边界**：仅覆盖**程序安装到用户目录**（非系统级）。
> **不包含**注册 Windows 服务或设置开机自启——那属"自启"范围，需另行批准。

---

## 待用户确认的事项

1. **Syncthing 自启授权** — 程序已装并在运行，但**自启未配置**。
   注册 Windows 服务需管理员权限，属"系统安装、自启"范围。
2. **Syncthing 与 A 端配对** — 需双方交换设备 ID（第 10.2 节步骤 3）。
3. **目标示例仓库** — 本地夹具已建，见 `docs/handoff/P3-demo-target-preflight.md`；
   独立远端 `<TARGET_REPO_URL>` 仍未确定，不能开始真实双机任务。
4. **A 端本地项目路径** — 已填写，见 `docs/project-info.md`。
5. **预算阈值双签** — `docs/budget-and-limits.md` 由 B 端拟定，
   需双方认可后生效。
6. **B 执行器 Token 交接** — 测试 Worker 已部署，A 端测试 Token 以 Windows 加密方式
   本机保存；B 端仍需通过其公钥证书接收独立的加密交接文件。不得发送明文 Token。

## 2026-09-25 状态核对

- 邮箱验证阻塞 `10034` 已解除；测试 Worker 部署和认证闭环见 `docs/reports/P4-A-cloud-ci.md`。
- 当日对 `/v1/health` 发起只读请求，返回 HTTP `200` 和 `ok:true`。
- 上述状态更新只记录已经完成的测试环境操作，不扩大自动合并或生产发布授权。

---

## 不扩展原则

- 相同有效范围不重复询问。
- **新增高权限操作不得自动扩展许可**：例如已授权"任务分支 push"**不等于**已授权
  "自动合并"或"CI 配置修改"。
- 未授权的操作一律拒绝，并标记为 `blocked_approval`。
