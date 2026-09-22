/**
 * 协调器 HTTP 客户端（契约见 `docs/B-to-A-interface-answers-v1.md`）。
 *
 * ## 统一规则（A 端答复 §统一规则）
 * - 基址 `<COORDINATOR_BASE_URL>`，项目路由 `/v1/projects/<project_id>/...`
 * - 除 `GET /health` 外一律 `Authorization: Bearer <token>`
 * - token 从环境变量 `COORDINATOR_API_TOKEN` 读取，
 *   **不写配置文件、不进日志、不进仓库**（规则 5）
 * - 写请求的 `idempotency_key` 放在 JSON 体内；`scope` 由服务端按路由固定添加
 * - `protocol_version` 固定为字符串 `"1"`
 *
 * ## 凭据处理（红线）
 * 本模块**不**打印、不序列化、不缓存 token。错误信息中若可能携带请求头，
 * 一律先经过 `redactSecrets`。日志只输出方法与路径。
 *
 * ## 重试规则（A 端答复 §4 重试规则）
 * | 情形 | 处置 |
 * | --- | --- |
 * | 网络错误 / 429 / 502 / 503 / 504 | 指数退避 + 抖动；`Retry-After` 优先 |
 * | 401 / 403 | 停止业务操作 → `blocked_auth`，**不得按代码失败返修** |
 * | 409 租约类 | **不重试**，立即停子进程并查询归属 |
 * | 400 / 422 | 请求或契约错误，不做盲目重试 |
 */

import type { ErrorCode } from "@dac/protocol";

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * HTTP 层错误。`code` 使用协议错误码，使上层能直接用 `ERROR_POLICY`
 * 判定阻塞/返修（第 13 节：分类纪律）。
 */
export class CoordinatorHttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retry_after_ms: number | null;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status: number | null;
    retryable: boolean;
    retry_after_ms?: number | null;
  }) {
    super(init.message);
    this.name = "CoordinatorHttpError";
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable;
    this.retry_after_ms = init.retry_after_ms ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/** 执行器运行时配置。全部来自环境变量，不落盘。 */
export interface ExecutorConfig {
  /** `<COORDINATOR_BASE_URL>`，例如 https://xxx.workers.dev */
  base_url: string;
  project_id: string;
  executor_id: string;
  /** Bearer token。**只存在于内存**，不写日志、不落盘。 */
  token: string;
  /** 单请求超时毫秒数 */
  request_timeout_ms?: number;
  /** 默认最大重试次数（仅对可重试错误生效） */
  max_retries?: number;
}

export class MissingConfigError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `缺少必需的环境变量：${missing.join(", ")}。` +
        `请在本机设置后重启执行器（token 不得写入仓库或配置文件）。`,
    );
    this.name = "MissingConfigError";
  }
}

/**
 * 从环境变量装配配置。
 *
 * 刻意**不提供任何默认 token 或占位值**——缺了就抛错，
 * 避免出现「用一个空 token 去请求然后收到 401」这种把配置问题
 * 伪装成认证问题的情况（本项目已踩过把 provider 配错当成密钥过期的坑）。
 */
export function loadExecutorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExecutorConfig {
  const missing: string[] = [];
  const baseUrl = env["COORDINATOR_BASE_URL"]?.trim();
  const projectId = env["PROJECT_ID"]?.trim();
  const executorId = env["EXECUTOR_ID"]?.trim();
  const token = env["COORDINATOR_API_TOKEN"]?.trim();

  if (!baseUrl) missing.push("COORDINATOR_BASE_URL");
  if (!projectId) missing.push("PROJECT_ID");
  if (!executorId) missing.push("EXECUTOR_ID");
  if (!token) missing.push("COORDINATOR_API_TOKEN");

  if (missing.length > 0) throw new MissingConfigError(missing);

  return {
    base_url: baseUrl!.replace(/\/+$/, ""),
    project_id: projectId!,
    executor_id: executorId!,
    token: token!,
  };
}

/**
 * 抹掉文本中可能出现的 token。
 *
 * 用途：任何可能被写入日志或错误信息的字符串都要先过这里。
 * 宁可过度屏蔽，也不让凭据进日志（规则 5）。
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    // 整体替换 + 前后各保留 2 字符以便识别是哪个凭据，但不足以还原
    out = out.split(secret).join("[REDACTED]");
  }
  // 兜底：Authorization 头与常见 token 形态
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return out;
}

/* ------------------------------------------------------------------ *
 * 幂等键
 * ------------------------------------------------------------------ */

/**
 * 幂等键生成。
 *
 * 关键语义：**同一逻辑操作重试必须复用同一个键**，否则服务端会当成新操作，
 * 从而绕过幂等保护（例如重复领取产生两个租约）。
 * 因此调用方应先生成键，再交给 `request` —— 重试在同一 `request` 内完成，
 * 键不变。
 */
export interface IdempotencyKeyFactory {
  (operation: string): string;
}

let idempotencySeq = 0;

export function defaultIdempotencyKey(operation: string): string {
  idempotencySeq += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${operation}:${Date.now()}:${idempotencySeq}:${rand}`;
}

/* ------------------------------------------------------------------ *
 * 重试策略
 * ------------------------------------------------------------------ */

export interface RetryPolicy {
  max_retries: number;
  base_delay_ms: number;
  max_delay_ms: number;
  /** 抖动比例 0..1 */
  jitter_ratio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 3,
  base_delay_ms: 500,
  max_delay_ms: 15_000,
  jitter_ratio: 0.3,
};

/** 解析 `Retry-After`（秒数或 HTTP 日期）。 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

/** 指数退避 + 抖动。`attempt` 从 0 起。 */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  // Retry-After 优先，但仍受最大延迟约束，避免被异常值拖住
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, policy.max_delay_ms);
  }
  const exp = Math.min(policy.base_delay_ms * 2 ** attempt, policy.max_delay_ms);
  const jitter = exp * policy.jitter_ratio * (random() * 2 - 1);
  return Math.max(0, Math.round(exp + jitter));
}

/* ------------------------------------------------------------------ *
 * 响应分类
 * ------------------------------------------------------------------ */

export interface ClassifyResult {
  code: ErrorCode;
  retryable: boolean;
}

/**
 * 把 HTTP 状态映射为协议错误码与是否可重试。
 *
 * 分类依据 A 端答复 §4，并且刻意与协议 `ERROR_POLICY` 的处置保持一致：
 * `AUTH_EXPIRED` / `QUOTA_EXHAUSTED` 是 `blocked`（请求介入、**不计返修**），
 * `LEASE_*` / `RATE_LIMITED` 是 `retryable`（协调器重派），
 * `RESULT_SCHEMA_INVALID` 等是 `repairable` 或不可重试。
 */
export function classifyHttpStatus(status: number): ClassifyResult {
  if (status === 401 || status === 403) {
    return { code: "AUTH_EXPIRED", retryable: false };
  }
  if (status === 402) {
    return { code: "QUOTA_EXHAUSTED", retryable: false };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", retryable: true };
  }
  if (status === 409) {
    // 租约类冲突：不重试，调用方须停子进程并查询归属
    return { code: "LEASE_EPOCH_STALE", retryable: false };
  }
  if (status === 400 || status === 422) {
    return { code: "RESULT_SCHEMA_INVALID", retryable: false };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { code: "INTERNAL_ERROR", retryable: true };
  }
  if (status >= 500) {
    return { code: "INTERNAL_ERROR", retryable: true };
  }
  return { code: "INTERNAL_ERROR", retryable: false };
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

export interface HttpRequestSpec {
  method: "GET" | "POST";
  /** 相对路径，以 `/v1/projects/<project_id>` 开头 */
  path: string;
  /** JSON 请求体；GET 时忽略 */
  body?: unknown;
  /** 该次操作的幂等键。POST 时必填 */
  idempotency_key?: string;
  /** 是否允许重试。默认 true */
  retry?: boolean;
}

export interface HttpClientDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const systemSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 协调器 HTTP 客户端。
 *
 * 只做「按契约发请求 + 分类错误 + 重试」，不含业务语义。
 * 业务语义由 transport 适配层（lease/heartbeat/recovery）负责。
 */
export class CoordinatorClient {
  private readonly config: ExecutorConfig;
  private readonly policy: RetryPolicy;
  private readonly deps: Required<HttpClientDeps>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: ExecutorConfig, deps: HttpClientDeps = {}, policy?: Partial<RetryPolicy>) {
    this.config = config;
    this.policy = { ...DEFAULT_RETRY_POLICY, ...policy };
    this.deps = {
      fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: deps.sleep ?? systemSleep,
      random: deps.random ?? Math.random,
      now: deps.now ?? Date.now,
    };
    this.fetchImpl = this.deps.fetch;
  }

  /** 项目路由前缀。 */
  get projectBase(): string {
    return `${this.config.base_url}/v1/projects/${encodeURIComponent(this.config.project_id)}`;
  }

  get executorId(): string {
    return this.config.executor_id;
  }

  /**
   * 发起请求。返回解析后的 JSON。
   *
   * 重试在**本函数内部**完成，因此 `idempotency_key` 在整个重试过程中
   * 保持不变 —— 这正是幂等保护生效的前提。
   */
  async request<T = unknown>(spec: HttpRequestSpec): Promise<T> {
    const url = `${this.projectBase}${spec.path}`;
    const allowRetry = spec.retry !== false;
    const maxAttempts = allowRetry ? this.policy.max_retries + 1 : 1;

    // 幂等键**必须进请求体**：协调器的各写端点都从 body 读 `idempotency_key`
    // （`apps/coordinator/src/project-do.ts` 的 `requireIdempotencyScope`）。
    // 本模块文件头也早已写明「写请求的 idempotency_key 放在 JSON 体内」，
    // 但此前只在重试循环里使用了该字段、并未发送，导致续租/心跳/领取
    // 因缺少必填字段被服务端判为 400 RESULT_SCHEMA_INVALID。
    // 合并放在重试循环**之前**，因此整个重试过程复用同一个键 ——
    // 这正是幂等保护生效的前提。
    // 合并放在重试循环**之前**，因此整个重试过程复用同一个键 ——
    // 这正是幂等保护生效的前提。
    const canMerge =
      spec.body !== null &&
      typeof spec.body === "object" &&
      !Array.isArray(spec.body) &&
      spec.idempotency_key !== undefined;
    const payload =
      spec.body === undefined
        ? undefined
        : canMerge
          ? { ...(spec.body as Record<string, unknown>), idempotency_key: spec.idempotency_key }
          : spec.body;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const headers: Record<string, string> = {
      // 凭据只在此处进入请求头，不落日志
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let lastError: CoordinatorHttpError | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let status: number | null = null;
      let retryAfterMs: number | null = null;
      try {
        const controller = new AbortController();
        const timeoutMs = this.config.request_timeout_ms ?? 30_000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method: spec.method,
            headers,
            ...(body !== undefined ? { body } : {}),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        status = response.status;
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.deps.now());

        const text = await response.text();

        if (response.ok) {
          // 允许空响应体（如 204）
          if (!text.trim()) return undefined as T;
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new CoordinatorHttpError({
              code: "RESULT_SCHEMA_INVALID",
              message: `响应不是合法 JSON（HTTP ${status}，${spec.method} ${spec.path}）`,
              status,
              retryable: false,
            });
          }
        }

        const classified = classifyHttpStatus(status);
        throw new CoordinatorHttpError({
          code: classified.code,
          // 消息刻意不含响应体全文与请求头，避免凭据或敏感数据外泄
          message: `请求失败：HTTP ${status} ${spec.method} ${spec.path}`,
          status,
          retryable: classified.retryable,
          retry_after_ms: retryAfterMs,
        });
      } catch (error) {
        const normalized =
          error instanceof CoordinatorHttpError
            ? error
            : this.normalizeTransportError(error, spec, status);

        lastError = normalized;

        const isLast = attempt === maxAttempts - 1;
        if (!normalized.retryable || isLast) break;

        const delay = backoffDelay(attempt, this.policy, normalized.retry_after_ms, this.deps.random);
        await this.deps.sleep(delay);
      }
    }

    throw (
      lastError ??
      new CoordinatorHttpError({
        code: "INTERNAL_ERROR",
        message: `请求未产生结果：${spec.method} ${spec.path}`,
        status: null,
        retryable: false,
      })
    );
  }

  /** 把 fetch 抛出的异常（网络错误、超时）归一化为可分类的错误。 */
  private normalizeTransportError(
    error: unknown,
    spec: HttpRequestSpec,
    status: number | null,
  ): CoordinatorHttpError {
    if (status !== null) {
      // 已拿到状态码但后续处理出错 —— 按该状态的分类走
      const classified = classifyHttpStatus(status);
      return new CoordinatorHttpError({
        code: classified.code,
        message: `请求处理失败：HTTP ${status} ${spec.method} ${spec.path}`,
        status,
        retryable: classified.retryable,
      });
    }
    const raw = error instanceof Error ? error.message : String(error);
    const safe = redactSecrets(raw, [this.config.token]);
    const aborted = error instanceof Error && error.name === "AbortError";
    return new CoordinatorHttpError({
      // 网络错误与超时都归入可重试：服务端可能只是暂时不可达。
      // 注意这不等于「租约丢失」——租约判定由 LeaseGuard 依据服务端回答做。
      code: "INTERNAL_ERROR",
      message: `${aborted ? "请求超时" : "网络错误"}：${spec.method} ${spec.path}（${safe}）`,
      status: null,
      retryable: true,
    });
  }

  /** 健康检查。**不需要**认证。 */
  async health(): Promise<{ ok: boolean; raw: unknown }> {
    try {
      const response = await this.fetchImpl(`${this.config.base_url}/v1/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return { ok: false, raw: null };
      const text = await response.text();
      return { ok: true, raw: text.trim() ? JSON.parse(text) : null };
    } catch {
      return { ok: false, raw: null };
    }
  }
}
