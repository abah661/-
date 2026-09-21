# 首次推送到远程（需本机认证）

状态：**待执行**。远程 `origin` 已配置，但 GitHub 写操作需要凭据（当前返回 401）。

---

## 为什么需要你亲自执行

依据项目书：

- **规则 5**：敏感文件不提交、不上传、不进入日志
- **第 11 节**：执行器身份由认证映射，凭据独立、可撤销
- **第 4.1 节**：登录文件、密码、私钥不得交给对方或上传云端

凭据不应经过 agent 传递或写入任何文件。因此这一步必须由你在本机完成。

---

## 执行步骤

在项目目录打开终端：

```bash
cd "C:\Users\lenovo\Desktop\双端连接"
git push -u origin main
```

本机已配置 `credential.helper=manager`，会弹出浏览器或 GUI 登录窗口。
认证成功后，凭据由 **Windows 凭据管理器** 保存，后续推送无需重复输入。

`-u` 参数同时设置上游跟踪，之后直接 `git push` 即可。

---

## 认证方式说明

### 方式一：Git Credential Manager（推荐）

```bash
git push -u origin main
# 弹窗选择 "Sign in with your browser" 并完成授权
```

**优点**：凭据加密存于系统凭据管理器，不进仓库、不进配置文件。

### 方式二：个人访问令牌（PAT）

若无法使用浏览器登录：

1. 在 GitHub 生成 PAT（需 `repo` 权限）
2. 推送时把 PAT 作为**密码**填入（用户名填 GitHub 用户名）

**不要**把 PAT 写进 remote URL：

```bash
# ❌ 绝对不要这样做——token 会明文留在 .git/config
git remote set-url origin https://<TOKEN>@github.com/abah661/-.git
```

正确做法是让凭据助手保存，或用临时环境变量：

```bash
# 仅当前会话有效，不落盘
GIT_ASKPASS=... git push -u origin main
```

---

## 授权确认（重要）

第 11 节把 `push` 列为**需授权操作**，并要求：

> 明确仓库、分支前缀、有效期，可一次授权同一范围

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/abah661/-.git` |
| 分支 | `main`（主干） |
| 有效期 | 待定 |

**需要你与 A 端确认**：首次推送 `main` 主干由谁执行。
第 P0 节流程是"A 创建仓库并配置 B 的协作权限，B 克隆"，
但当前情况是 B 端本地已有完整提交、A 端尚未参与。

两种选择：

- **A**：由你（B 端）推送 `main`，A 端之后克隆 —— 需 A 确认不会与其本地冲突
- **B**：把本地提交交给 A 端由其推送 —— 需通过 Git 传输，不要用 Syncthing 传 `.git`

建议走第一种，因为提交历史已在本地。

---

## 推送前自检

```bash
# 1. 确认工作区干净
git status
# 应为 "nothing to commit, working tree clean"

# 2. 确认没有敏感文件被跟踪
git ls-files | grep -iE "\.env|\.pem|\.key|auth\.json|credentials"
# 应无输出（package.json 等含 "key" 的正常文件除外，需人工判断）

# 3. 确认代理配置
git config --local --get http.proxy
# 应为 http://127.0.0.1:7897

# 4. 确认远程地址
git remote -v
# origin 应为 https://github.com/abah661/-.git
```

---

## 推送后验证

```bash
# 远程应出现 main 分支
git ls-remote --heads origin

# 本地应显示上游跟踪
git branch -vv
```

然后把远程 `main` 的实际提交号记录到 `docs/version-matrix.md`，
作为**双方共同基线 SHA**（第 P0 节交付要求）。

---

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `401 Unauthorized` | 未认证或凭据失效 | 重新执行 `git push`，完成登录 |
| `CONNECT tunnel failed, 502` | 代理端口错误 | 确认用 `7897` 而非 `59723` |
| `Failed to connect ... 443` | 未走代理 | 检查 `git config --local --get http.proxy` |
| `remote: Permission denied` | 无仓库写权限 | 需 A 端在 GitHub 添加你为协作者 |
| 推送后无上游 | 忘了 `-u` | `git branch --set-upstream-to=origin/main main` |
