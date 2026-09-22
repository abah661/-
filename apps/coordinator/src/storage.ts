import type {
  EventEnvelope,
  ExecutorRegistration,
  IntegrationBatch,
  Lease,
  ResultReport,
  TaskGraph,
} from "@dac/protocol";
import type { ExecutorHeartbeatRequest } from "./api.js";

export interface StorageTransactionLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DurableObjectStorageLike extends StorageTransactionLike {
  transaction<T>(callback: (transaction: StorageTransactionLike) => Promise<T>): Promise<T>;
}

export interface DurableObjectIdLike {
  /** `idFromName(project_id)` 创建的实例会保留原始名称。 */
  readonly name?: string;
  toString(): string;
}

export interface DurableObjectStateLike {
  readonly id: DurableObjectIdLike;
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile?<T>(callback: () => Promise<T>): Promise<T>;
}

export interface ProjectState {
  project_id: string;
  graph: TaskGraph | null;
  executors: Record<string, ExecutorRegistration>;
  heartbeats: Record<string, ExecutorHeartbeatRequest & { received_at: string }>;
  leases: Record<string, Lease>;
  reports: Record<string, ResultReport>;
  batches: Record<string, IntegrationBatch>;
  events: EventEnvelope[];
  idempotency: Record<string, { fingerprint: string; response: unknown }>;
}

export function emptyProjectState(projectId: string): ProjectState {
  return {
    project_id: projectId,
    graph: null,
    executors: {},
    heartbeats: {},
    leases: {},
    reports: {},
    batches: {},
    events: [],
    idempotency: {},
  };
}

export async function loadProjectState(storage: StorageTransactionLike, projectId: string): Promise<ProjectState> {
  const state = await storage.get<ProjectState>("project_state");
  if (!state) return emptyProjectState(projectId);
  return {
    ...emptyProjectState(projectId),
    ...state,
    executors: state.executors ?? {},
    heartbeats: state.heartbeats ?? {},
    leases: state.leases ?? {},
    reports: state.reports ?? {},
    batches: state.batches ?? {},
    events: state.events ?? [],
    idempotency: state.idempotency ?? {},
  };
}

export function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}
