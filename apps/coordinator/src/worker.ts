import { errorResponse, jsonResponse } from "./api.js";
import { ProjectDurableObject } from "./project-do.js";
import type { DurableObjectIdLike } from "./storage.js";

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
type RouteTarget = {
  projectId: string;
  action: string;
  pathClaims?: Record<string, string>;
};

function authorize(request: Request, env: CoordinatorEnv): Principal | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (!token.trim()) return null;
  if (env.COORDINATOR_API_TOKEN && token === env.COORDINATOR_API_TOKEN) return { kind: "admin" };
  if (!env.COORDINATOR_EXECUTOR_TOKENS_JSON) return null;
  try {
    const tokens = JSON.parse(env.COORDINATOR_EXECUTOR_TOKENS_JSON) as Record<string, unknown>;
    if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
    for (const [executorId, candidate] of Object.entries(tokens)) {
      if (typeof candidate === "string" && candidate === token) return { kind: "executor", executorId };
    }
  } catch {
    return null;
  }
  return null;
}

async function claimedExecutorId(request: Request, target: RouteTarget): Promise<string | null> {
  if (target.pathClaims?.executor_id) return target.pathClaims.executor_id;
  if (target.action === "query_ownership" && request.method === "GET") {
    return new URL(request.url).searchParams.get("executor_id");
  }
  const executorActions = new Set([
    "register_executor",
    "lease_task",
    "renew_lease",
    "executor_heartbeat",
    "query_ownership",
    "report_result",
  ]);
  if (!executorActions.has(target.action)) return null;
  try {
    const body = await request.clone().json() as { executor_id?: unknown };
    return body && typeof body.executor_id === "string" ? body.executor_id : null;
  } catch {
    return null;
  }
}

async function pathClaimsMatch(request: Request, target: RouteTarget): Promise<boolean> {
  if (!target.pathClaims) return true;
  if (request.method === "GET") {
    const query = new URL(request.url).searchParams;
    return Object.entries(target.pathClaims).every(([key, value]) => query.get(key) === value);
  }
  try {
    const body = await request.clone().json() as Record<string, unknown>;
    return !!body && Object.entries(target.pathClaims).every(([key, value]) => body[key] === value);
  } catch {
    return false;
  }
}

function route(pathname: string): RouteTarget | null {
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
  const action = Object.hasOwn(actionMap, routeName) ? actionMap[routeName] : undefined;
  if (action) return { projectId, action };
  const renew = routeName.match(/^tasks\/([^/]+)\/lease\/renew$/);
  if (renew?.[1]) return { projectId, action: "renew_lease", pathClaims: { task_id: decodeURIComponent(renew[1]) } };
  const heartbeat = routeName.match(/^executors\/([^/]+)\/heartbeat$/);
  if (heartbeat?.[1]) {
    return { projectId, action: "executor_heartbeat", pathClaims: { executor_id: decodeURIComponent(heartbeat[1]) } };
  }
  const ownership = routeName.match(/^tasks\/([^/]+)\/ownership$/);
  if (ownership?.[1]) {
    return { projectId, action: "query_ownership", pathClaims: { task_id: decodeURIComponent(ownership[1]) } };
  }
  const report = routeName.match(/^tasks\/([^/]+)\/attempts\/([^/]+)\/result$/);
  if (report?.[1] && report[2]) {
    return {
      projectId,
      action: "report_result",
      pathClaims: { task_id: decodeURIComponent(report[1]), attempt_id: decodeURIComponent(report[2]) },
    };
  }
  return null;
}

export function createCoordinatorWorker() {
  return {
    async fetch(request: Request, env: CoordinatorEnv): Promise<Response> {
      const url = new URL(request.url);
      if ((url.pathname === "/health" || url.pathname === "/v1/health") && request.method === "GET") {
        return jsonResponse({ ok: true, service: "dual-agent-coordinator" });
      }
      let target: RouteTarget | null;
      try {
        target = route(url.pathname);
      } catch {
        return errorResponse(400, "INVALID_PATH", "路径编码无效");
      }
      if (!target) return errorResponse(404, "NOT_FOUND", "未知协调器路由");
      if (target.projectId.length > 64 || /[\x00-\x1f/\\]/.test(target.projectId)) {
        return errorResponse(400, "INVALID_PATH", "project_id 无效");
      }
      const principal = authorize(request, env);
      if (!principal) return errorResponse(401, "AUTH_REQUIRED", "需要有效的 Bearer 认证");
      if (principal.kind === "executor" && ["submit_requirement", "github_event", "integration_batch"].includes(target.action)) {
        return errorResponse(403, "UNAUTHORIZED_OPERATION", "此操作需要管理身份");
      }
      if (!(await pathClaimsMatch(request, target))) {
        return errorResponse(409, "CONTRACT_MISMATCH", "路径标识与请求体不一致");
      }
      if (principal.kind === "executor") {
        const claimed = await claimedExecutorId(request, target);
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
