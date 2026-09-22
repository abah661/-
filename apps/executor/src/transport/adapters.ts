/**
 * 把 `CoordinatorClient` 适配为内核所需的三个传输接口。
 *
 * 内核（lease/heartbeat/recovery）只依赖窄接口，不认识 HTTP，
 * 这样单测可以用纯内存假体驱动（见 `tests/executor/lease-recovery.test.ts`）。
 * 本文件是**唯一的 HTTP 与内核的交界处**，契约细节都集中在这里。
 *
 * 契约来源：`docs/B-to-A-interface-answers-v1.md`。
 */

import type { Lease } from "@dac/protocol";
import type { LeaseTransport, RenewOutcome } from "../core/lease.js";
import type { HeartbeatTransport, HeartbeatRequest } from "../core/heartbeat.js";
import type { OwnershipQuery, RecoveryTransport, TaskOwnership } from "../core/recovery.js";
import { CoordinatorClient, CoordinatorHttpError, defaultIdempotencyKey } from "./http.js";

/* ------------------------------------------------------------------ *
 * 租约
 * ------------------------------------------------------------------ */

/** 协调器续租应答（A 端答复 §2 租约）。 */
interface RenewResponse {
  lease?: {
    task_id?: string;
    attempt_id?: string;
    executor_id?: string;
    lease_epoch?: number;
    expires_at?: string;
  };
  task?: unknown;
}

/**
 * 续租传输。
 *
 * 语义要点（A 端答复 §2）：
 * - **首次续租必须回显租约自身的 epoch**，服务端据此识别是「同一租约的常规续期」
 *   还是「拿着过期 epoch 来抢」。
 * - 服务端返回更高 epoch 或明确拒绝 → 判定丢失，且**这是权威结论**，
 *   本地必须立刻停子进程（见 `LeaseGuard.onLeaseLost`）。
 * - 网络错误**不**在此处转成「丢失」——原样抛出，由 `LeaseGuard` 按
 *   `max_renew_failures` 阈值判定，避免网络抖动导致任务被无辜中断。
 */
export class HttpLeaseTransport implements LeaseTransport {
  constructor(private readonly client: CoordinatorClient) {}

  async renew(task_id: string, attempt_id: string, lease_epoch: number): Promise<RenewOutcome> {
    const body = {
      protocol_version: "1" as const,
      task_id,
      attempt_id,
      executor_id: this.client.executorId,
      lease_epoch,
    };

    try {
      const response = await this.client.request<RenewResponse>({
        method: "POST",
        path: `/tasks/${encodeURIComponent(task_id)}/lease/renew`,
        body,
        // 重试沿用同一幂等键：重复续租不应产生第二次 epoch 递增
        idempotency_key: defaultIdempotencyKey(
          `renew_lease:${task_id}:${attempt_id}:${lease_epoch}`,
        ),
      });

      const lease = response.lease;
      const nextEpoch = lease?.lease_epoch;
      const expiresAt = lease?.expires_at;

      if (typeof nextEpoch !== "number" || typeof expiresAt !== "string") {
        // 应答不完整：不能当作成功（否则会拿着未知租约继续跑）
        throw new CoordinatorHttpError({
          code: "RESULT_SCHEMA_INVALID",
          message: "续租应答缺少 lease.lease_epoch 或 lease.expires_at",
          status: null,
          retryable: false,
        });
      }

      if (nextEpoch < lease_epoch) {
        // 服务端给了更低的 epoch —— 说明本地认知已失效，按丢失处理
        return { kind: "lost", reason: "lease_epoch_stale" };
      }

      return { kind: "renewed", expires_at: expiresAt, lease_epoch: nextEpoch };
    } catch (error) {
      if (error instanceof CoordinatorHttpError) {
        // 409：epoch 过期或已非持有者 —— 服务端权威结论，立即丢手
        if (error.status === 409) {
          return { kind: "lost", reason: "lease_epoch_stale" };
        }
        // 401/403：认证失效。**不是**「租约丢失」，而是「无法证明持有」。
        // 按 A 端答复 §4 应走 blocked_auth，这里表现为不可重试错误上抛，
        // 由常驻入口转成 blocked 结果，而不是让 LeaseGuard 误判为丢租约。
        if (error.status === 401 || error.status === 403) {
          throw error;
        }
        if (error.retryable) {
          // 网络类：原样抛出 → LeaseGuard 计数，不立即判丢失
          throw error;
        }
      }
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 心跳
 * ------------------------------------------------------------------ */

/**
 * 心跳传输。
 *
 * 心跳失败一律抛出，由 `Heartbeat` 捕获并调用 `onError` ——
 * **绝不影响任务**（A 端答复 §1：心跳只记录存活，不代替续租）。
 */
export class HttpHeartbeatTransport implements HeartbeatTransport {
  constructor(private readonly client: CoordinatorClient) {}

  async send(request: HeartbeatRequest): Promise<void> {
    await this.client.request({
      method: "POST",
      path: `/executors/${encodeURIComponent(request.executor_id)}/heartbeat`,
      body: request,
      // 心跳高频；键由 Heartbeat 生成，每次不同（重复会被去重导致误判失联）
      idempotency_key: request.idempotency_key,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 归属查询
 * ------------------------------------------------------------------ */

/** 协调器归属应答（A 端答复 §4）。 */
interface OwnershipResponse {
  ownership?: string;
  reason?: string;
  to_executor?: string | null;
  attempt_id?: string | null;
  lease_epoch?: number | null;
  lease?: RenewResponse["lease"];
}

/**
 * 归属查询传输。
 *
 * 关键区分（A 端答复 §4）：
 * - `still_mine` 只在**四项完整匹配**时返回，本地才能继续。
 * - 网络不可达 → `unreachable`（B 端本地状态，不是服务端 JSON 值），
 *   恢复流程据此走 `halt_offline`：**停止新操作，不猜**。
 * - 任何无法识别的应答都归为 `unreachable`，而不是乐观当作仍归自己。
 */
export class HttpRecoveryTransport implements RecoveryTransport {
  constructor(private readonly client: CoordinatorClient) {}

  async queryOwnership(query: OwnershipQuery): Promise<TaskOwnership> {
    try {
      const response = await this.client.request<OwnershipResponse>({
        method: "POST",
        path: `/tasks/${encodeURIComponent(query.task_id)}/ownership`,
        body: {
          protocol_version: "1",
          attempt_id: query.attempt_id,
          executor_id: query.executor_id,
          lease_epoch: query.lease_epoch,
        },
        idempotency_key: defaultIdempotencyKey(
          `query_ownership:${query.task_id}:${query.executor_id}`,
        ),
      });

      switch (response.ownership) {
        case "still_mine": {
          const lease = response.lease;
          if (!lease || typeof lease.expires_at !== "string") {
            return {
              kind: "unreachable",
              error: "归属应答为 still_mine 但缺少完整 lease",
            };
          }
          return { kind: "still_mine", lease: lease as unknown as Lease };
        }
        case "reassigned":
          return {
            kind: "reassigned",
            reason: response.reason ?? "reassigned",
            to_executor: response.to_executor ?? null,
            attempt_id: response.attempt_id ?? null,
            lease_epoch: response.lease_epoch ?? null,
          };
        case "unknown_task":
          return { kind: "unknown_task" };
        default:
          // 未知取值：保守处理为不可达，宁可 halt_offline 也不误继续
          return {
            kind: "unreachable",
            error: `无法识别的归属取值：${String(response.ownership)}`,
          };
      }
    } catch (error) {
      const message =
        error instanceof CoordinatorHttpError
          ? `${error.code}${error.status !== null ? ` (HTTP ${error.status})` : ""}`
          : error instanceof Error
            ? error.message
            : String(error);
      // 恢复流程要求：无法确认 → 停止操作。这里不做任何乐观假设。
      return { kind: "unreachable", error: message };
    }
  }
}

/* ------------------------------------------------------------------ *
 * 结果上报
 * ------------------------------------------------------------------ */

export interface ReportAck {
  accepted: boolean;
  state?: string;
}

/**
 * 结果上报。
 *
 * 幂等键必须是**确定性**的：`report_result:<task>:<attempt>:<epoch>`
 * （A 端答复 §结果上报）。这样重复上报同一 attempt 会被服务端识别为同一操作，
 * 而用旧 epoch 上报会得到 `409 LEASE_EPOCH_STALE` —— 这是正确行为，
 * 说明该 attempt 已作废，不应伪装成功。
 */
export class HttpResultReporter {
  constructor(private readonly client: CoordinatorClient) {}

  async report(input: {
    task_id: string;
    attempt_id: string;
    lease_epoch: number;
    report: unknown;
  }): Promise<ReportAck> {
    const key = `report_result:${input.task_id}:${input.attempt_id}:${input.lease_epoch}`;
    const response = await this.client.request<{ accepted?: boolean; state?: string }>({
      method: "POST",
      path: `/tasks/${encodeURIComponent(input.task_id)}/attempts/${encodeURIComponent(
        input.attempt_id,
      )}/result`,
      body: {
        protocol_version: "1",
        executor_id: this.client.executorId,
        lease_epoch: input.lease_epoch,
        report: input.report,
      },
      idempotency_key: key,
      // 上报结果**不做盲目重试**：409/4xx 需人工判断。
      // 网络类错误可以重试，因为幂等键固定，重复不会产生副作用。
      retry: true,
    });
    return { accepted: response.accepted ?? true, state: response.state };
  }
}
