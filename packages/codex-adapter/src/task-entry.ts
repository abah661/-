/** A 端单任务入口。复用 B 的 Git/HTTP/证据构件，不调用其 OpenCode 常驻入口。 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDiffScope, collectEvidence, findSensitiveTouches, git,
  gitPushBranch, HttpHeartbeatTransport, HttpLeaseAcquirer, HttpLeaseTransport,
  HttpRegistrationTransport, HttpResultReporter, isPathAllowed,
  prepareWorktree, readRemoteBranchSha, CoordinatorClient,
} from "@dac/executor";
import type { ExecutorConfig } from "@dac/executor";
import {
  LeaseSchema, ResultReportSchema, TaskGraphSchema, TaskNodeSchema,
} from "@dac/protocol";
import type { ErrorCode, Lease, ResultReport, ResultStatus, TaskNode, TestEvidence } from "@dac/protocol";
import { runCodexTask } from "./index.js";
import type { CodexAdapterConfig, CodexAdapterResult } from "./index.js";

const SHA = /^[0-9a-f]{40}$/;
const EXECUTOR = /^EXE-A-[0-9A-Z-]{2,32}$/;
const TASK = /^TASK-[0-9]{4,}$/;
const DEFAULT_TARGET = "https://github.com/hdsakj-sudo/first-one";

export interface ATaskOptions {
  coordinator_url: string;
  coordinator_token: string;
  project_id: string;
  executor_id: string;
  task_id: string;
  target_repo: string;
  target_remote_url: string;
  expected_base_sha: string;
  node22_path: string;
  codex: CodexAdapterConfig;
  /** 必须由调用者显式置 true；入口只接受授权表里的目标与 TASK-1002 分支。 */
  push_authorized: boolean;
}

export interface ATaskOutcome {
  task_id: string;
  attempt_id: string;
  status: ResultStatus | "halted";
  error_code: ErrorCode | null;
  commit_sha: string | null;
  remote_sha: string | null;
  report_accepted: boolean;
  worktree_path: string;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`缺少 ${name}`);
  return value.trim();
}

/** HTTP 客户端保留内存中的 token；Git/测试子进程不应再从进程环境继承它。 */
export function detachCoordinatorToken(env: NodeJS.ProcessEnv): void {
  delete env.COORDINATOR_API_TOKEN;
}

export function loadATaskOptions(env: NodeJS.ProcessEnv, argv: readonly string[]): ATaskOptions {
  const missing = ["COORDINATOR_BASE_URL", "COORDINATOR_API_TOKEN", "PROJECT_ID", "EXECUTOR_ID",
    "TARGET_REPO_ROOT", "TARGET_REPO_URL", "EXPECTED_BASE_SHA", "NODE22_PATH", "TASK_ID"]
    .filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`缺少环境配置：${missing.join(", ")}`);
  const options: ATaskOptions = {
    coordinator_url: requireValue(env.COORDINATOR_BASE_URL, "COORDINATOR_BASE_URL"),
    coordinator_token: requireValue(env.COORDINATOR_API_TOKEN, "COORDINATOR_API_TOKEN"),
    project_id: requireValue(env.PROJECT_ID, "PROJECT_ID"),
    executor_id: requireValue(env.EXECUTOR_ID, "EXECUTOR_ID"),
    task_id: requireValue(env.TASK_ID, "TASK_ID"),
    target_repo: resolve(requireValue(env.TARGET_REPO_ROOT, "TARGET_REPO_ROOT")),
    target_remote_url: requireValue(env.TARGET_REPO_URL, "TARGET_REPO_URL"),
    expected_base_sha: requireValue(env.EXPECTED_BASE_SHA, "EXPECTED_BASE_SHA"),
    node22_path: resolve(requireValue(env.NODE22_PATH, "NODE22_PATH")),
    codex: { model: "gpt-5.5", reasoning_effort: "high", default_sandbox: "workspace-write", default_timeout_ms: 900_000 },
    push_authorized: argv.includes("--push"),
  };
  if (!EXECUTOR.test(options.executor_id)) throw new Error("EXECUTOR_ID 必须是 EXE-A-... 格式");
  if (!TASK.test(options.task_id) || !SHA.test(options.expected_base_sha)) throw new Error("任务 ID 或固定基线 SHA 无效");
  if (!options.push_authorized) throw new Error("缺少 --push；未授权推送时不领取租约");
  if (options.task_id !== "TASK-1002" || normalizeRemote(options.target_remote_url) !== DEFAULT_TARGET) {
    throw new Error("此入口仅覆盖 AUTH-0007 的 first-one / TASK-1002，不自动扩展授权");
  }
  return options;
}

function normalizeRemote(value: string): string {
  return value.replace(/\.git\/?$/, "").replace(/\/$/, "");
}

function checkedGit(repo: string, args: readonly string[], label: string): string {
  const result = git(repo, args);
  if (result.exit_code !== 0) throw new Error(`${label} 失败（git 退出码 ${result.exit_code}）`);
  return result.stdout.trim();
}

/** 全部在领租约之前完成；任何一项不满足都不触发云端写入。 */
export function localPreflight(options: ATaskOptions): void {
  if (options.task_id !== "TASK-1002" || !options.push_authorized ||
      normalizeRemote(options.target_remote_url) !== DEFAULT_TARGET) throw new Error("推送授权范围不匹配");
  if (!existsSync(options.target_repo)) throw new Error("目标业务仓库不存在");
  if (!existsSync(options.node22_path)) throw new Error("Node 22 可执行文件不存在");
  const version = execFileSync(options.node22_path, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^v22\./.test(version)) throw new Error(`目标测试必须使用 Node 22，当前为 ${version}`);
  const origin = checkedGit(options.target_repo, ["remote", "get-url", "origin"], "读取 origin");
  if (normalizeRemote(origin) !== normalizeRemote(options.target_remote_url)) throw new Error("origin 与授权仓库不一致");
  checkedGit(options.target_repo, ["cat-file", "-e", `${options.expected_base_sha}^{commit}`], "核对固定基线");
  const remote = readRemoteBranchSha(options.target_repo, "origin", "main");
  if (remote.error || remote.sha !== options.expected_base_sha) throw new Error("远端 main 与冻结基线不一致或不可达");
}

export function validateLeasedTask(task: TaskNode, lease: Lease, options: Pick<ATaskOptions, "task_id" | "executor_id" | "expected_base_sha">): void {
  TaskNodeSchema.parse(task);
  LeaseSchema.parse(lease);
  if (task.task_id !== options.task_id || lease.task_id !== options.task_id ||
      lease.executor_id !== options.executor_id || lease.agent_kind !== "codex") {
    throw new Error("领取结果的任务或执行器身份不匹配；停止，不运行 agent");
  }
  for (const value of Object.values(lease.binding)) {
    if (value !== options.expected_base_sha) throw new Error("租约四项冻结版本与本地基线不一致");
  }
  if (task.write_scope.allow.length !== 2 || !task.write_scope.allow.includes("src/display/**") ||
      !task.write_scope.allow.includes("tests/display/**") ||
      isPathAllowed("src/provider/user-profile.js", task.write_scope) ||
      isPathAllowed("acceptance/run.mjs", task.write_scope)) {
    throw new Error("展示任务写入范围与冻结任务图不符");
  }
}

export function taskPrompt(task: TaskNode, lease: Lease): string {
  return [
    `仅完成 ${task.task_id}：${task.title}。attempt=${lease.attempt_id}。`,
    "先阅读本 worktree 的 AGENTS.md、contracts/user-profile.v1.json、docs/acceptance-v1.md。",
    `冻结基线 ${lease.binding.base_sha}；不要修改契约、验收、CI、规则或 provider。`,
    "本仓库 package.json 声明 type=module；.js 文件必须使用 ESM import/export，不能用 require/exports。上一尝试的测试正因此失败。",
    `只准写 ${task.write_scope.allow.join("、")}；deny 优先。不要自行 git commit/push/merge，执行器负责测试、提交和推送。`,
    `验收条件：${task.acceptance_criteria.join("；")}`,
    "不得删除已有文件或 Git 历史，不得修改密钥、.env、CI/CD、数据库、系统配置，不得安装全局依赖或部署。",
    "若无法完成，请如实说明；不要读取本机其他目录、登录凭据或会话文件。",
  ].join("\n");
}

function markerPath(repo: string, attemptId: string): string {
  return join(repo, ".local", `a-codex-${attemptId}.json`);
}

function assertNoUnresolvedAttempt(repo: string): void {
  const dir = join(repo, ".local");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!/^a-codex-TASK-\d+-A\d+\.json$/.test(name)) continue;
    let state: unknown;
    try { state = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown; }
    catch { throw new Error(`在途记录损坏：${name}；拒绝领取新任务`); }
    if (!state || typeof state !== "object" || (state as { state?: unknown }).state !== "reported") {
      throw new Error(`存在未结清的 A 端 attempt：${name}；拒绝领取新任务`);
    }
  }
}

/** 不能只信 Codex 说“完成”；探针文件必须真的由受限 CLI 写出。 */
export function verifyCodexWriteProbe(result: Pick<CodexAdapterResult, "status" | "kill_failed" | "aborted">,
  file: string, expected: string): void {
  if (result.status !== "completed" || result.kill_failed || result.aborted ||
      !existsSync(file) || readFileSync(file, "utf8") !== expected) {
    throw new Error("Codex 受限写入探针未通过；未领取任务");
  }
}

function writeMarker(path: string, state: "in_flight" | "halted" | "reported", lease: Lease, first = false): void {
  writeFileSync(path, JSON.stringify({ task_id: lease.task_id, attempt_id: lease.attempt_id,
    lease_epoch: lease.lease_epoch, state, updated_at: new Date().toISOString() }) + "\n",
  { encoding: "utf8", flag: first ? "wx" : "w" });
}

function resultStatus(result: CodexAdapterResult): { status: ResultStatus; code: ErrorCode | null } {
  if (result.status === "blocked_auth") return { status: "blocked_auth", code: "AUTH_EXPIRED" };
  if (result.status === "blocked_quota") return { status: "blocked_quota", code: "QUOTA_EXHAUSTED" };
  if (result.status === "retryable") return { status: "repair_pending", code: result.error_code ?? "RATE_LIMITED" };
  if (result.status === "failed") return { status: "repair_pending", code: result.error_code ?? "AGENT_NONZERO_EXIT" };
  return { status: "ready_for_integration", code: null };
}

export function buildAReport(input: {
  lease: Lease; status: ResultStatus; code: ErrorCode | null; head_sha: string;
  changed_files: readonly string[]; evidence: TestEvidence | null;
}): ResultReport {
  const { lease, status, code, head_sha, changed_files, evidence } = input;
  return ResultReportSchema.parse({
    protocol_version: "1", task_id: lease.task_id, attempt_id: lease.attempt_id,
    executor_id: lease.executor_id, lease_epoch: lease.lease_epoch, agent_kind: "codex",
    base_sha: lease.binding.base_sha, head_sha,
    rules_sha: lease.binding.rules_sha, contract_sha: lease.binding.contract_sha,
    acceptance_sha: lease.binding.acceptance_sha, status,
    evidence_id: evidence?.evidence_id ?? null, changed_files: [...changed_files], evidence,
    error_code: code, commit_shas: head_sha === lease.binding.base_sha ? [] : [head_sha],
    note: null, reported_at: new Date().toISOString(),
  });
}

/** 单次领取，不轮询，不自动清理。网络、杀进程或归属不明时保留现场。 */
export async function runSingleATask(options: ATaskOptions): Promise<ATaskOutcome | null> {
  detachCoordinatorToken(process.env);
  localPreflight(options);
  assertNoUnresolvedAttempt(options.target_repo);
  const config: ExecutorConfig = { base_url: options.coordinator_url.replace(/\/$/, ""),
    project_id: options.project_id, executor_id: options.executor_id, token: options.coordinator_token };
  const client = new CoordinatorClient(config);
  const health = await client.health();
  if (!health.ok) throw new Error("测试 Worker health 不可达；未领取任务");
  const status = await client.request<{ graph?: unknown }>({ method: "GET", path: "/status" });
  const graph = TaskGraphSchema.parse(status.graph);
  const expectedTask = graph.tasks.find((task) => task.task_id === options.task_id);
  const available = expectedTask?.status === "ready" ||
    (expectedTask?.status === "repair_pending" && expectedTask.attempts_used <= 2);
  if (graph.project_id !== options.project_id || graph.binding.base_sha !== options.expected_base_sha || !available) {
    throw new Error("Worker 任务图或 TASK-1002 状态不符合预检；未领取任务");
  }
  // 模型探针在领租约之前进行，避免旧 CLI/网络故障白白消耗 attempt。
  const probe = await runCodexTask({ prompt: "Reply with OK only.", cwd: options.target_repo,
    sandbox: "read-only", timeout_ms: 90_000 }, options.codex);
  if (probe.status !== "completed" || probe.kill_failed) throw new Error("Codex 只读探针未完成；未领取任务");
  // 只读模型探针不能证明 Windows 沙箱的写入工具可用。诊断文件留在忽略的 .local，
  // 不自动清理；写入失败就停在注册/领租约之前，避免白白消耗返修次数。
  const probeDir = join(options.target_repo, ".local", "codex-write-probes");
  mkdirSync(probeDir, { recursive: true });
  const probeName = `probe-${randomUUID()}.txt`;
  const probeText = `codex-write-${randomUUID()}\n`;
  const writeProbe = await runCodexTask({
    prompt: `只做写入能力检查：在当前目录使用 apply_patch 新建 ${probeName}，内容必须恰好是 ${probeText.trim()} 加一个换行。不要读其他目录、运行命令或修改别的文件。`,
    cwd: probeDir, sandbox: "workspace-write", timeout_ms: 90_000,
  }, options.codex);
  verifyCodexWriteProbe(writeProbe, join(probeDir, probeName), probeText);
  const registration = new HttpRegistrationTransport(client);
  const ack = await registration.register({ protocol_version: "1", executor_id: options.executor_id,
    host_label: hostname().slice(0, 64), agent_kind: "codex", capabilities: ["code", "test", "git_push"],
    tool_versions: { node: "22", codex: "local" }, project_root: options.target_repo,
    registered_at: new Date().toISOString() });
  if (!ack.registered || ack.executor_id !== options.executor_id) throw new Error("A 执行器注册未被接受");
  const acquired = await new HttpLeaseAcquirer(client).acquire({ executor_id: options.executor_id,
    agent_kind: "codex", capabilities: ["code", "test", "git_push"] });
  if (acquired.kind === "empty") return null;
  const { task, lease } = acquired;
  validateLeasedTask(task, lease, options);
  const branch = `task/${lease.task_id}/${lease.attempt_id}`;
  if (!/^task\/TASK-1002\/TASK-1002-A\d+$/.test(branch)) throw new Error("任务分支不在授权前缀内");
  const dir = join(options.target_repo, ".local");
  mkdirSync(dir, { recursive: true });
  const marker = markerPath(options.target_repo, lease.attempt_id);
  writeMarker(marker, "in_flight", lease, true);
  const prepared = prepareWorktree({ repo_root: options.target_repo, worktree_root: join(dir, "worktrees"),
    base_sha: lease.binding.base_sha, task_id: lease.task_id, attempt_id: lease.attempt_id, branch });
  const outcome: ATaskOutcome = { task_id: lease.task_id, attempt_id: lease.attempt_id,
    status: "halted", error_code: null, commit_sha: null, remote_sha: null,
    report_accepted: false, worktree_path: prepared.path };
  const abort = new AbortController();
  let leaseUnsafe = false;
  let renewInFlight: Promise<void> | null = null;
  const renewTransport = new HttpLeaseTransport(client);
  const heartbeat = new HttpHeartbeatTransport(client);
  const renew = async (): Promise<void> => {
    try {
      const renewed = await renewTransport.renew(lease.task_id, lease.attempt_id, lease.lease_epoch);
      if (renewed.kind !== "renewed" || renewed.lease_epoch !== lease.lease_epoch) throw new Error("租约归属失效");
    } catch {
      leaseUnsafe = true;
      abort.abort();
    }
  };
  const timer = setInterval(() => {
    if (!renewInFlight) renewInFlight = renew().finally(() => { renewInFlight = null; });
  }, 40_000);
  const beat = async (): Promise<void> => {
    try { await heartbeat.send({ protocol_version: "1", executor_id: lease.executor_id,
      state: "running", task_id: lease.task_id, attempt_id: lease.attempt_id,
      lease_epoch: lease.lease_epoch, sent_at: new Date().toISOString(),
      idempotency_key: `a-heartbeat:${lease.attempt_id}:${randomUUID()}` }); }
    catch { /* 心跳只用于观测；续租决定持有权。 */ }
  };
  const heartbeatTimer = setInterval(() => { void beat(); }, 40_000);
  try {
    await renew();
    if (leaseUnsafe) throw new Error("首次续租失败，保留现场");
    await beat();
    const agent = await runCodexTask({ prompt: taskPrompt(task, lease), cwd: prepared.path,
      sandbox: "workspace-write", timeout_ms: 900_000, signal: abort.signal }, options.codex);
    if (leaseUnsafe || agent.aborted || agent.kill_failed) throw new Error("Agent 进程或租约状态不安全，保留现场不上报");
    let { status: taskStatus, code } = resultStatus(agent);
    let evidence: TestEvidence | null = null;
    let changed: readonly string[] = [];
    const base = lease.binding.base_sha;
    let head = checkedGit(prepared.path, ["rev-parse", "HEAD"], "读取 HEAD");
    if (taskStatus === "ready_for_integration") {
      const diff = checkDiffScope({ worktree_path: prepared.path, base_sha: base, scope: task.write_scope });
      changed = diff.changed_files;
      if (diff.error) { taskStatus = "failed"; code = "INTERNAL_ERROR"; }
      else if (findSensitiveTouches(changed).length) { taskStatus = "blocked_approval"; code = "SENSITIVE_FILE_DETECTED"; }
      else if (!diff.ok) { taskStatus = "repair_pending"; code = "DIFF_OUT_OF_SCOPE"; }
      else if (!changed.length) { taskStatus = "repair_pending"; code = "AGENT_INVALID_OUTPUT"; }
      if (taskStatus === "ready_for_integration") {
        const test = await collectEvidence({ command: [options.node22_path, "--test"], cwd: prepared.path,
          timeout_ms: 120_000, evidence_id: `EVID-${lease.attempt_id}-1`,
          // 协调器连接走代理；业务测试不需要网络，不能让代理启动警告携 PID 污染证据哈希。
          env: { NODE_USE_ENV_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" } });
        if (test.process_state !== "stopped" || test.kill_failed) throw new Error("测试进程状态不安全，保留现场不上报");
        evidence = test.evidence;
        if (!test.summary_parsed || evidence.exit_code !== 0 || evidence.summary.failed !== 0 ||
            evidence.summary.passed < 1) { taskStatus = "repair_pending"; code = "TESTS_FAILED"; }
      }
      if (taskStatus === "ready_for_integration") {
        await renew();
        if (leaseUnsafe) throw new Error("提交前租约不可确认");
        checkedGit(prepared.path, ["add", "-A"], "暂存任务改动");
        const stagedDiff = checkDiffScope({ worktree_path: prepared.path, base_sha: base, scope: task.write_scope });
        if (!stagedDiff.ok || stagedDiff.error || !stagedDiff.changed_files.length ||
            findSensitiveTouches(stagedDiff.changed_files).length) throw new Error("暂存内容不满足写入边界，保留现场");
        checkedGit(prepared.path, ["diff", "--cached", "--check"], "检查暂存 diff");
        checkedGit(prepared.path, ["commit", "-m", `${task.task_id}: ${task.title}`, "-m",
          `attempt_id: ${lease.attempt_id}\ncontract_version: v1\nbase_sha: ${base}\nrules_sha: ${lease.binding.rules_sha}\ncontract_sha: ${lease.binding.contract_sha}\nacceptance_sha: ${lease.binding.acceptance_sha}`], "创建任务提交");
        head = checkedGit(prepared.path, ["rev-parse", "HEAD"], "读取任务提交");
        outcome.commit_sha = head;
        const post = checkDiffScope({ worktree_path: prepared.path, base_sha: base, scope: task.write_scope });
        if (!post.ok || post.error || post.has_uncommitted || findSensitiveTouches(post.changed_files).length) {
          throw new Error("提交后范围复核失败，保留现场");
        }
        await renew();
        if (leaseUnsafe) throw new Error("推送前租约不可确认");
        const pushed = gitPushBranch({ worktree_path: prepared.path, branch, remote: "origin" });
        if (!pushed.pushed || pushed.remote_sha !== head) { taskStatus = "failed"; code = "PUSH_REJECTED"; }
        else outcome.remote_sha = pushed.remote_sha;
      }
    }
    await renew();
    if (leaseUnsafe) throw new Error("上报前租约不可确认");
    const report = buildAReport({ lease, status: taskStatus, code, head_sha: head,
      changed_files: changed, evidence });
    const reported = await new HttpResultReporter(client).report(report);
    if (!reported.accepted) throw new Error("Worker 未接受结果报告；保留现场");
    writeMarker(marker, "reported", lease);
    outcome.status = taskStatus;
    outcome.error_code = code;
    outcome.report_accepted = true;
    return outcome;
  } catch {
    writeMarker(marker, "halted", lease);
    return outcome;
  } finally {
    clearInterval(timer);
    clearInterval(heartbeatTimer);
    if (renewInFlight) await renewInFlight;
  }
}

async function main(): Promise<void> {
  try {
    const options = loadATaskOptions(process.env, process.argv.slice(2));
    const outcome = await runSingleATask(options);
    process.stdout.write(JSON.stringify(outcome ?? { status: "empty" }) + "\n");
    if (outcome?.status === "halted") process.exitCode = 2;
  } catch (error) {
    // 不输出异常原文：外部错误可能包含 URL 查询参数或环境中的凭据。
    process.stderr.write(`A 端入口停止：${error instanceof Error ? error.name : "unknown"}。检查本机状态与非敏感日志。\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
