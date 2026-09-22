/**
 * 把 `CoordinatorClient` 适配为内核所需的三个传输接口。
 *
 * 内核（lease/heartbeat/recovery）只依赖窄接口，不认识 HTTP，
 * 这样单测可以用纯内存假体驱动（见 `tests/executor/lease-recovery.test.ts`）。
 * 本文件是**唯一的 HTTP 与内核的交界处**，契约细节都集中在这里。
 *
 * 契约来源：`docs/B-to-A-interface-answers-v1.md`。
 */

import type {
  AgentKind,
  ExecutorRegistration,
  Lease,
  ResultReport,
  TaskNode,
} from "@dac/protocol";
import type { LeaseTransport, RenewOutcome } from "../core/lease.js";
import type { HeartbeatTransport, HeartbeatRequest } from "../core/heartbeat.js";
import type { OwnershipQuery, RecoveryTransport, TaskOwnership } from "../core/recovery.js";
import { CoordinatorClient, CoordinatorHttpError, defaultIdempotencyKey } from "./http.js";

/* ------------------------------------------------------------------ *
 * 租约
 * ------------------------------------------------------------------ */

/**
 * 从「可能带信封」的应答里取出承载租约字段的那个对象。
 *
 * 关键事实：服务端 `renewLease` 返回的是**裸租约对象**
 * （`apps/coordinator/src/project-do.ts` 末尾 `return jsonResponse(lease)`），
 * 并不是 `{ lease: { ... } }`。而 `leaseTask` 才是 `{ task, lease }` 包装。
 * 两种形状都接受 —— 响应信封不属于冻结协议，A 端将来包一层仍能工作。
 *
 * 此前只认包装形状，导致**真实续租**被判为「应答不完整」并抛
 * `RESULT_SCHEMA_INVALID`，等于每次续租都失败 → 租约必然在任务中途过期，
 * 直接危及 V08。该缺陷在纯假体测试里看不出来（假体恰好喂的是包装形状）。
 */
function pickLeasePayload(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const nested = obj["lease"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return obj;
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
      const response = await this.client.request<unknown>({
        method: "POST",
        path: `/tasks/${encodeURIComponent(task_id)}/lease/renew`,
        body,
        // 重试沿用同一幂等键：重复续租不应产生第二次 epoch 递增
        idempotency_key: defaultIdempotencyKey(
          `renew_lease:${task_id}:${attempt_id}:${lease_epoch}`,
        ),
      });

      const lease = pickLeasePayload(response);
      const nextEpoch = lease?.["lease_epoch"];
      const expiresAt = lease?.["expires_at"];

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

/**
 * 协调器归属应答（A 端答复 §4）。
 *
 * 服务端把租约字段**平铺在顶层**（`project-do.ts` 的 `queryOwnership`
 * 直接返回 `{ ownership, task_id, attempt_id, executor_id, lease_epoch, expires_at }`），
 * 并没有嵌套的 `lease`。`lease` 字段仅为兼容信封形状而保留。
 */
interface OwnershipResponse {
  ownership?: string;
  reason?: string;
  task_id?: string;
  executor_id?: string;
  to_executor?: string | null;
  attempt_id?: string | null;
  lease_epoch?: number | null;
  expires_at?: string;
  lease?: Record<string, unknown>;
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
        // 归属查询是纯读操作，服务端 `OwnershipQuerySchema` 也**不含**
        // `idempotency_key`（`project-do.ts` 的 `queryOwnership` 不做幂等记录）。
        // 因此不发送该字段——发送 schema 之外的字段只会增加噪音。
        // 重试仍由 `request()` 按错误分类处理：读操作重试本身是安全的。
      });

      switch (response.ownership) {
        case "still_mine": {
          // 租约字段在顶层（服务端实现），信封形状也接受。
          const src = (response.lease ?? (response as Record<string, unknown>)) as Record<
            string,
            unknown
          >;
          const expiresAt = src["expires_at"];
          const epoch = src["lease_epoch"];
          if (typeof expiresAt !== "string" || typeof epoch !== "number") {
            return {
              kind: "unreachable",
              error: "归属应答为 still_mine 但缺少 expires_at / lease_epoch",
            };
          }
          // 服务端只回这五项；缺项时用查询参数兜底（二者本就应当相等，
          // 因为服务端只在完整匹配时才返回 still_mine）。
          return {
            kind: "still_mine",
            lease: {
              task_id: typeof src["task_id"] === "string" ? src["task_id"] : query.task_id,
              attempt_id:
                typeof src["attempt_id"] === "string" ? src["attempt_id"] : query.attempt_id,
              executor_id:
                typeof src["executor_id"] === "string" ? src["executor_id"] : query.executor_id,
              lease_epoch: epoch,
              expires_at: expiresAt,
            },
          };
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
 * 结果上报的窄接口。常驻入口只依赖它，便于注入假体测试。
 */
export interface ResultReporter {
  report(report: ResultReport): Promise<ReportAck>;
}

/**
 * 结果上报。
 *
 * ## 请求体就是协议 `ResultReport` 本身
 * 服务端 `reportResult` 直接对整个请求体做 `ResultReportSchema` 解析，
 * 并且路由层会核对**路径中的 task_id / attempt_id 与请求体一致**
 * （`worker.ts` 的 `pathClaimsMatch`）。因此 body 必须是平铺的报告对象，
 * 不能再套 `{ report: ... }` 之类的自定义信封。
 *
 * 此前发送的是 `{ protocol_version, executor_id, lease_epoch, report }`：
 * 既缺 `task_id / attempt_id / status / base_sha / reported_at` 等必填项，
 * 路径标识也与体内对不上，会被服务端判为 400 —— 结果**永远报不出去**。
 *
 * ## 幂等键
 * 由**服务端**按 `report_result:<task>:<attempt>:<epoch>` 自行计算
 * （`project-do.ts`），客户端不再另传键。用旧 epoch 重报会得到 409
 * `LEASE_EPOCH_STALE` —— 这是正确行为，说明该 attempt 已作废，
 * 不应伪装成成功。
 */
export class HttpResultReporter implements ResultReporter {
  constructor(private readonly client: CoordinatorClient) {}

  async report(report: ResultReport): Promise<ReportAck> {
    const response = await this.client.request<{
      accepted?: boolean;
      task_id?: string;
      status?: string;
    }>({
      method: "POST",
      path: `/tasks/${encodeURIComponent(report.task_id)}/attempts/${encodeURIComponent(
        report.attempt_id,
      )}/result`,
      body: report,
      // 上报结果不盲目重试 4xx；网络类错误由 request() 按分类决定。
      retry: true,
    });
    return {
      accepted: response.accepted ?? true,
      ...(response.status !== undefined ? { state: response.status } : {}),
    };
  }
}

/* ------------------------------------------------------------------ *
 * 执行器注册与任务领取
 * ------------------------------------------------------------------ */

/** 注册应答。 */
export interface RegistrationAck {
  executor_id: string;
  registered: boolean;
}

export interface RegistrationTransport {
  register(registration: ExecutorRegistration): Promise<RegistrationAck>;
}

/**
 * 执行器注册。
 *
 * 路由 `POST /v1/projects/<project_id>/executors/register`，
 * 请求体为协议 `ExecutorRegistrationSchema`。
 * 幂等键由**服务端**按 `register_executor:<executor_id>` 计算，客户端不传。
 *
 * 身份核对：路由层会比对 Bearer 身份与 `executor_id`，不一致返回
 * `403 EXECUTOR_IDENTITY_MISMATCH` —— 常驻入口据此判定「身份不匹配」。
 */
export class HttpRegistrationTransport implements RegistrationTransport {
  constructor(private readonly client: CoordinatorClient) {}

  async register(registration: ExecutorRegistration): Promise<RegistrationAck> {
    const response = await this.client.request<{ executor_id?: string; registered?: boolean }>({
      method: "POST",
      path: "/executors/register",
      body: registration,
      // 注册是幂等的（服务端自算键），允许重试网络类错误
      retry: true,
    });
    return {
      executor_id: response.executor_id ?? registration.executor_id,
      registered: response.registered ?? false,
    };
  }
}

/** 领取请求（不含 idempotency_key，由领取器统一生成以保证「同一次重试复用」）。 */
export interface LeaseAcquisitionRequest {
  executor_id: string;
  agent_kind: AgentKind;
  capabilities: readonly string[];
}

export type LeaseAcquisition =
  /** 领到任务：`task` 为该任务的公开视图，`lease` 为服务端分配的租约 */
  | { kind: "leased"; task: TaskNode; lease: Lease }
  /**
   * 队列为空。**不是故障** —— 服务端明确返回
   * `{ task: null, lease: null, status: "empty" }`（HTTP 200）。
   */
  | { kind: "empty" };

export interface LeaseAcquirer {
  acquire(request: LeaseAcquisitionRequest): Promise<LeaseAcquisition>;
}

/**
 * 任务领取。
 *
 * ## 幂等键语义（务必保持）
 * 键在**一次领取调用内**生成一次，并在该次调用的所有网络重试中复用 ——
 * 这正是「重试不会产生第二个租约」的依据（验收 V02）。
 *
 * 但**每次轮询必须换新键**：服务端会按 `lease_task:<key>` 缓存应答，
 * 若用同一个键反复轮询，会永远拿到首次缓存的 `empty` 而再也领不到任务。
 * 因此键里带一个单调递增的序号与时间戳。
 */
export class HttpLeaseAcquirer implements LeaseAcquirer {
  private seq = 0;

  constructor(
    private readonly client: CoordinatorClient,
    private readonly makeKey: (request: LeaseAcquisitionRequest) => string = (request) => {
      this.seq += 1;
      return `lease_task:${request.executor_id}:${this.seq}:${Date.now()}`;
    },
  ) {}

  async acquire(request: LeaseAcquisitionRequest): Promise<LeaseAcquisition> {
    const idempotencyKey = this.makeKey(request);
    const response = await this.client.request<{ task?: unknown; lease?: unknown; status?: string }>(
      {
        method: "POST",
        path: "/tasks/lease",
        body: {
          protocol_version: "1",
          executor_id: request.executor_id,
          agent_kind: request.agent_kind,
          capabilities: [...request.capabilities],
          idempotency_key: idempotencyKey,
        },
        idempotency_key: idempotencyKey,
      },
    );

    const task = response.task ?? null;
    const lease = response.lease ?? null;

    if (task === null || lease === null) {
      // 服务端用 `{task: null, lease: null, status: "empty"}` 表示空队列。
      // 这里是**正常路径**，不抛错、不当作故障。
      return { kind: "empty" };
    }

    return {
      kind: "leased",
      task: task as TaskNode,
      lease: lease as Lease,
    };
  }
}
