# B → A：待回复事项清单（可直接转发）

日期：2026-09-22
提出者：B（OpenCode / abah）
状态：B 端 P2 主体已完成并推送至 `origin/main`（`2b80674`）。
本清单是**当前仍需 A 端回复**的全部事项，按阻塞程度排序。
已由 A 端答复 v1 覆盖的旧问题（请求体形状、认证方式、DO 路由）**已从本清单移除**。

> 相关文档：
> - `docs/handoff/B-to-A-remote-integration-check.md` —— 基线分叉的完整证据
> - `docs/proposals/CP-0001-executor-http-transport.md` —— B 端已确认的 18 个契约点
> - `docs/handoff/B-status-and-pending.md` —— B 端整体状态

---

## 汇总表

| # | 事项 | 阻塞程度 | 阻塞了什么 | 需要 A 端做什么 |
| --- | --- | --- | --- | --- |
| 1 | 领取任务端点契约 | ⛔ 硬阻塞 | 常驻循环、P3 全部 | 补一节接口说明 |
| 2 | CP-0001 两点履约确认 | ⛔ 硬阻塞 | 联调行为不一致风险 | 确认/纠正两个服务端行为 |
| 3 | A 分支基线分叉 | ⛔ 硬阻塞 | 联调（协议版本对不上） | 决定 rebase 还是 merge |
| 4 | 接口路径核对 | ⚠️ 中 | 联调（路径对不上就 404） | 核对 5 条路径 |
| 5 | 资料清单格式 | ⚠️ 中 | 资料校验的最后一步 | 给出格式或确认 B 端假设 |
| 6 | CI 是否覆盖 `apps/executor` | ⚠️ 低 | 质量门可见性 | 告知现状 |

---

## 1. ⛔ 领取任务的端点契约（硬阻塞）

**这是最关键的一项。** A 端答复 v1 覆盖了续租 / 心跳 / 归属 / 上报四个端点，
但**没有描述「领取任务」（lease）的请求与应答形状**。

**为什么阻塞**：`apps/executor/src/core/attempt.ts` 的编排依赖一个**已持有的租约**，
但「怎么拿到第一个租约」没有定义。因此：

- `apps/executor/src/index.ts` 的**常驻循环**（领取 → 执行 → 上报 → 循环）接不上
- 《项目书》P3「离线与本地集成」无法开始

**B 端需要知道**：

| 问题 | B 端当前假设 | 请 A 端确认或纠正 |
| --- | --- | --- |
| 路径与方法 | `POST /v1/projects/<project_id>/tasks/lease` | ？ |
| 请求体 | `{ protocol_version, executor_id, capabilities?, write_scope? }` | ？ |
| 能力声明 | 传支持的 `agent_kind` 列表，供服务端过滤 | 是否需要？字段名？ |
| 应答体 | `{ task, lease }`，与续租同形 | ？ |
| 无任务可领 | `200 { task: null }` | 还是 `204`？还是 `404`？ |
| 幂等键 | scope = `lease_task`（协议 `IDEMPOTENCY_SCOPES` 里已有此值） | 重试时同一键是否保证**不产生两个租约**（验收 V02）？ |
| 竞争语义 | 服务端在 DO 内串行化，只有一个请求拿到有效租约 | 由谁保证？ |
| 租约时长 | B 端需要知道 `expires_at` 以保证心跳间隔 < 有效期 | 默认值？可配置？ |

**验收依据**：V02「同一任务竞争 → 只产生一个有效领取」。

---

## 2. ⛔ CP-0001 的两点履约确认（硬阻塞联调）

B 端已在 `docs/proposals/CP-0001-executor-http-transport.md` §3 记录，
并已在代码中实现。**需要 A 端确认服务端行为与之**一致**，否则联调会出实质错误。

### ① 401/403 与 409 必须走不同分支

| 状态码 | B 端理解 | B 端实际动作（已实现） |
| --- | --- | --- |
| `409` | 服务端已判定「**你不再是持有者**」 | 返回 `lost` → **立即停止子进程**，不再推送/上报 |
| `401` / `403` | 只是「**无法证明我是持有者**」 | 上抛 → 归一化为 `blocked`（`blocked_auth`），**不计返修次数** |

**风险**：若服务端在 token 过期时**也**返回 `409`，B 端会**错误地停掉正在跑的子进程并上报丢租约**。
这是行为不一致，必须在联调前对齐。

**验收依据**：V10「登录与配额失败 → 分类阻塞，无无限重试」。

### ② 心跳的 `idempotency_key` 必须每次不同

B 端的心跳键每次递增（`heartbeat:<executor_id>:<序号>:<时间戳>`），
因为心跳是**周期性新事件**，不是同一请求的重试。

**风险**：如果服务端按 scope 对心跳做**幂等去重**，重复键会导致心跳不被记录，
协调器会**误判执行器失联**，进而可能触发不必要的任务重派。

**请确认**：心跳端点是否对 `idempotency_key` 做去重？
若做，是否只对**同一键在短时间窗口内的重复请求**去重（这才是合理语义）？

> 对比：续租（renew）的幂等键在**同一次逻辑续租的重试之间保持稳定**，
> 因为那是同一个请求的重试。两者语义不同，B 端已分别处理。

---

## 3. ⛔ A 分支基线分叉（硬阻塞联调）

**完整证据见** `docs/handoff/B-to-A-remote-integration-check.md`。摘要：

| 事实 | 值 |
| --- | --- |
| A 分支 | `refs/heads/task/TASK-A-COORDINATOR/TASK-A-COORDINATOR-A1` = `67e72da` |
| 该分支独有提交 | 4 个（`fb9202f` / `88ff82d` / `2f1e4d5` / `67e72da`） |
| 与 main 的共同祖先 | `a577d66`（= **冻结锚点**，status 当时仍为 `draft`） |
| main 是它的祖先吗 | ❌ NO |
| 它是 main 的祖先吗 | ❌ NO → **两侧已分叉** |
| 它对 `packages/protocol` 的改动 | **空**（未主动改，只是沿用了冻结点前的旧快照） |
| 它上面的 `version.ts` | `status: "draft"`、`frozenAt: null`、**无 `frozenTreeSha`** |

**含义**：A 的协调器代码跑在**协议冻结之前**的世界里。冻结动作（`00a1acf` 写入
`frozenTreeSha`）与冻结守卫修复（`bbd57fd`）都只在 main 上。
A 的 `project-do.ts` 会把 `PROTOCOL_META` 直接回给客户端，因此**会回一个 `draft` 状态的协议元数据**。

**好消息**：**无文件级冲突**。A 动 `apps/coordinator` / `packages/codex-adapter` /
`packages/integration` / `tools/cli` / `.github/workflows`；
B 动 `apps/executor` / `tests/executor` / `docs`。
唯一重叠的 `version.ts` 属于「A 整侧落后」而非双向修改。

**请 A 端决策**：

1. 这 4 个提交是**在 `a577d66` 上 rebase 到当前 main**，还是先 merge main 再合回？
   **B 端建议 rebase** —— `version.ts` 与 `tools/validate-protocol` 会自然取到 main 的冻结版本，
   不需要人工处理合并方向。
2. `package-lock.json` 由谁重新生成？**B 端建议** A 在 rebase 后于 main 侧统一 `npm install`。
3. A 是否已经知道自己的分支基线是 `a577d66`？
   （A 的 `docs/reports/P2-A-coordinator.md` 写「协议远端 `PROTOCOL_META.status` 仍显示 `draft`，
   因此 P1 的冻结事实仍待 B 端确认和远端记录核实」——
   **冻结记录其实已经在 main 上**，A 只需 rebase/merge 即可获得。）

---

## 4. ⚠️ 接口路径核对（阻塞联调）

B 端按以下路径实现（在 `apps/executor/src/transport/http.ts`）。
若与 A 端实际部署不一致，**联调时会 404**，请在联调前核对：

| 用途 | B 端实现的路径 | 是否需要认证 |
| --- | --- | --- |
| 健康检查 | `GET /v1/health` | 否（B 端按免认证实现） |
| 续租 | `POST /v1/projects/<project_id>/tasks/<task_id>/lease/renew` | 是 |
| 心跳 | `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat` | 是 |
| 归属查询 | `POST /v1/projects/<project_id>/tasks/<task_id>/ownership` | 是 |
| 结果上报 | `POST /v1/projects/<project_id>/tasks/<task_id>/attempts/<attempt_id>/result` | 是 |
| **领取任务** | **未实现（见 §1）** | 是 |

**另需确认**：`<project_id>` 的转义方式。B 端用 `encodeURIComponent`，
若 A 端的 project_id 允许含 `/` 或有特殊约定，请说明。

---

## 5. ⚠️ 资料清单格式（阻塞资料校验的最后一步）

B 端**已实现**资料校验的完整逻辑（`apps/executor/src/core/materials.ts`），
覆盖《项目书》§10.2 / §10.3 与验收 V15 / V16：

- SHA-256 计算与清单比对（V15）
- 不完整包判定为不可用，**不返回任何可用路径**（V16）
- 路径越界与同步冲突副本**根本不读取**
- 任务 ID 不符则整体拒绝
- 纯读取，不写/不移/不删同步目录

**唯一待定的是清单的序列化格式。**

| 问题 | B 端当前假设 | 请确认 |
| --- | --- | --- |
| 清单位置 | 同步根目录下的 `manifest.json` | ？ |
| 格式 | JSON：`{ task_id, revision?, entries: [{ artifact_id, revision, path, sha256, size?, required? }] }` | ？ |
| `path` 相对谁 | 相对同步根目录 | ？ |
| 是否含 `size` | 可选，用于快速发现部分同步 | ？ |
| 是否含 `required` | 可选，标记「必要附件」；必要附件缺失 → 任务**等待**而非报普通错误 | ？ |
| 命名约定 | `<TASK_ID>/<ARTIFACT_ID>-<REVISION>.<EXT>`（§10.2 建议） | ？ |

**B 端已做的设计**：清单解析是**可替换的入口**（`parseManifestJson`），
A 端确认格式后只需换解析器，**校验逻辑一行不动**。

**若 A 端暂无意见**：B 端按上述假设使用，并在 `docs/` 记录假设点。

---

## 6. ⚠️ CI 是否覆盖 `apps/executor`（低）

A 端的 `.github/workflows/ci.yml` 已存在（在任务分支上）。
B 端想知道：**它是否包含 `apps/executor` 的 typecheck 与 test？**

若否，B 端可以补一个 PR 或由 A 端直接加入。
（B 端不自行修改 `.github/workflows/**` —— 按 `AGENTS.md` 该路径属 A 端。）

---

## 附一：B 端本轮已自行完成、不需要 A 端回复的事项

以下在 A 端答复前已由 B 端独立完成，列在此处仅为让 A 端了解进度：

| 工作 | 结果 |
| --- | --- |
| 真实进程集成测试 | `tests/executor/windows-integration.test.ts`，20 用例，真实 `taskkill /T` 杀进程树 |
| 真实 Git worktree 测试 | 中文 + 空格路径下真实 `git worktree add/remove` |
| 资料校验模块 | `apps/executor/src/core/materials.ts` |
| 上下文导出与脱敏 | `apps/executor/src/core/context.ts` |
| Windows 路径边界测试 | `tests/executor/windows-paths.test.ts`，UNC / MAX_PATH / 盘符大小写 |

**并且通过真实运行发现并修复了一个生产代码缺陷**（详见 §附二）。

## 附二：真实运行发现的生产缺陷（供 A 端参考）

**`parseTestSummary` 无法解析真实失败输出。**

- 真实 vitest 3.x 在**有失败**时输出：`Tests  1 failed | 1 passed (2)`
  （分隔符是**竖线**，且各段顺序不固定）
- 原实现用单条可选组大正则，只能处理 `Tests  16 passed (16)` 这类全绿格式
- **后果**：**真实失败**的运行会被判为「无法判定」（`summary_parsed: false`），
  而这是最不能出错的分支——直接关系到 V06「退出 0 或完成文案不能绕过测试」

已修复为按段解析。**此缺陷是用假运行器测不出来的**，印证了《项目书》P3
「模拟测试不能替代真实 CLI 验证」。

**对 A 端的提示**：若 Codex 适配器侧也有类似的测试输出解析逻辑，
建议同样用**真实失败输出**验证一遍，不要只用构造的字符串。

---

## 附三：优先级与建议顺序

```
第 1 步（不依赖 A 端，可并行）：A 端 rebase 分支到 main        ← 解除 §3
第 2 步：A 端补「领取任务」接口说明                            ← 解除 §1
第 3 步：A 端确认 CP-0001 两点行为                             ← 解除 §2
第 4 步：双方核对 5 条接口路径                                 ← 解除 §4
第 5 步：进入 P3 真实双机联调
```

**若 A 端只能先做一件事**：请做**第 1 步（rebase）**——
它是零风险、纯机械操作，且解除后 A 端才能看到 B 端已有的冻结守卫与协议校验。
