import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { BatchConclusionRequestSchema, IntegrationBatchSchema } from "@dac/protocol";
import { verifyGitHubBatchObservation } from "../../apps/coordinator/src/github-batch-verifier.js";
import { createCoordinatorWorker, type CoordinatorEnv } from "../../apps/coordinator/src/worker.js";

const sha = (character: string) => character.repeat(40);
const base = sha("a");
const head = sha("b");
const workflowBlob = sha("c");
const runHead = sha("d");
const tree = sha("e");
const repoUrl = "https://api.github.com/repos/example/project";
const binding = {
  owner: "example", repo: "project", workflow_path: ".github/workflows/integration.yml",
  workflow_blob_sha: workflowBlob, branch_prefix: "task/TASK-1003/", artifact_name: "p3-batch-evidence",
};
const batch = IntegrationBatchSchema.parse({
  batch_id: "BATCH-0001", project_id: "PROJECT-TEST", base_sha: base,
  rules_sha: base, contract_sha: base, acceptance_sha: base,
  candidate_heads: [head], trusted_workflow: `${binding.workflow_path}@${workflowBlob}`,
  created_at: "2026-10-08T00:00:00Z", conclusion: "pending",
});
const request = BatchConclusionRequestSchema.parse({
  protocol_version: "1", project_id: batch.project_id, batch_id: batch.batch_id,
  candidate_heads: batch.candidate_heads, conclusion: "passed", error_code: null,
  affected_task_ids: [], github_run_id: "42", idempotency_key: "conclude-42",
});

function fixture() {
  const run: Record<string, unknown> = {
    id: 42, status: "completed", conclusion: "success", event: "push",
    path: binding.workflow_path,
    head_repository: { full_name: "example/project" }, head_sha: runHead,
    head_branch: "task/TASK-1003/TASK-1003-A2", run_attempt: 1,
  };
  const content: Record<string, unknown> = { type: "file", sha: workflowBlob };
  const evidence: Record<string, unknown> = {
    schema_version: 1, project_id: batch.project_id, batch_id: batch.batch_id,
    base_sha: base, rules_sha: base, contract_sha: base, acceptance_sha: base,
    candidate_heads: [head], trusted_workflow: batch.trusted_workflow,
    github_run_id: "42", github_run_attempt: "1", github_head_sha: runHead,
    merged_sha: sha("f"), tree_sha: tree, dirty: false,
    commands: [["git", "merge", head], ["npm", "test"]], exit_code: 0,
    tests: { passed: 3, failed: 0, skipped: 0 }, test_exit_code: 0, acceptance_exit_code: 0,
    output_sha256: { test: "1".repeat(64), acceptance: "2".repeat(64) },
    error_code: null, affected_task_ids: [], observed_at: "2026-10-08T00:01:00Z",
  };
  const artifact: Record<string, unknown> = {
    id: 99, name: binding.artifact_name, expired: false,
    workflow_run: { id: 42, head_sha: runHead, head_branch: "task/TASK-1003/TASK-1003-A2" },
  };
  let forbidden = false;
  let brokenJson = false;
  let badZip = false;
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (forbidden) return new Response("forbidden", { status: 403 });
    if (brokenJson) return new Response("invalid JSON");
    if (url === `${repoUrl}/actions/runs/42`) return Response.json(run);
    if (url === `${repoUrl}/contents/.github/workflows/integration.yml?ref=${runHead}`) return Response.json(content);
    if (url === `${repoUrl}/git/commits/${base}` || url === `${repoUrl}/git/commits/${head}`) {
      return Response.json({ sha: url.slice(-40), tree: { sha: tree } });
    }
    const zip = zipSync({ "p3-batch-evidence.json": strToU8(JSON.stringify(evidence)) });
    const digest = createHash("sha256").update(zip).digest("hex");
    if (url === `${repoUrl}/actions/runs/42/artifacts?per_page=100`) {
      return Response.json({ artifacts: [{ ...artifact, digest: `sha256:${digest}`, size_in_bytes: zip.length }] });
    }
    if (url === `${repoUrl}/actions/artifacts/99/zip`) return new Response(badZip ? strToU8("broken") : zip);
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;
  return { run, content, evidence, artifact, fetcher,
    forbid: () => { forbidden = true; }, brokenJson: () => { brokenJson = true; },
    corruptZip: () => { badZip = true; } };
}

describe("CP-0002 GitHub 独立批次取证", () => {
  it("固定 run、工作流 blob、候选 Git 对象与 artifact 摘要均匹配时返回可信观察", async () => {
    const mock = fixture();
    const result = await verifyGitHubBatchObservation(batch, request, binding, mock.fetcher);
    expect(result).toMatchObject({ batch_id: batch.batch_id, ci_run_id: "42", conclusion: "success",
      merged_sha: sha("f"), tree_sha: tree, affected_task_ids: [] });
    expect(result.evidence?.tests).toMatchObject({ passed: 3, failed: 0 });
    mock.run.path = `${binding.workflow_path}@task/TASK-1003/TASK-1003-A2`;
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).resolves.toMatchObject({
      ci_run_id: "42", conclusion: "success",
    });
  });

  it("固定项目绑定、run 身份或工作流 blob 不符时拒绝", async () => {
    const mock = fixture();
    await expect(verifyGitHubBatchObservation(batch, request, { ...binding, repo: "other" }, mock.fetcher)).rejects.toThrow();
    mock.run.head_branch = "main";
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/首次完成运行/);
    mock.run.head_branch = "task/TASK-1003/TASK-1003-A2";
    mock.run.id = 43;
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/首次完成运行/);
    mock.run.id = 42;
    mock.run.path = `${binding.workflow_path}@main`;
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/首次完成运行/);
    mock.run.path = `${binding.workflow_path}@task/TASK-1003/TASK-1003-A2`;
    mock.content.sha = sha("1");
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/blob/);
  });

  it("不能把伪造的 JSON、污染候选或失败的成功证据算通过", async () => {
    const mock = fixture();
    mock.evidence.candidate_heads = [sha("9")];
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/候选/);
    mock.evidence.candidate_heads = [head];
    mock.evidence.test_exit_code = 1;
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/验收底线/);
  });

  it("artifact 字节与 GitHub 摘要不符时拒绝", async () => {
    const mock = fixture();
    mock.corruptZip();
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/摘要/);
  });

  it("GitHub 403 与非 JSON 均 fail closed，不能静默转为通过", async () => {
    const mock = fixture();
    mock.forbid();
    await expect(verifyGitHubBatchObservation(batch, request, binding, mock.fetcher)).rejects.toThrow(/403/);
    const other = fixture();
    other.brokenJson();
    await expect(verifyGitHubBatchObservation(batch, request, binding, other.fetcher)).rejects.toThrow(/响应无效/);
  });

  it("公网结论路由仅由管理身份调用，并在 Worker 内重新取证后才转交 DO", async () => {
    const mock = fixture();
    let forwarded: unknown = null;
    const env: CoordinatorEnv = {
      COORDINATOR_API_TOKEN: "admin-only", COORDINATOR_EXECUTOR_TOKENS_JSON: JSON.stringify({ EXE_B: "executor-only" }),
      COORDINATOR_GITHUB_PROJECT_BINDINGS_JSON: JSON.stringify({ [batch.project_id]: binding }),
      PROJECTS: { idFromName: () => ({ toString: () => batch.project_id }), get: () => ({
        fetch: async (internal: Request) => {
          const action = new URL(internal.url).pathname;
          if (action === "/internal/status") return Response.json({ batches: { [batch.batch_id]: batch } });
          if (action === "/internal/integration_conclusion_verified") {
            forwarded = await internal.json();
            return Response.json({ accepted: true });
          }
          throw new Error(`unexpected DO call: ${action}`);
        },
      }) },
    };
    const worker = createCoordinatorWorker({ githubFetch: mock.fetcher });
    const url = `https://coordinator.example/v1/projects/${batch.project_id}/batches/${batch.batch_id}/conclusion`;
    const submit = (body: unknown, bearer: string) => worker.fetch(new Request(url, {
      method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env);
    expect((await submit(request, "executor-only")).status).toBe(403);
    expect(forwarded).toBeNull();
    expect((await submit({ ...request, observation: { conclusion: "success" } }, "admin-only")).status).toBe(400);
    expect((await submit(request, "admin-only")).status).toBe(200);
    expect(forwarded).toMatchObject({ request: { batch_id: batch.batch_id },
      observation: { ci_run_id: "42", conclusion: "success", merged_sha: sha("f") } });

    env.COORDINATOR_EXECUTOR_TOKENS_JSON = JSON.stringify({ EXE_B: "admin-only" });
    expect((await submit(request, "admin-only")).status).toBe(503);
    env.COORDINATOR_EXECUTOR_TOKENS_JSON = JSON.stringify({ EXE_B: "executor-only" });
    env.COORDINATOR_GITHUB_PROJECT_BINDINGS_JSON = undefined;
    expect((await submit(request, "admin-only")).status).toBe(503);
  });
});
