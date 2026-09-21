# P2-B：执行器公共内核、OpenCode 适配器与结果归一化

提交：`5bc8048`
范围：P2 分工表 B 端三项（执行器公共内核、OpenCode 适配器、结果归一化）
维护者：B（OpenCode）

## 1. 交付内容

```
apps/executor/
  package.json          @dac/executor，仅依赖 @dac/protocol
  tsconfig.json         项目引用协议包
  src/index.ts          统一导出面
  src/core/             公共内核（第 8 节：Git、网络、租约、测试、日志）
    process.ts          固定参数数组调用、三级进程树停止、超时控制
    lease.ts            领取预检、独立续租、epoch 管理、失效判定
    worktree.ts         基线校验、独立 worktree、路径越界防护
    heartbeat.ts        进度上报（与续租职责分离）
    evidence.ts         测试证据采集与汇总解析
    diff-check.ts       实际 diff 与写入范围核对（规则 3）
    recovery.ts         重启恢复：先核对云端归属
  src/adapters/
    opencode.ts         OpenCode 非交互调用与结构化事件
  src/result/
    normalize.ts        结果归一化为协议 ResultReport
```

**未修改**：`packages/protocol`（子树哈希仍为 `f9644c44...`）、
`apps/coordinator`、`.github/`、`AGENTS.md`。

## 2. 公共内核要点

### 2.1 进程控制（Windows 重点项）

`runProcess` 以**固定程序 + 参数数组**调用，`shell: false`，不提供任何
拼接命令字符串的入口（第 8 节步骤 4：不执行云端任意 shell 字符串）。

超时后走**三级停止升级链**，每级都有时间边界：

| 级 | 触发 | 动作 | 标记 |
| --- | --- | --- | --- |
| 1 | 到达 `timeout_ms` | 优雅停止整棵树（`taskkill /T`，无 `/F`） | `timed_out` |
| 2 | 再等 `grace_ms` 未退出 | 强杀整棵树（`taskkill /T /F`） | `escalated_to_force` |
| 3 | 再等 `grace_ms` 仍未退出 | **放弃等待**，按 `exit_code: null` 返回 | `kill_failed` |

第 3 级不可省略：若进程被驱动占用或处于僵尸态，无限 `await` 会让执行器
永久卡死。返回 null 让上层能记录并继续，远优于整套流程挂住。

Windows 上用 `taskkill /T` 是必需的 —— `child.kill()` 只杀父进程，
被 agent 拉起的测试进程会变成孤儿继续占用 worktree 与文件锁。

### 2.2 租约（验收 V08）

- 续租成功时记住服务端返回的**新 epoch**；上报必须用当前值而非领取时的旧值。
- 服务端明确报丢失（epoch 过期 / 非持有者）→ 立即回调 `onLeaseLost`，用于停子进程。
- **网络异常不判丢失**：连续失败达到阈值才判。否则网络抖动会让任务被无辜中断。
- 续租循环独立于任务主循环 —— agent 跑长命令时主循环可能被阻塞。

### 2.3 写入范围核对（规则 3）

`write_scope` 只是声明，必须用**实际 diff** 复核。要点：

- `deny` 优先级**高于** `allow`（硬边界）。
- 自实现 glob → 正则，避免两端引入不同 glob 库导致解释不一致。
- **新增文件也计入变更**。只比对已跟踪文件会漏掉「偷偷新建越界文件」
  （与冻结守卫那次「逐文件比对发现不了增」是同一类疏漏）。
- Windows 反斜杠路径先规范化为正斜杠再匹配。

### 2.4 恢复（含休眠恢复）

**先查云端归属，再动本地状态**：

| 云端回答 | 决策 | 理由 |
| --- | --- | --- |
| 仍归我且未过期 | `resume` | 可从上次完成阶段继续 |
| 仍归我但已过期 | `abandon_expired` | 上报并让协调器重派 |
| 已被重派 | `abandon_reassigned` | **不得推送**，否则两方同时改同一任务 |
| 云端不可达 | `halt_offline` | 第 7 节：断网停止新操作，不猜 |
| 任务不存在 | `abandon_unknown` | 本地记录是垃圾，清理 |

## 3. OpenCode 适配器

### 3.1 两条实测约束（非推测）

于本机 OpenCode CLI 实测（2026-09-21）得到，已固化为实现：

**约束 1：必须显式传 `-m <provider>/<model>`**

```
opencode run --format json "..."                    → 401 APIError "Invalid token"
opencode run -m myapi/gpt-5.5 --format json "..."   → 正常返回
```

不带 `-m` 时 OpenCode 落到**环境变量里的 provider**（本机串到
`OPENAI_API_KEY` 指向的端点），与用户配置的 provider 无关。
因此本适配器**不做模型默认推断**：`model` 缺省即抛错，
不留「静默走错 provider 再报 401」的空间。

**约束 2：`--format json` 是 JSON Lines 事件流**

已观测事件类型：

| 事件 | 关键字段 |
| --- | --- |
| `step_start` | `sessionID` |
| `text` | `part.text` |
| `step_finish` | `part.reason`（正常为 `stop`）、`part.tokens`、`part.cost` |

解析**不假设事件种类封闭**：只提取认识字段，未知类型仅计数。
容忍空行与噪音行（计入 `invalid_json_lines`，>0 视为输出不可信）。

### 3.2 错误分类（第 8 节 / §193）

优先使用**结构化错误对象**（`{"type":"error","error":{...}}`），退化到文本匹配：

| 情形 | 分类 | 协议错误码 | 处置 |
| --- | --- | --- | --- |
| `statusCode: 401` / invalid token | `blocked_auth` | `AUTH_EXPIRED` | 阻塞，请求介入，**不计返修** |
| 余额/额度文案 / `402` | `blocked_quota` | `QUOTA_EXHAUSTED` | 阻塞，请求介入，**不计返修** |
| `429` / rate limit | `retryable` | `RATE_LIMITED` | 协调器重派，**不计返修** |
| 其余 | `failed` | 由退出码判定 | 视情况返修 |

同时提取 `metadata.url` 作为 `request_url` 输出 —— 这是诊断
「是否走错 provider」的关键线索（本次 401 排查即靠它定位到串到了别的端点）。

## 4. 结果归一化（验收 V06 / V10）

**adapter `completed` ≠ 协议 `ready_for_integration`。**
第 8 节步骤 8：agent 说完成或退出码为 0 都不足以判定成功。

降级判定（按优先级）：

| 条件 | 结果状态 | 错误码 |
| --- | --- | --- |
| 触碰敏感文件 | `blocked_approval` | `SENSITIVE_FILE_DETECTED` |
| diff 越界 | `repair_pending` | `DIFF_OUT_OF_SCOPE` |
| 无测试证据 | `repair_pending` | `TESTS_FAILED` |
| 测试退出码非零 | `repair_pending` | `TESTS_FAILED` |
| 有失败用例（退出码 0 也不能绕过） | `repair_pending` | `TESTS_FAILED` |
| `head_sha === base_sha`（无提交） | `repair_pending` | `INTERNAL_ERROR` |

返修计数**一律查协议 `ERROR_POLICY`**，不另写一套规则 ——
两端对「什么算代码失败」的理解必须来自同一张表（V10）。

`normalizeResult` 是**纯函数**：不读时钟、不发网络、不碰文件系统，
时间由 `reported_at` 注入，测试完全确定。

## 5. 测试与验证

新增 98 个用例（`tests/executor/`，共 4 个文件）：

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `opencode-adapter.test.ts` | 24 | 模型必填、参数顺序、事件解析、错误分类、超时兜底 |
| `normalize.test.ts` | 33 | 全部降级路径、返修计数、**生成的报告必过协议 schema** |
| `core-process.test.ts` | 25 | 三级停止链、glob 语义、敏感文件、中文/空格路径 |
| `lease-recovery.test.ts` | 16 | epoch 递增、抖动容忍、五种恢复决策 |

**实测结果**：

```
npx tsc -b              → EXIT=0
vitest run              → 178/178 通过（原 80 + 新增 98）
validate:protocol       → EXIT=0，5/5 样例
```

其中部分用例使用**本机实测捕获的真实事件流**作为夹具
（成功流与 401 流各一份），确保解析逻辑对准真实输出格式而非理想化样本。

## 6. 未完成 / 待对接

以下不属于本次提交范围，需要与 A 端协商：

1. **Codex 适配器接口对齐**。A 端已提供 `packages/codex-adapter`（本端
   未复制其代码）。两端适配器结果结构已刻意保持同形，但**尚无编译期
   保证**——建议由 A 端定义共享的适配器接口类型，或确认双方约定即可。

2. **协调器 HTTP 客户端**。本端 `LeaseTransport` / `HeartbeatTransport` /
   `RecoveryTransport` 均为接口，尚无实现，因为 Worker API 的请求体形状、
   认证方式等**正是交接文档中 A 端待回应的 4 个问题**。接口稳定后补实现。

3. **执行器入口 `src/index.ts`（常驻进程）**。当前导出的是可组合模块，
   常驻循环未接。原因是它依赖上一条的 HTTP 客户端。
   另：开机自启需**另行批准**（README 已注明）。

4. **Windows 真实进程集成测试**。本次全部用假运行器（保证确定、不烧配额）。
   真实拉起进程验证中文/空格路径与进程树停止，建议在 HTTP 客户端接通后
   一次性做端到端联调，避免重复搭建环境。

## 7. 给 A 端的协作说明

- 本分支未触碰 `packages/protocol`，无需协议变更提案。
- 若 A 端在 `apps/executor/` 有需要调整的地方，**请提出来由 B 端改**
  （AGENTS.md：`apps/executor/**` 维护者为 B，A 不得覆盖）。
- 第 6 节第 2 条的接口问题若已有结论，请优先答复，这是 B 端继续实现
  常驻入口的唯一阻塞项。
