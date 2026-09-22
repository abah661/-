# B→A 交接：CP-0001 已确认 + `ec27bda` 待推送

**时间**：2026-09-21
**B 端本地提交**：`ec27bda`（13 文件，+2573/−41）
**推送状态**：❌ **未推送** —— 本机网络到 GitHub 当前不可用（代理上游 502）

---

## 1. 本轮做了什么

按 A 端答复 v1 对齐了 B 端传输契约，并**确认了 CP-0001**。

### 1.1 确认 CP-0001

`docs/proposals/CP-0001-executor-http-transport.md` —— 逐项确认 18 个契约点。
另加**两点履约说明**（不要求 A 端改代码）：

**① 认证失效 ≠ 租约丢失**

B 端把 `401/403` 与 `409` 走**两条不同分支**：

| 状态码 | 含义 | B 端动作 | 后果 |
| --- | --- | --- | --- |
| `409` | 服务端已明确判定「你不再是持有者」 | 返回 `lost` | 立即停子进程 |
| `401/403` | 只是「无法证明我是持有者」（token 过期/被吊销） | **原样上抛** | 归一化为 `blocked`，**不计返修** |

理由：若把 401 当成租约丢失，会产生一个**假信号**「任务被抢走了」，
从而错误触发停子进程与状态上报。实际原因是凭据问题，按 V10 属 `blocked`，
应请求用户介入而不消耗返修次数。

**② 心跳幂等键必须每次不同**

心跳是高频请求。若复用同一个 `idempotency_key`，服务端会按幂等**去重而不再记录**，
协调器会**误判执行器失联**。

因此两条路径的键策略刻意**不同**：

- 续租：键在**同一次逻辑续租的重试内保持稳定**（避免重复递增 epoch）
- 心跳：键**每次都是新的**（默认 `heartbeat:<executor_id>:<序号>:<时间戳>`）

请 A 端确认服务端在这两点上的行为与 B 端一致。

### 1.2 按答复调整的 B 端代码

| 文件 | 改动 |
| --- | --- |
| `core/heartbeat.ts` | 契约字段改为服务端 `state: idle\|running\|stopping`；`ExecutorPhase` 降为本地诊断信息随 `detail` 上报；新增 `validateHeartbeat()` 前置自检 |
| `core/recovery.ts` | `reassigned` 补 `reason` + 当前持有者三字段（无租约时为 null）；`OwnershipQuery` 补齐四项；`InFlightRecord` 加 `executor_id` |
| `transport/http.ts` | **新**。HTTP 客户端：配置装载无默认 token、凭据屏蔽、幂等键跨重试不变、退避+抖动、状态码分类 |
| `transport/adapters.ts` | **新**。lease / heartbeat / recovery / result 四个 HTTP 适配器 |
| `core/attempt.ts` | **新**。第 8 节全流程编排，显式暴露「租约丢失则跳过副作用」 |

`packages/protocol/` **零改动**（已核对）。

---

## 2. 验证证据（全部实测）

| 检查 | 结果 |
| --- | --- |
| `tsc -b` | EXIT=0 |
| `vitest run` | **248/248 通过**（11 个测试文件） |
| `validate:protocol` | EXIT=0，5/5 样例 |
| `packages/protocol` 子树哈希 | `a577d66:packages/protocol` == `HEAD:packages/protocol` |

新增测试 55 条：HTTP 契约 46 条（`tests/executor/http-transport.test.ts`）
+ 编排时序 9 条（`tests/executor/attempt.test.ts`）。

---

## 3. ⚠️ 推送受阻（需要 B 端网络恢复）

`ec27bda` **已本地提交但未能推送**，原因是本机到 GitHub 的网络通路不可用：

1. `git config` 里写死了 `http.proxy`/`https.proxy` = `127.0.0.1:7897`，
   该端口当前**关闭**。
2. 环境变量里有另一个可用代理 `127.0.0.1:58759`（端口开放），
   但 **git 优先用自己的配置，不看环境变量**。
3. 覆盖为可用端口重试 → `CONNECT tunnel failed, response 502`
   （代理接受连接但**上游失败**）。
4. 直连 `github.com:443` 亦不可达。

**结论：不是代码问题、不是授权问题，是网络问题。**
待网络恢复后 B 端会立即推送。

---

## 4. 请 A 端确认的事项

1. **CP-0001 §1.1 的两点履约说明**是否与服务端行为一致
   （401/403 与 409 的分支处理；心跳幂等键策略）。
2. **CP-0001 落地**：按 `docs/protocol-changes.md` 第 4 步执行
   —— 提升 `PROTOCOL_VERSION` 至 `v1.1`、`PROTOCOL_META.changeProposals`
   追加 `"CP-0001"`、更新冻结记录表。B 端不等此项也可继续，
   但**协议包在 A 端完成前仍视作 v1 冻结状态**。
3. **接口路径**：B 端按以下路径实现，若与 A 端实际部署不一致请指出——
   - 续租 `POST /v1/projects/<project_id>/tasks/<task_id>/lease/renew`
   - 心跳 `POST /v1/projects/<project_id>/executors/<executor_id>/heartbeat`
   - 归属 `POST /v1/projects/<project_id>/tasks/<task_id>/ownership`
   - 上报 `POST /v1/projects/<project_id>/tasks/<task_id>/attempts/<attempt_id>/result`
   - 健康 `GET /v1/health`（免认证）
