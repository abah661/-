import { unzipSync } from "fflate";
import { z } from "zod";
import { type BatchConclusionRequest, type IntegrationBatch } from "@dac/protocol";
import { ApiError } from "./api.js";
import type { ServerVerifiedBatchObservation } from "./batch-conclusion.js";

const fullSha = z.string().regex(/^[0-9a-f]{40}$/);
const ArtifactSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string(), batch_id: z.string(),
  base_sha: fullSha, rules_sha: fullSha, contract_sha: fullSha, acceptance_sha: fullSha,
  candidate_heads: z.array(fullSha).min(1), trusted_workflow: z.string(),
  github_run_id: z.string(), github_run_attempt: z.string(), github_head_sha: fullSha,
  merged_sha: fullSha, tree_sha: fullSha, dirty: z.boolean(),
  commands: z.array(z.array(z.string().min(1)).min(1)).min(1),
  exit_code: z.number().int(),
  tests: z.object({ passed: z.number().int().min(0), failed: z.number().int().min(0), skipped: z.number().int().min(0) }),
  test_exit_code: z.number().int(), acceptance_exit_code: z.number().int(),
  output_sha256: z.object({ test: z.string().regex(/^[0-9a-f]{64}$/), acceptance: z.string().regex(/^[0-9a-f]{64}$/) }),
  error_code: z.enum(["TESTS_FAILED"]).nullable(), affected_task_ids: z.array(z.string()),
  observed_at: z.string().datetime({ offset: true }),
}).strict();

/** 非敏感、由 A 固定的项目绑定；不允许从请求体指定仓库或工作流。 */
export const GitHubProjectBindingSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  workflow_path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/),
  workflow_blob_sha: fullSha,
  branch_prefix: z.string().regex(/^task\/[A-Z0-9-]+\/$/),
  artifact_name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
}).strict();
export type GitHubProjectBinding = z.infer<typeof GitHubProjectBindingSchema>;

type Fetcher = typeof fetch;
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;

function fail(message: string, status = 422): never {
  throw new ApiError(status, "UNTRUSTED_INTEGRATION_EVIDENCE", message);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("GitHub 返回非对象数据");
  return value as Record<string, unknown>;
}

async function apiJson(fetcher: Fetcher, url: string, token?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "dual-agent-coordinator",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let response: Response;
  try { response = await fetcher(url, { headers, redirect: "follow" }); }
  catch { throw new ApiError(503, "GITHUB_EVIDENCE_UNAVAILABLE", "GitHub 独立取证不可达"); }
  if (!response.ok) {
    throw new ApiError(503, "GITHUB_EVIDENCE_UNAVAILABLE", `GitHub 独立取证 HTTP ${response.status}`);
  }
  try { return record(await response.json()); }
  catch { throw new ApiError(503, "GITHUB_EVIDENCE_UNAVAILABLE", "GitHub 独立取证响应无效"); }
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) fail("artifact 响应没有内容");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > MAX_ZIP_BYTES) {
      await reader.cancel();
      fail("artifact ZIP 超过大小上限");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertBatchBinding(batch: IntegrationBatch, binding: GitHubProjectBinding): void {
  const workflow = `${binding.workflow_path}@${binding.workflow_blob_sha}`;
  if (batch.trusted_workflow !== workflow) fail("批次工作流不在项目固定允许列表");
}

/**
 * 通过 GitHub REST 重新取 run、工作流 blob、候选 Git 对象和 artifact ZIP。
 * 任何缺失、过期、额度耗尽或不一致都 fail closed；不采信管理请求中的 CI 结论。
 */
export async function verifyGitHubBatchObservation(
  batch: IntegrationBatch,
  request: BatchConclusionRequest,
  inputBinding: unknown,
  fetcher: Fetcher = fetch,
  token?: string,
): Promise<ServerVerifiedBatchObservation> {
  const parsedBinding = GitHubProjectBindingSchema.safeParse(inputBinding);
  if (!parsedBinding.success) fail("项目未配置可信 GitHub 仓库/工作流绑定", 503);
  const binding = parsedBinding.data;
  assertBatchBinding(batch, binding);
  if (!request.github_run_id || !sameList(batch.candidate_heads, request.candidate_heads)) {
    fail("结论请求缺少 run 或候选提交不匹配");
  }
  const repo = `https://api.github.com/repos/${binding.owner}/${binding.repo}`;
  const run = await apiJson(fetcher, `${repo}/actions/runs/${request.github_run_id}`, token);
  const runRepo = record(run.head_repository);
  const runConclusion = request.conclusion === "passed" ? "success" : "failure";
  const expectedRunPath = typeof run.head_branch === "string" ? `${binding.workflow_path}@${run.head_branch}` : "";
  if (run.id !== Number(request.github_run_id) || run.status !== "completed" || run.conclusion !== runConclusion || run.event !== "push" ||
      run.path !== expectedRunPath || runRepo.full_name !== `${binding.owner}/${binding.repo}` ||
      typeof run.head_sha !== "string" || !fullSha.safeParse(run.head_sha).success ||
      typeof run.head_branch !== "string" || !run.head_branch.startsWith(binding.branch_prefix) ||
      run.run_attempt !== 1) {
    fail("GitHub run 非固定仓库/工作流的首次完成运行，或结论不一致");
  }
  const headSha = run.head_sha as string;
  const workflowPath = binding.workflow_path.split("/").map(encodeURIComponent).join("/");
  const content = await apiJson(fetcher, `${repo}/contents/${workflowPath}?ref=${headSha}`, token);
  if (content.type !== "file" || content.sha !== binding.workflow_blob_sha) fail("工作流文件 blob 与冻结引用不一致");

  for (const candidate of [batch.base_sha, ...batch.candidate_heads]) {
    const commit = await apiJson(fetcher, `${repo}/git/commits/${candidate}`, token);
    if (commit.sha !== candidate || !fullSha.safeParse(record(commit.tree).sha).success) {
      fail("候选 Git 提交或树无法独立核实");
    }
  }

  const listing = await apiJson(fetcher, `${repo}/actions/runs/${request.github_run_id}/artifacts?per_page=100`, token);
  if (!Array.isArray(listing.artifacts)) fail("GitHub artifact 列表无效");
  const matching = listing.artifacts.filter((value) => record(value).name === binding.artifact_name);
  if (matching.length !== 1) fail("固定名称的证据 artifact 缺失或重复");
  const artifact = record(matching[0]);
  const artifactRun = record(artifact.workflow_run);
  if (artifact.expired !== false || typeof artifact.id !== "number" ||
      artifactRun.id !== Number(request.github_run_id) || artifactRun.head_sha !== headSha ||
      artifactRun.head_branch !== run.head_branch ||
      typeof artifact.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
      typeof artifact.size_in_bytes !== "number" || artifact.size_in_bytes > MAX_ZIP_BYTES) {
    fail("证据 artifact 已过期、跨 run 或缺少可信摘要");
  }
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "dual-agent-coordinator" };
  if (token) headers.authorization = `Bearer ${token}`;
  let download: Response;
  try { download = await fetcher(`${repo}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: "follow" }); }
  catch { throw new ApiError(503, "GITHUB_EVIDENCE_UNAVAILABLE", "证据 artifact 下载不可达"); }
  if (!download.ok) throw new ApiError(503, "GITHUB_EVIDENCE_UNAVAILABLE", `证据 artifact 下载 HTTP ${download.status}`);
  const zip = await boundedBytes(download);
  if (zip.byteLength !== artifact.size_in_bytes || await sha256(zip) !== artifact.digest.slice(7)) {
    fail("artifact ZIP 大小或摘要与 GitHub 记录不一致");
  }
  let entries: Record<string, Uint8Array>;
  let selected = 0;
  try {
    entries = unzipSync(zip, { filter: (file) => {
      if (file.name !== "p3-batch-evidence.json") return false;
      selected += 1;
      return file.originalSize <= MAX_EVIDENCE_BYTES;
    } });
  } catch { return fail("artifact ZIP 无法安全解析"); }
  const data = entries["p3-batch-evidence.json"];
  if (selected !== 1 || !data || data.byteLength > MAX_EVIDENCE_BYTES) fail("证据 JSON 缺失、重复或超限");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(data)); }
  catch { return fail("证据 JSON 无法解析"); }
  const parsed = ArtifactSchema.safeParse(raw);
  if (!parsed.success) fail("证据 JSON 不符合固定格式");
  const evidence = parsed.data;
  for (const field of ["base_sha", "rules_sha", "contract_sha", "acceptance_sha"] as const) {
    if (evidence[field] !== batch[field]) fail("证据版本与批次不一致");
  }
  if (evidence.project_id !== batch.project_id || evidence.batch_id !== batch.batch_id ||
      !sameList(evidence.candidate_heads, batch.candidate_heads) ||
      evidence.trusted_workflow !== batch.trusted_workflow ||
      evidence.github_run_id !== request.github_run_id || evidence.github_run_attempt !== "1" ||
      evidence.github_head_sha !== headSha) {
    fail("证据项目、批次、候选或 run 绑定不一致");
  }
  if (request.conclusion === "passed") {
    if (evidence.exit_code !== 0 || evidence.test_exit_code !== 0 || evidence.acceptance_exit_code !== 0 ||
        evidence.tests.passed < 1 || evidence.tests.failed !== 0 || evidence.dirty || evidence.error_code !== null ||
        evidence.affected_task_ids.length !== 0) {
      fail("成功 run 的组合证据不满足独立验收底线");
    }
  } else if (evidence.exit_code === 0 || evidence.error_code !== "TESTS_FAILED" ||
             evidence.affected_task_ids.some((id) => !/^TASK-[0-9]{4,}$/.test(id))) {
    fail("失败 run 缺少可归因的失败证据");
  }
  return {
    batch_id: batch.batch_id, project_id: batch.project_id,
    base_sha: batch.base_sha, rules_sha: batch.rules_sha, contract_sha: batch.contract_sha,
    acceptance_sha: batch.acceptance_sha, candidate_heads: batch.candidate_heads,
    trusted_workflow: batch.trusted_workflow, ci_run_id: request.github_run_id,
    conclusion: request.conclusion === "passed" ? "success" : "failure",
    merged_sha: evidence.merged_sha, tree_sha: evidence.tree_sha,
    affected_task_ids: evidence.affected_task_ids,
    evidence: {
      batch_id: batch.batch_id, project_id: batch.project_id,
      base_sha: batch.base_sha, rules_sha: batch.rules_sha, contract_sha: batch.contract_sha,
      acceptance_sha: batch.acceptance_sha, candidate_heads: batch.candidate_heads,
      trusted_workflow: batch.trusted_workflow, commands: evidence.commands,
      exit_code: evidence.exit_code, tests: evidence.tests, ci_run_id: request.github_run_id,
      merged_sha: evidence.merged_sha, tree_sha: evidence.tree_sha, dirty: evidence.dirty,
    },
  };
}
