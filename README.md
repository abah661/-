# 双人 Agent 自动并行开发系统（协调系统仓库）

本仓库是《双人 Agent 自动并行开发项目书》中**协调系统**部分的实现：

> 用户提交需求后，系统自动规划任务、确定接口契约、分配给两台电脑上的 agent、
> 收集提交、测试组合结果，并在失败后自动派发返修任务。

**当前状态：P0/P1 基线已完成；P2 A 端组件（含 Codex 适配器）与 P3 A 端离线集成第一版已实现。** 协议仓库当前远端元数据仍为
`draft`，不能把项目书附件中声称的冻结记录当作远端已生效的事实；本分支不修改协议定义。
协调器（Worker + Durable Object）和管理 CLI 已完成本地离线实现，B 端执行器与适配器不在本分支范围内。

---

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 项目初始化、仓库规则、目录结构、可运行基线 | ✅ 已完成 |
| P1 | 协议 v1 冻结、协议校验、依赖环检测、模拟双机测试 | 🟡 协议已定义，待双方核对后冻结 |
| P2 | 双方开发组件（Worker/DO、执行器内核、双适配器） | 🟡 A 端 Worker/DO/CLI/Codex 适配器已完成第一版，B 端执行器待其分支 |
| P3 | 离线与本地集成 | 🟡 A 端固定整合/独立验收第一版已完成，真实双机待 B 端 |
| P4 | 接通 Cloudflare 与 GitHub | 🟡 GitHub 推送与 CI 已接通；Cloudflare 登录和本地打包通过，云端部署被账号邮箱验证状态 `10034` 阻塞 |
| P5 | 验收自动并行与返修 | ⬜ 未开始 |
| P6 | 可选同步与正式使用 | ⬜ 未开始 |

---

## 环境要求

按《项目书》第 4.1 节，本仓库锁定 Node.js 主版本：

- Node.js `>=22 <23`（开发验证于 v22.22.2）
- npm `>=10`（开发验证于 10.9.7）
- Git（开发验证于 2.55.0）

`package.json` 的 `engines` 字段与 `package-lock.json` 共同锁定版本。
**不要使用"永远跟随最新版"的配置**（第 4.1 节）。

---

## 安装

```bash
npm ci
```

首次克隆与 CI **必须**使用 `npm ci`（严格按锁文件安装）。
`npm install` 只用于有意更新依赖时，改动后需提交新的锁文件。

---

## 验证

```bash
npm run typecheck          # TypeScript 全量类型检查
npm run validate:protocol  # 协议元数据自检 + 样例正反向校验
npm test                   # 单元、协议、状态机、图分析、协调器、整合、适配器测试（当前 79 个）
npm run check              # 以上三项串联，提交前必须全绿
```

以**实际命令输出**为证据，不接受 agent 自报成功（第 8 节步骤 8）。

---

## 目录结构

```text
AGENTS.md                         共享工程规范（双方必读，优先级最高）
README.md                         安装、验证、结构入口（本文件）
package.json / package-lock.json  工具链与依赖锁定
tsconfig.base.json                共享 TypeScript 配置
packages/protocol/                协议 v1：schema、状态机、错误分类、样例  ← A 维护
  src/version.ts                    协议版本与冻结元数据
  src/status.ts                     任务状态机与合法转移表
  src/errors.ts                     错误分类与处置策略
  src/schemas.ts                    任务/结果/事件/租约/批次 schema
  src/defaults.ts                   时序与上限默认值（可调建议值）
  src/graph.ts                      拓扑排序、环检测、并行判定
  samples/                          正向与反向样例夹具
packages/integration/              固定整合计划与独立证据验收          ← A 维护
packages/codex-adapter/            Codex exec 非交互适配器与错误归类    ← A 维护
apps/coordinator/                  Worker API 与 Durable Object          ← A 维护
apps/executor/                     Windows 执行器与两种适配器            ← B 维护（未实现）
tools/cli/                         A 端管理 CLI（离线校验与报告检查）    ← A 维护
tools/validate-protocol/           协议校验 CLI
tests/                             单元、协议、故障与端到端测试
docs/                              接口、授权、操作与验收说明
.local/                            非敏感本机运行状态（忽略提交）
```

---

## 协议 v1 要点

协议是本项目的**单一事实来源**，定义在 `packages/protocol/src/`。
双方不得各自复制一份类型定义。

### 状态机

```
draft → planning → ready → leased → running → validating
      → ready_for_integration → integrating → passed → merged

异常：repair_pending / blocked_auth / blocked_quota /
      blocked_approval / needs_input / cancelled
```

转移表：`packages/protocol/src/status.ts` 的 `TASK_TRANSITIONS`。

### 版本绑定

每次领取绑定四项版本，缺一不可：

```ts
{ base_sha, rules_sha, contract_sha, acceptance_sha }
```

### 错误分类（验收 V10 的关键）

| 处置 | 含义 | 是否计入返修 |
| --- | --- | --- |
| `repairable` | 代码/工程类失败，自动派发返修 | 是 |
| `blocked` | 登录、配额、授权类，等待介入 | **否** |
| `retryable` | 执行器侧放弃本次尝试，协调器重派 | 否 |
| `fatal` | 终态失败，需人工判断 | 否 |

**登录过期与配额不足必须分别标记，不得按代码失败反复返修。**

### 默认参数

| 参数 | 默认值 |
| --- | --- |
| 空闲轮询 | 15 秒 + 随机延迟 |
| 心跳 | 30 秒 |
| 租约 | 180 秒 |
| 每台并发任务 | 1 |
| 单任务超时 | 30 分钟 |
| 代码返修上限 | 2 次 |
| 同项目并发批次 | 1 |

均为可调建议值，定义在 `packages/protocol/src/defaults.ts`。

---

## 双方职责

| 范围 | A（Codex） | B（OpenCode） |
| --- | --- | --- |
| 协调器、Durable Object、协议 | ✅ | 只读 + 提案 |
| 执行器内核、OpenCode 适配器 | 不覆盖 | ✅ |
| CI 与固定提交整合 | ✅ | 不直接修改 |
| 管理 CLI | ✅ | 使用 |

完整分工与授权表见 `AGENTS.md`。

---

## 下一步

当前 A 端 P3 离线集成第一版已完成，但仍有以下顺序约束：

1. B 端核对 Windows / OpenCode 可实现性，并提供成功、失败、恢复样例
2. 按协议变更流程核实冻结记录；在远端元数据真正为 `frozen` 前，不宣称协议已冻结
3. 等 B 端执行器和真实 agent 样例到位后，补真实双机与两种适配器验证
4. Cloudflare 账号后台解除邮箱验证状态 `10034` 后，重试测试 Worker 部署

本次 A 端实现与实际验证记录见 `docs/reports/P2-A-coordinator.md`、`docs/reports/P2-A-codex-adapter.md`、`docs/reports/P3-A-local-integration.md` 和 `docs/reports/P4-A-cloud-ci.md`。

---

## 相关文档

- `AGENTS.md` — 工程规范、规则、授权表（**开工前必读**）
- `docs/authorization.md` — 授权记录格式与当前已批准范围
- `docs/protocol-changes.md` — 协议变更提案流程
- `docs/version-matrix.md` — 工具版本矩阵
- `docs/project-info.md` — 项目基本信息表
