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
  COORDINATOR_API_TOKEN?: string;
}

function authorized(request: Request, env: CoordinatorEnv): boolean {
  if (!env.COORDINATOR_API_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.COORDINATOR_API_TOKEN}`;
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
      if (!authorized(request, env)) return errorResponse(401, "AUTH_REQUIRED", "需要有效的 Bearer 认证");
      const target = route(url.pathname);
      if (!target) return errorResponse(404, "NOT_FOUND", "未知协调器路由");
      const id = env.PROJECTS.idFromName(target.projectId);
      const stub = env.PROJECTS.get(id);
      const internalUrl = new URL(`/internal/${target.action}`, request.url);
      if (target.action === "context") internalUrl.search = url.search;
      const internalRequest = new Request(internalUrl, request);
      return stub.fetch(internalRequest);
    },
  };
}

export { ProjectDurableObject };

const worker = createCoordinatorWorker();
export default worker;
