/**
 * 心跳（第 8 节步骤 5）。
 *
 * 心跳与续租职责不同：
 * - **续租**决定「谁有权继续做」（写入 lease_epoch 语义）。
 * - **心跳**只上报「我还在跑、当前进度如何」，供协调器观测，不改变持有权。
 *
 * 因此心跳失败**不得**判定租约丢失——那是 LeaseGuard 的职责。
 * 混在一起会导致网络抖动时任务被误停。
 */

import type { LeaseClock } from "./lease.js";
import { systemClock } from "./lease.js";

/** 执行阶段，用于让协调器判断卡在哪一步（第 8 节步骤对应）。 */
export type ExecutorPhase =
  | "preparing_worktree"
  | "loading_context"
  | "running_agent"
  | "checking_diff"
  | "running_tests"
  | "committing"
  | "pushing"
  | "reporting";

export interface HeartbeatPayload {
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  phase: ExecutorPhase;
  /** 自由文本进度说明，不得含敏感信息 */
  detail?: string;
  /** agent 已运行毫秒数，便于判断是否接近超时 */
  elapsed_ms: number;
}

export interface HeartbeatTransport {
  send(payload: HeartbeatPayload): Promise<void>;
}

export interface HeartbeatOptions {
  heartbeat_interval_ms: number;
  clock?: LeaseClock;
  onError?: (error: unknown) => void;
}

/**
 * 心跳上报器。与 LeaseGuard 一样是后台独立循环，
 * 但失败只记录、不影响任务继续。
 */
export class Heartbeat {
  private readonly transport: HeartbeatTransport;
  private readonly clock: LeaseClock;
  private readonly interval: number;
  private readonly onError?: ((error: unknown) => void) | undefined;

  private taskId: string;
  private attemptId: string;
  private epoch: number;
  private phase: ExecutorPhase = "preparing_worktree";
  private detail: string | undefined;
  private startedAt = 0;
  private stopped = true;
  private loopPromise: Promise<void> | null = null;

  constructor(
    target: { task_id: string; attempt_id: string; lease_epoch: number },
    transport: HeartbeatTransport,
    options: HeartbeatOptions,
  ) {
    this.taskId = target.task_id;
    this.attemptId = target.attempt_id;
    this.epoch = target.lease_epoch;
    this.transport = transport;
    this.clock = options.clock ?? systemClock;
    this.interval = options.heartbeat_interval_ms;
    this.onError = options.onError;
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

  /** 更新当前阶段与说明。下一次心跳会带上新值。 */
  setPhase(phase: ExecutorPhase, detail?: string): void {
    this.phase = phase;
    this.detail = detail;
  }

  /** 同步更新 epoch（续租成功后应调用，否则上报的 epoch 会过期）。 */
  setLeaseEpoch(epoch: number): void {
    this.epoch = epoch;
  }

  /** 立即上报一次，不等待间隔。 */
  async beat(): Promise<void> {
    const payload: HeartbeatPayload = {
      task_id: this.taskId,
      attempt_id: this.attemptId,
      lease_epoch: this.epoch,
      phase: this.phase,
      elapsed_ms: this.clock.now() - this.startedAt,
    };
    if (this.detail !== undefined) payload.detail = this.detail;
    try {
      await this.transport.send(payload);
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
