import { z } from "zod";
import {
  EventEnvelopeSchema,
  ExecutorRegistrationSchema,
  IntegrationBatchSchema,
  LeaseSchema,
  ResultReportSchema,
  TaskGraphSchema,
} from "@dac/protocol";

export const LeaseRequestSchema = z.object({
  protocol_version: z.literal("1"),
  executor_id: z.string().min(1),
  agent_kind: z.enum(["codex", "opencode", "mock"]),
  capabilities: z.array(z.string().min(1)).min(1),
  idempotency_key: z.string().min(1).max(200),
});

export const RenewLeaseRequestSchema = z.object({
  protocol_version: z.literal("1"),
  task_id: z.string().min(1),
  attempt_id: z.string().min(1),
  executor_id: z.string().min(1),
  lease_epoch: z.number().int().min(1),
  idempotency_key: z.string().min(1).max(200),
});

export const ExecutorHeartbeatRequestSchema = z
  .object({
    protocol_version: z.literal("1"),
    executor_id: z.string().min(1),
    state: z.enum(["idle", "running", "stopping"]),
    task_id: z.string().min(1).nullable().default(null),
    attempt_id: z.string().min(1).nullable().default(null),
    lease_epoch: z.number().int().min(1).nullable().default(null),
    sent_at: z.string().datetime({ offset: true }),
    idempotency_key: z.string().min(1).max(200),
  })
  .superRefine((heartbeat, ctx) => {
    const leaseFields = [heartbeat.task_id, heartbeat.attempt_id, heartbeat.lease_epoch];
    const present = leaseFields.filter((value) => value !== null).length;
    if (present !== 0 && present !== leaseFields.length) {
      ctx.addIssue({
        code: "custom",
        path: ["task_id"],
        message: "task_id、attempt_id、lease_epoch 必须同时提供或同时为空",
      });
    }
    if (heartbeat.state === "running" && present !== leaseFields.length) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "running 心跳必须绑定完整租约",
      });
    }
  });

export const OwnershipQuerySchema = z.object({
  task_id: z.string().min(1),
  attempt_id: z.string().min(1),
  executor_id: z.string().min(1),
  lease_epoch: z.coerce.number().int().min(1),
});

export const ContractProposalSchema = z.object({
  proposal_id: z.string().regex(/^CP-[0-9]{4,}$/),
  title: z.string().min(1).max(200),
  content_ref: z.string().min(1).max(512),
  target_version: z.string().regex(/^v[0-9]+(\.[0-9]+)*$/),
  impact_task_ids: z.array(z.string().min(1)).default([]),
  idempotency_key: z.string().min(1).max(200),
});

export const RequestSchemas = {
  executorRegistration: ExecutorRegistrationSchema,
  taskGraph: TaskGraphSchema,
  lease: LeaseRequestSchema,
  renewLease: RenewLeaseRequestSchema,
  executorHeartbeat: ExecutorHeartbeatRequestSchema,
  ownershipQuery: OwnershipQuerySchema,
  resultReport: ResultReportSchema,
  integrationBatch: IntegrationBatchSchema,
  eventEnvelope: EventEnvelopeSchema,
  contractProposal: ContractProposalSchema,
} as const;

export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;
export type RenewLeaseRequest = z.infer<typeof RenewLeaseRequestSchema>;
export type ExecutorHeartbeatRequest = z.infer<typeof ExecutorHeartbeatRequestSchema>;
export type OwnershipQuery = z.infer<typeof OwnershipQuerySchema>;
export type ContractProposal = z.infer<typeof ContractProposalSchema>;

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function errorResponse(status: number, code: string, message: string, details?: unknown): Response {
  return jsonResponse({ error: { code, message, details: details ?? null } }, status);
}

export async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是有效 JSON");
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function requireIdempotencyScope(input: { idempotency_key: string }, scope: string): string {
  if (!input.idempotency_key.trim()) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", `${scope} 必须携带幂等键`);
  }
  return `${scope}:${input.idempotency_key}`;
}
