import { errorResponse, jsonResponse } from "./api.js";
import { ProjectDurableObject } from "./project-do.js";

export interface DurableObjectIdLike {}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

export interface CoordinatorEnv {
  PROJECTS: DurableObjectNamespaceLike;
  /** 管理 CLI 使用；不得交给执行器。 */
  COORDINATOR_API_TOKEN?: string;
  /** Cloudflare secret：JSON 对象，键为 executor_id，值为对应 Bearer token。 */
  COORDINATOR_EXECUTOR_TOKENS_JSON?: string;
}

type Principal = { kind: "admin" } | { kind: "executor"; executorId: string };

function authorize(request: Request, env: CoordinatorEnv): Principal | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (env.COORDINATOR_API_TOKEN && token === env.COORDINATOR_API_TOKEN) return { kind: "admin" };
  if (!env.COORDINATOR_EXECUTOR_TOKENS_JSON) return null;
  try {
    const tokens = JSON.parse(env.COORDINATOR_EXECUTOR_TOKENS_JSON) as Record<string, unknown>;
    for (const [executorId, candidate] of Object.entries(tokens)) {
      if (typeof candidate === "string" && candidate === token) return { kind: "executor", executorId };
    }
  } catch {
    return null;
  }
  return null;
}

async function claimedExecutorId(request: Request, action: string): Promise<string | null> {
  if (action === "query_ownership") return new URL(request.url).searchParams.get("executor_id");
  const executorActions = new Set([
    "register_executor",
    "lease_task",
    "renew_lease",
    "executor_heartbeat",
    "report_result",
  ]);
  if (!executorActions.has(action)) return null;
  try {
    const body = await request.clone().json() as { executor_id?: unknown };
    return typeof body.executor_id === "string" ? body.executor_id : null;
  } catch {
    return null;
  }
}

function route(pathname: string): { projectId: string; action: string } | null {
  const match = pathname.match(/^\/v1\/projects\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const projectIdPart = match[1];
  const routeName = match[2];
  if (!projectIdPart || !routeName) return null;
  const projectId = decodeURIComponent(projectIdPart);
  const actionMap: Record<string, string> = {
    "executors/register": "register_executor",
    "requirements/submit": "submit_requirement",
    "tasks/lease": "lease_task",
    "tasks/renew": "renew_lease",
    "executors/heartbeat": "executor_heartbeat",
    "tasks/ownership": "query_ownership",
    "tasks/report": "report_result",
    "contracts/proposals": "contract_proposal",
    "events/github": "github_event",
    "batches": "integration_batch",
    status: "status",
    context: "context",
  };
  const action = actionMap[routeName];
  return action ? { projectId, action } : null;
}

export function createCoordinatorWorker() {
  return {
    async fetch(request: Request, env: CoordinatorEnv): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ ok: true, service: "dual-agent-coordinator" });
      }
      const target = route(url.pathname);
      if (!target) return errorResponse(404, "NOT_FOUND", "未知协调器路由");
      const principal = authorize(request, env);
      if (!principal) return errorResponse(401, "AUTH_REQUIRED", "需要有效的 Bearer 认证");
      if (principal.kind === "executor") {
        const claimed = await claimedExecutorId(request, target.action);
        if (claimed !== null && claimed !== principal.executorId) {
          return errorResponse(403, "EXECUTOR_IDENTITY_MISMATCH", "Bearer 身份与 executor_id 不一致");
        }
      }
      const id = env.PROJECTS.idFromName(target.projectId);
      const stub = env.PROJECTS.get(id);
      const internalUrl = new URL(`/internal/${target.action}`, request.url);
      internalUrl.search = url.search;
      const internalRequest = new Request(internalUrl, request);
      return stub.fetch(internalRequest);
    },
  };
}

export { ProjectDurableObject };

const worker = createCoordinatorWorker();
export default worker;
