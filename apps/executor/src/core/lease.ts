/**
 * 租约：领取、独立续租、失效判定（第 7 节，验收 V08）。
 *
 * 核心安全语义（务必保持）：
 * - 每次领取得到新的 `attempt_id` 与**递增的** `lease_epoch`。
 * - 续租请求必须携带当前 epoch；服务端 epoch 更高则说明本执行器已被顶替，
 *   必须**立即停止子进程**，且此后不得再推送或上报。
 * - 「独立续租」指续租不依赖主任务循环；agent 跑长命令时主循环可能被阻塞，
 *   续租仍须按时发生，否则租约会在任务进行中悄悄过期。
 */

import type { Lease } from "@dac/protocol";

/** 服务端返回的续租结果。 */
export type RenewOutcome =
  /** 续租成功，返回新的到期时间与服务端 epoch */
  | { kind: "renewed"; expires_at: string; lease_epoch: number }
  /** 本执行器不再持有租约（被顶替或已过期），必须停止 */
  | { kind: "lost"; reason: "lease_epoch_stale" | "lease_expired" | "not_lease_holder" };

/** 与协调器通信的最小接口。由具体 HTTP 客户端实现，便于测试注入。 */
export interface LeaseTransport {
  renew(task_id: string, attempt_id: string, lease_epoch: number): Promise<RenewOutcome>;
}

export interface LeaseClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: LeaseClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface LeaseGuardOptions {
  /** 心跳/续租间隔毫秒数，取自 DEFAULT_TIMING.heartbeatIntervalMs */
  heartbeat_interval_ms: number;
  /** 续租失败后的重试次数上限（网络抖动容忍） */
  max_renew_failures?: number;
  clock?: LeaseClock;
  /** 租约丢失时的回调，用于立即停止子进程 */
  onLeaseLost?: (reason: string) => void;
  /** 续租异常（网络问题）时的回调，不改变持有状态 */
  onRenewError?: (error: unknown) => void;
}

const DEFAULT_MAX_RENEW_FAILURES = 2;

/**
 * 租约守卫：在后台按固定间隔续租，直到任务结束或租约丢失。
 *
 * 它是「独立」的：调用方拿到守卫后就去跑 agent，无需在任务循环里手动续租。
 */
export class LeaseGuard {
  private readonly lease: Lease;
  private readonly transport: LeaseTransport;
  private readonly clock: LeaseClock;
  private readonly interval: number;
  private readonly maxFailures: number;
  private readonly onLeaseLost?: ((reason: string) => void) | undefined;
  private readonly onRenewError?: ((error: unknown) => void) | undefined;

  private currentEpoch: number;
  private expiresAt: string;
  private failures = 0;
  private stopped = false;
  private lostReason: string | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(lease: Lease, transport: LeaseTransport, options: LeaseGuardOptions) {
    this.lease = lease;
    this.transport = transport;
    this.clock = options.clock ?? systemClock;
    this.interval = options.heartbeat_interval_ms;
    this.maxFailures = options.max_renew_failures ?? DEFAULT_MAX_RENEW_FAILURES;
    this.onLeaseLost = options.onLeaseLost;
    this.onRenewError = options.onRenewError;
    this.currentEpoch = lease.lease_epoch;
    this.expiresAt = lease.expires_at;
  }

  /** 当前持有中的 epoch。上报时必须用它，不能用领取时的旧值。 */
  get lease_epoch(): number {
    return this.currentEpoch;
  }

  /** 当前已知的到期时间（ISO 8601）。 */
  get expires_at(): string {
    return this.expiresAt;
  }

  /** 是否已丢失租约。为 true 时不得再推送或上报。 */
  get lost(): boolean {
    return this.lostReason !== null;
  }

  get lost_reason(): string | null {
    return this.lostReason;
  }

  /** 启动后台续租循环。重复调用返回同一个 promise。 */
  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.loopPromise = this.loop();
    return this.loopPromise;
  }

  /** 主动停止续租（任务正常结束时调用）。 */
  stop(): void {
    this.stopped = true;
  }

  /**
   * 续租一次。返回是否仍持有租约。
   * 公开出来是为了让测试和「开工前确认」这类短路径可以同步调用。
   */
  async renewOnce(): Promise<boolean> {
    if (this.stopped || this.lostReason) return false;
    try {
      const outcome = await this.transport.renew(
        this.lease.task_id,
        this.lease.attempt_id,
        this.currentEpoch,
      );
      if (outcome.kind === "renewed") {
        this.currentEpoch = outcome.lease_epoch;
        this.expiresAt = outcome.expires_at;
        this.failures = 0;
        return true;
      }
      this.markLost(outcome.reason);
      return false;
    } catch (error) {
      // 网络异常不等于租约丢失：服务端可能仍认我们持有。
      // 只有连续失败超过阈值才判定丢失，避免抖动导致误停任务。
      this.failures += 1;
      this.onRenewError?.(error);
      if (this.failures >= this.maxFailures) {
        this.markLost("lease_expired");
        return false;
      }
      return true;
    }
  }

  private markLost(reason: string): void {
    if (this.lostReason) return;
    this.lostReason = reason;
    this.onLeaseLost?.(reason);
  }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.lostReason) {
      await this.clock.sleep(this.interval);
      if (this.stopped) break;
      const stillHeld = await this.renewOnce();
      if (!stillHeld) break;
    }
  }
}

/**
 * 领取前的本地预检：租约还有多久到期？
 *
 * 用途：拿到租约后若剩余时间不足以覆盖「准备 worktree + 启动 agent」，
 * 应放弃本次领取让服务端重派，而不是开工后中途失效。
 */
export function remainingLeaseMs(lease: Lease, now: number = Date.now()): number {
  const expires = Date.parse(lease.expires_at);
  if (Number.isNaN(expires)) {
    throw new Error(`租约到期时间不是合法 ISO 8601：${lease.expires_at}`);
  }
  return expires - now;
}

/** 租约是否已过期（按本地时钟判断，仅作预检；最终以服务端为准）。 */
export function isLeaseExpired(lease: Lease, now: number = Date.now()): boolean {
  return remainingLeaseMs(lease, now) <= 0;
}
