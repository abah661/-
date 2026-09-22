# B → A：B4 完成回报

## B 端阶段回报

- **阶段**：B4
- **分支**：`task/TASK-B-EXECUTOR/TASK-B-EXECUTOR-B4`
- **B4 基线**：`d493bd263febefcc4faca21da617520ce03fefa8`（`TASK-A-COORDINATOR: record successful P4 deployment`）
  — 已核验为 HEAD 祖先：`git merge-base --is-ancestor` 退出码 `0`
- **开工 HEAD**：`2f1d91416fc82e08c6dbd75ca688b1418ad759b6`（= 权威分支 A1 顶端）
- **实际执行命令 / 退出码**：

  | 命令 | 退出码 |
  | --- | --- |
  | `npm run typecheck` | `0` |
  | `npm run validate:protocol` | `0` |
  | `npm test` | `0` |
  | `npm run check` | `0` |
  | `git diff --check` | `0` |
  | `git status --short` | `0` |

- **测试数量与结果**：**19 个测试文件全通过；398 passed \| 1 skipped（共 399）**。
  其中新增 `tests/executor/daemon.test.ts` **37 例全通过**；
  `tests/executor/http-transport.test.ts` 增至 **48 例全通过**。
  1 个 skip 是既有的平台门控 `it.skipIf(!enabled)`（`windows-integration.test.ts:571`），
  **未删除任何断言、未跳过失败用例、未降低验收标准**。
- **Cloudflare HTTP 状态**：**未执行**。B4 全程未对真实 Worker 发起请求（原因见「阻塞项」）。
- **修改文件**：
  - 新增 `apps/executor/src/daemon.ts`（常驻入口，落实交接单 §4 的 14 项）
  - 新增 `tests/executor/daemon.test.ts`（37 例）
  - 修改 `apps/executor/src/transport/http.ts`、`transport/adapters.ts`、
    `core/lease.ts`、`core/recovery.ts`、`adapters/opencode.ts`、
    `core/attempt.ts`、`index.ts`、`package.json`
  - 新增 `tests/executor/http-transport.test.ts` 中的 2 个契约回归用例
  - 文档：`docs/reports/B4-B-executor-daemon.md`

- **未完成项**：
  - 未对真实 Worker 做 `/v1/health`、注册、领取（无 Token，见下）
  - 未在常驻入口内端到端真实调用 OpenCode（`runAttempt` 走注入实现）
  - 未演练 P5（断网 / 租约过期 / 旧 epoch / 认证失效 / 自动返修）
- **阻塞项**：
  1. `B-executor-token.p7m` 未收到 → 无法做真实认证、健康检查与注册
  2. `PROJECT_ID` 未提供 → 无法进入 P3
  3. 独立目标业务仓库 `<TARGET_REPO_URL>` 未提供
  4. 最小任务图未提供
- **下一步**：推送 B4 分支后，等 A 端独立审查整合；收到 `.p7m` 即完成安全接收 +
  健康检查 + 注册，报 HTTP 状态（不报 Token）。

---

## 一、需要 A 端重点看的一件事：5 个真实集成缺陷

B4 最有价值的产出不是常驻循环本身，而是**在接通真实协调器前先读了 A 端源码**，
因而发现执行器传输层有 5 处与真实服务端契约不符。这些缺陷**在既有测试下全绿**，
因为假体恰好也错成了同样的形状；不修就交付一个「本地全绿、真实双机必失败」的入口：

| # | 缺陷 | 真实后果 | A 端依据 |
| --- | --- | --- | --- |
| 1 | `http.ts` 从未把 `idempotency_key` 放进请求体 | 续租/心跳/领取全部 `400` | `api.ts` `requireIdempotencyScope` 从 **body** 取键 |
| 2 | `renew` 只认 `{lease:{…}}` 信封 | **真实续租必被拒 → 租约必然中途过期** | `project-do.ts` `renewLease` 返回**裸租约** |
| 3 | 归属查询读 `response.lease.expires_at` | 归属永远 `unreachable`，恢复永久 `halt_offline` | `queryOwnership` 字段**平铺在顶层** |
| 4 | 上报发自定义信封 | **结果永远无法上报** | `project-do.ts` 按**扁平** `ResultReportSchema` 解析 |
| 5 | 只读端点发送了 `idempotency_key` | schema 不接受 | `OwnershipQuerySchema` 无此字段 |

已按真实契约修正，并为上述真实形状补了回归测试。**请 A 端在审查时确认这 5 处理解无误**，
尤其是第 2 条（`renewLease` 返回裸租约）与第 4 条（上报体是扁平报告）。

此外，`core/lease.ts` 与 `core/recovery.ts` 中原本要求 `Lease` 全字段的类型过窄——
归属查询响应里没有 `binding`/`agent_kind`，已放宽为 `Pick<…>`。这是**类型层面的真实约束**，
不是为通过测试而放松。

---

## 二、§10 缺失信息一次性清单

| 项目 | 真实状态 |
| --- | --- |
| Node.js 22 | ✅ `v22.22.2` |
| npm | ✅ `10.9.7` |
| Git | ✅ `2.55.0.windows.3` |
| OpenCode | ✅ 已安装 `1.18.31` |
| OpenCode 登录 | ✅ 存在凭据文件 `~/.local/share/opencode/auth.json`（未读取内容） |
| OpenCode 模型 | 已配置 provider `myapi`（`https://www.yyapi.cloud/v1`），可用模型含 `gpt-5.5` / `gpt-5.4` / `gpt-6-astra` / `gpt-5.6-sol` / `glm-5.3-flash` / `gemini-3.8-flash`；测试按 `myapi/gpt-5.6-sol` 配置 |
| OpenCode 配额是否可用 | ⚠️ **未验证**（需一次真实调用才能确认；B4 未实跑） |
| B 的 GitHub 登录 | ✅ 先前向 `origin`（`https://github.com/abah661/-.git`）推送 `ae659a9` 成功，且 `git ls-remote` 复核字节一致 |
| `B-token-public.cer` | ✅ 已生成，`C:\Users\lenovo\Desktop\B-token-public.cer`（797 B，指纹 `893EA59AAAFC83C66DB2273E386DBDB92B7F39DF`，`certutil` 报告 **`私钥不能导出`** 且 **`通过了加密测试`**，未导出 PFX） |
| `B-executor-token.p7m` | ❌ **未收到** |
| `PROJECT_ID` | ❌ 未提供 |
| `<TARGET_REPO_URL>` | ❌ 未提供 |

未索取、也未记录任何 GitHub / Cloudflare / 邮箱 / 模型服务的登录口令。

---

## 三、需要 A 端回复

1. `B-token-public.cer` 已在 B 桌面，**请告知交接方式**（微信文件？仓库外的其他通道？），
   或确认可由 A 端从该路径取用。
2. 请回传 `B-executor-token.p7m`（仅 `EXE-B-OPENCODE` 的 Token）。
3. 请提供 `PROJECT_ID`、最小任务图、独立 `<TARGET_REPO_URL>`。
4. 请确认第一节中 5 处契约理解（尤其第 2、4 条）。
5. 请确认 B4 分支整合方式：A 端**独立审查后整合**，不直接覆盖 `apps/executor/**`。
