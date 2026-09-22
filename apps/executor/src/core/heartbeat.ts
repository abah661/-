/**
 * 心跳（第 8 节步骤 5；契约见 `docs/B-to-A-interface-answers-v1.md` §1 心跳）。
 *
 * ## 与续租的职责边界（务必保持）
 * - **续租**决定「谁有权继续做」（写入 `lease_epoch` 语义）。
 * - **心跳**只上报「我还在跑」，供协调器观测，**不改变持有权**。
 *
 * 因此心跳失败**不得**判定租约丢失——那是 LeaseGuard 的职责。
 * A 端也明确「心跳只记录存活状态，不代替续租」。
 *
 * ## 与 A 端契约的对齐（2026-09-22 按答复 v1 调整）
 * 服务端 `state` 取值为 `idle | running | stopping`，与 B 端原先自定义的
 * 细粒度 `ExecutorPhase` 不是同一层概念：
 * - `state` 是**服务端契约字段**，只有三个值，必须严格一致。
 * - `phase` 是 B 端**本地过程信息**，用于日志与诊断，不参与契约。
 *
 * 两者都保留：`state` 进请求体，`phase` 仅作为本地上下文随 `detail` 上报。
 * `running` 必须带完整租约三元组（task_id/attempt_id/lease_epoch）；
 * `idle` 时三项为 null。
 */

import type { LeaseClock } from "./lease.js";
import { systemClock } from "./lease.js";

/** 服务端契约字段。取值由 A 端答复 v1 固定，不得自行扩展。 */
export type HeartbeatState = "idle" | "running" | "stopping";

/** B 端本地过程阶段，仅用于诊断，不作为契约字段。 */
export type ExecutorPhase =
  | "preparing_worktree"
  | "loading_context"
  | "running_agent"
  | "checking_diff"
  | "running_tests"
  | "committing"
  | "pushing"
  | "reporting";

/** 租约三元组。`running` 必填，`idle` 为 null。 */
export interface HeartbeatLeaseTriple {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
}

/**
 * 心跳请求体。字段与 A 端答复 §1 心跳一一对应。
 *
 * 注意 `sent_at` 是**客户端时间**，服务端只用于观测；
 * 权威时间始终以服务端的 `expires_at` 为准。
 */
export interface HeartbeatRequest {
  protocol_version: "1";
  executor_id: string;
  state: HeartbeatState;
  task_id: string | null;
  attempt_id: string | null;
  lease_epoch: number | null;
  sent_at: string;
  idempotency_key: string;
  /** 本地过程信息，可选。不得含敏感信息。 */
  detail?: string;
  /** agent 已运行毫秒数，可选。 */
  elapsed_ms?: number;
}

export interface HeartbeatTransport {
  send(request: HeartbeatRequest): Promise<void>;
}

export interface HeartbeatOptions {
  heartbeat_interval_ms: number;
  clock?: LeaseClock;
  onError?: (error: unknown) => void;
  /** 幂等键生成器，便于测试注入确定性实现 */
  makeIdempotencyKey?: () => string;
}

let heartbeatSeq = 0;

/**
 * 默认幂等键：`heartbeat:<executor>:<序号>:<时间戳>`。
 *
 * 服务端按 `executor_heartbeat` scope 记录（CP-0001 §4）。
 * 心跳是**高频**请求，键必须每次不同，否则会被服务端判为重复而不再记录，
 * 导致协调器误判执行器失联。
 */
function defaultIdempotencyKey(executorId: string): string {
  heartbeatSeq += 1;
  return `heartbeat:${executorId}:${heartbeatSeq}:${Date.now()}`;
}

/**
 * 心跳上报器：后台独立循环，失败只记录、不影响任务继续。
 */
export class Heartbeat {
  private readonly transport: HeartbeatTransport;
  private readonly clock: LeaseClock;
  private readonly interval: number;
  private readonly executorId: string;
  private readonly onError?: ((error: unknown) => void) | undefined;
  private readonly makeKey: () => string;

  private triple: HeartbeatLeaseTriple | null = null;
  private state: HeartbeatState = "idle";
  private phase: ExecutorPhase | null = null;
  private detail: string | undefined;
  private startedAt = 0;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;

  constructor(
    executorId: string,
    transport: HeartbeatTransport,
    options: HeartbeatOptions,
  ) {
    this.executorId = executorId;
    this.transport = transport;
    this.clock = options.clock ?? systemClock;
    this.interval = options.heartbeat_interval_ms;
    this.onError = options.onError;
    this.makeKey = options.makeIdempotencyKey ?? (() => defaultIdempotencyKey(this.executorId));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.clock.now();
    this.loopPromise = this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  /** 进入 `running`：必须提供完整租约三元组（服务端会校验）。 */
  markRunning(triple: HeartbeatLeaseTriple): void {
    this.triple = { ...triple };
    this.state = "running";
  }

  /** 进入 `stopping`。仍带租约（正在收尾），租约字段保持原值。 */
  markStopping(): void {
    this.state = "stopping";
  }

  /** 进入 `idle` 并清空租约三元组。 */
  markIdle(): void {
    this.state = "idle";
    this.triple = null;
    this.phase = null;
    this.detail = undefined;
  }

  /** 更新本地过程阶段与说明（不改变 state，仅随请求附带）。 */
  setPhase(phase: ExecutorPhase, detail?: string): void {
    this.phase = phase;
    this.detail = detail;
  }

  /** 同步更新 epoch（续租成功后应调用，否则上报的 epoch 会过期）。 */
  setLeaseEpoch(epoch: number): void {
    if (this.triple) this.triple.lease_epoch = epoch;
  }

  /** 构造一次请求体。`running`/`stopping` 必带三元组。 */
  buildRequest(): HeartbeatRequest {
    const request: HeartbeatRequest = {
      protocol_version: "1",
      executor_id: this.executorId,
      state: this.state,
      task_id: this.triple?.task_id ?? null,
      attempt_id: this.triple?.attempt_id ?? null,
      lease_epoch: this.triple?.lease_epoch ?? null,
      sent_at: new Date(this.clock.now()).toISOString(),
      idempotency_key: this.makeKey(),
    };
    if (this.detail !== undefined) request.detail = this.detail;
    if (!this.stopped && this.startedAt > 0) {
      request.elapsed_ms = this.clock.now() - this.startedAt;
    }
    return request;
  }

  /** 立即上报一次，不等待间隔。 */
  async beat(): Promise<void> {
    try {
      await this.transport.send(this.buildRequest());
    } catch (error) {
      // 心跳失败不改变任务状态，仅记录。
      this.onError?.(error);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.clock.sleep(this.interval);
      if (this.stopped) break;
      await this.beat();
    }
  }
}

/**
 * 校验 `running`/`stopping` 的心跳必须带完整三元组。
 *
 * 抽成独立函数是因为服务端也会做同样校验（CP-0001 验收项：
 * 「running 心跳必须携带完整租约三元组」）。客户端提前自检可以
 * 在发请求前就发现问题，而不是等一个 400。
 */
export function validateHeartbeat(request: HeartbeatRequest): string | null {
  if (request.state === "idle") {
    if (request.task_id !== null || request.attempt_id !== null || request.lease_epoch !== null) {
      return "idle 心跳的 task_id/attempt_id/lease_epoch 必须为 null";
    }
    return null;
  }
  // running / stopping
  if (request.task_id === null || request.attempt_id === null || request.lease_epoch === null) {
    return `${request.state} 心跳必须携带完整的 task_id/attempt_id/lease_epoch`;
  }
  if (!Number.isInteger(request.lease_epoch) || request.lease_epoch < 1) {
    return `lease_epoch 必须是 >= 1 的整数，收到：${request.lease_epoch}`;
  }
  return null;
}
