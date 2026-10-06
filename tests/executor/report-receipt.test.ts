/**
 * P1 回归：成功上报的**脱敏收据**（B18 实施）。
 *
 * 对应方案 §6 的 9 条用例。每一条都对准一个**真实发生过的缺口**或一条
 * A 明确的边界，而不是为覆盖率凑数：
 *
 * | # | 用例 | 对准的缺口 |
 * | --- | --- | --- |
 * | 1 | 成功上报 | 成功路径此前**一个状态码都不留** |
 * | 2 | 状态码如实反映 | 重试后不得把首次的 503 记成最终值 |
 * | 3 | 白名单 | 字段最小化：不得带出白名单之外的键 |
 * | 4 | 泄漏哨兵 | token / 原始测试输出 / prompt **不得**出现在收据里 |
 * | 5 | 跨 attempt 隔离 | 一 attempt 一文件，绝不互相覆盖 |
 * | 6 | 写失败降级 | 观测手段不得改变上报结论 |
 * | 7 | 观察者异常 | 只读观察者不得影响请求结果 |
 * | 8 | 失败路径不伪造 | 失败**不得**被写成 `accepted: true` |
 * | 9 | 无自动删除 | 常驻入口不存在任何自动删除路径 |
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Lease, ResultReport, TaskNode } from "@dac/protocol";
import type { AttemptOutcome } from "../../apps/executor/src/core/attempt.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { RecoveryTransport, TaskOwnership } from "../../apps/executor/src/core/recovery.js";
import {
  buildReportReceipt,
  readReportReceipt,
  RECEIPT_ALLOWED_KEYS,
  reportReceiptPath,
  receiptsDir,
  sanitizeReportReceipt,
} from "../../apps/executor/src/core/receipts.js";
import type { ReportReceipt } from "../../apps/executor/src/core/receipts.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import { HttpResultReporter } from "../../apps/executor/src/transport/adapters.js";
import { CoordinatorClient, CoordinatorHttpError } from "../../apps/executor/src/transport/http.js";
import type { ExecutorConfig } from "../../apps/executor/src/transport/http.js";
import {
  fileReceiptStore,
  runDaemon,
} from "../../apps/executor/src/daemon.js";
import type { DaemonDeps, DaemonOptions, PushResult } from "../../apps/executor/src/daemon.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PUSH_SHA = "e".repeat(40);

/** 泄漏哨兵：分别代表 token、原始测试输出、prompt。 */
const SENTINEL_TOKEN = "SENTINEL-TOKEN-9f3c7a1d";
const SENTINEL_RAW_OUTPUT = "SENTINEL-TAP-v13-pass-42";
const SENTINEL_PROMPT = "SENTINEL-PROMPT-internal-instructions";

const BINDING = {
  base_sha: SHA_A,
  rules_sha: SHA_B,
  contract_sha: "c".repeat(40),
  acceptance_sha: "d".repeat(40),
};

const LEASE: Lease = {
  task_id: "TASK-0001",
  attempt_id: "TASK-0001-A1",
  executor_id: "EXE-B-OPENCODE",
  lease_epoch: 4,
  expires_at: "2030-01-01T00:00:00.000Z",
  binding: BINDING,
  agent_kind: "opencode",
};

const TASK: TaskNode = {
  task_id: "TASK-0001",
  kind: "implement",
  title: "实现示例功能",
  acceptance_criteria: ["测试全绿"],
  depends_on: [],
  write_scope: { allow: ["apps/executor/**"], deny: [] },
  contracts: [],
  requires: ["code"],
  expected_interfaces: [],
  status: "leased",
  assigned_executor: "EXE-B-OPENCODE",
  attempts_used: 1,
};

const CONFIG: ExecutorConfig = {
  base_url: "https://coordinator.example.invalid",
  project_id: "PROJECT-TEST",
  executor_id: "EXE-B-OPENCODE",
  // 哨兵 token：必须不出现在收据里。
  token: SENTINEL_TOKEN,
};

function makeReport(overrides: Partial<ResultReport> = {}): ResultReport {
  return {
    protocol_version: "1",
    task_id: LEASE.task_id,
    attempt_id: LEASE.attempt_id,
    executor_id: LEASE.executor_id,
    lease_epoch: LEASE.lease_epoch,
    agent_kind: "opencode",
    base_sha: BINDING.base_sha,
    head_sha: SHA_B,
    rules_sha: BINDING.rules_sha,
    contract_sha: BINDING.contract_sha,
    acceptance_sha: BINDING.acceptance_sha,
    status: "ready_for_integration",
    evidence_id: "EVID-1",
    changed_files: ["apps/executor/src/daemon.ts"],
    evidence: {
      evidence_id: "EVID-1",
      command: ["node", "--test"],
      exit_code: 0,
      summary: { passed: 3, failed: 0, skipped: 0 },
      log_artifact: null,
      output_sha256: "1".repeat(64),
    },
    error_code: null,
    commit_shas: [SHA_B],
    note: null,
    reported_at: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<AttemptOutcome> = {}): AttemptOutcome {
  const commit = { committed: true, sha: SHA_B, error_code: null, message: null };
  return {
    report: makeReport(),
    trace: {
      phases: ["preparing_worktree", "running_agent", "committing", "reporting"],
      lease_lost: false,
      lease_lost_reason: null,
      sideEffectsSkipped: false,
      worktree_ready: true,
      commit,
      commit_skipped_reason: null,
      kill_failed: false,
      git_error: null,
      process_state: "stopped",
      shortCircuited: false,
    },
    worktree_removed: false,
    worktree_path: "/repo/.local/worktrees/TASK-0001-A1",
    local_commits: [SHA_B],
    commit,
    changed_files: ["apps/executor/src/daemon.ts"],
    // 哨兵：原始测试输出绝不允许进入收据。
    raw_test_output: SENTINEL_RAW_OUTPUT,
    ...overrides,
  };
}

function makeOptions(repoRoot: string, overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    config: CONFIG,
    registration: {
      host_label: "b-desktop",
      agent_kind: "opencode",
      capabilities: ["code", "test", "git_push"],
    },
    repo_root: repoRoot,
    worktree_root: join(repoRoot, ".local", "worktrees"),
    model: "myapi/gpt-5.6-sol",
    max_idle_polls: 1,
    poll_interval_ms: 1,
    enable_push: true,
    ...overrides,
  };
}

interface RunResult {
  report: Awaited<ReturnType<typeof runDaemon>>;
  reports: ResultReport[];
  receipts: ReportReceipt[];
  logs: string[];
}

/**
 * 跑一次 daemon：领到 1 个任务、上报、然后空队列退出。
 *
 * `write_report_receipt` 默认为**真实的文件实现**（这样「写进预期路径」
 * 这件事本身也被验证）；需要模拟写失败时由 `deps` 覆盖。
 */
async function runOnce(
  repoRoot: string,
  config: {
    outcome?: AttemptOutcome;
    reportAck?: ReportAck | { fail: unknown };
    pushResult?: PushResult;
    deps?: Partial<DaemonDeps>;
    options?: Partial<DaemonOptions>;
    /** 覆盖租约（用于跨 attempt 隔离用例） */
    lease?: Lease;
  } = {},
): Promise<RunResult> {
  const reports: ResultReport[] = [];
  const receipts: ReportReceipt[] = [];
  const logs: string[] = [];
  const lease = config.lease ?? LEASE;
  let acquireIndex = 0;
  const script: LeaseAcquisition[] = [{ kind: "leased", task: TASK, lease }];

  const acquirer: LeaseAcquirer = {
    async acquire(): Promise<LeaseAcquisition> {
      const index = acquireIndex;
      acquireIndex += 1;
      return script[index] ?? { kind: "empty" };
    },
  };
  const registration: RegistrationTransport = {
    async register() {
      return { executor_id: CONFIG.executor_id, registered: true };
    },
  };
  const leaseTransport: LeaseTransport = {
    async renew(): Promise<RenewOutcome> {
      return { kind: "renewed", expires_at: LEASE.expires_at, lease_epoch: LEASE.lease_epoch };
    },
  };
  const heartbeatTransport: HeartbeatTransport = {
    async send(_request: HeartbeatRequest): Promise<void> {},
  };
  const recoveryTransport: RecoveryTransport = {
    async queryOwnership(): Promise<TaskOwnership> {
      return { kind: "unknown_task" };
    },
  };
  const resultReporter: ResultReporter = {
    async report(report: ResultReport): Promise<ReportAck> {
      reports.push(report);
      const ack = config.reportAck ?? { accepted: true, state: "validating" };
      if (typeof ack === "object" && ack !== null && "fail" in ack) throw ack.fail;
      return ack as ReportAck;
    },
  };

  const deps: DaemonDeps = {
    health: async () => ({ ok: true }),
    registration,
    acquirer,
    lease_transport: leaseTransport,
    heartbeat_transport: heartbeatTransport,
    recovery_transport: recoveryTransport,
    result_reporter: resultReporter,
    attempt_runner: async () => config.outcome ?? makeOutcome(),
    push_branch: () =>
      config.pushResult ?? {
        pushed: true,
        error_code: null,
        message: null,
        local_sha: PUSH_SHA,
        remote_sha: PUSH_SHA,
      },
    ...fileReceiptStore(repoRoot),
    // 记录一份写入副本便于断言；真实文件同样会落盘。
    // 需要模拟写失败时由 `config.deps.write_report_receipt` 覆盖本项。
    write_report_receipt: (receipt) => {
      receipts.push(receipt);
      fileReceiptStore(repoRoot).write_report_receipt!(receipt);
    },
    ...config.deps,
  };

  const report = await runDaemon(
    makeOptions(repoRoot, { log: (line) => logs.push(line), ...config.options }),
    deps,
  );
  return { report, reports, receipts, logs };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "b18-receipt-"));
}

/** 递归收集对象里出现的所有键路径。 */
function collectKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectKeys(item, `${prefix}[${index}]`));
  const out: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push(`${prefix}/${key}`);
    out.push(...collectKeys(child, `${prefix}/${key}`));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. 成功上报 → 收据落盘
 * ------------------------------------------------------------------ */

describe("P1 收据：成功上报", () => {
  it("写入预期路径，且 http/ack/result_status/tests/evidence/commit 全部如实", async () => {
    const repoRoot = tempRepo();
    try {
      const { report, reports, receipts } = await runOnce(repoRoot, {
        reportAck: { accepted: true, state: "ready_for_integration", http_status: 200, http_attempts: 1 },
      });

      expect(report.stop_reason).toBe("idle_limit");
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0]!;

      expect(receipt.schema).toBe("executor-report-receipt/1");
      expect(receipt.task_id).toBe(TASK.task_id);
      expect(receipt.attempt_id).toBe(LEASE.attempt_id);
      expect(receipt.lease_epoch).toBe(4);
      expect(receipt.http).toEqual({ status: 200, attempts: 1 });
      expect(receipt.ack).toEqual({ accepted: true, state: "ready_for_integration" });
      // result_status 必须与**实际上报体**一致（这里是推送成功后保持的可整合）
      expect(receipt.result_status).toBe(reports[0]!.status);
      expect(receipt.result_status).toBe("ready_for_integration");
      expect(receipt.pushed).toBe(true);
      expect(receipt.commit_sha).toBe(PUSH_SHA);
      expect(receipt.remote_sha).toBe(PUSH_SHA);
      expect(receipt.tests).toEqual({ passed: 3, failed: 0, skipped: 0, summary_parsed: true });
      expect(receipt.evidence).toEqual({ evidence_id: "EVID-1", output_sha256: "1".repeat(64) });

      // 落盘位置与读回
      const path = reportReceiptPath(repoRoot, LEASE.attempt_id);
      expect(existsSync(path)).toBe(true);
      expect(path.startsWith(receiptsDir(repoRoot))).toBe(true);
      expect(readReportReceipt(repoRoot, LEASE.attempt_id)).toEqual(receipt);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("未推送时 commit_sha / remote_sha 一律为 null（区分「没推」与「推了」）", async () => {
    const repoRoot = tempRepo();
    try {
      const { receipts } = await runOnce(repoRoot, {
        options: { enable_push: false },
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.pushed).toBe(false);
      expect(receipts[0]!.commit_sha).toBeNull();
      expect(receipts[0]!.remote_sha).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. 状态码如实反映（重试后取最终值）
 * ------------------------------------------------------------------ */

interface FakeResponseSpec {
  status: number;
  body?: unknown;
}

class FakeFetch {
  private index = 0;
  constructor(private readonly script: FakeResponseSpec[]) {}
  async fetch(): Promise<Response> {
    const next = this.script[this.index] ?? this.script[this.script.length - 1]!;
    this.index += 1;
    const text = next.body === undefined ? "" : JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: () => null },
      text: async () => text,
    } as unknown as Response;
  }
}

describe("P1 收据：状态码如实反映", () => {
  it("503 → 200 的重试链记的是最终 200，且 attempts=2（不把首次 503 记成结果）", async () => {
    const fake = new FakeFetch([
      { status: 503, body: { error: "unavailable" } },
      { status: 200, body: { accepted: true, status: "validating" } },
    ]);
    const client = new CoordinatorClient(CONFIG, {
      fetch: fake.fetch.bind(fake),
      sleep: async () => {},
      random: () => 0.5,
      now: () => 1_700_000_000_000,
    });

    const ack = await new HttpResultReporter(client).report(makeReport());

    expect(ack.accepted).toBe(true);
    expect(ack.http_status).toBe(200);
    expect(ack.http_attempts).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 白名单
 * ------------------------------------------------------------------ */

describe("P1 收据：字段白名单", () => {
  it("收据里出现的每个键都在允许集合内", async () => {
    const repoRoot = tempRepo();
    try {
      const { receipts } = await runOnce(repoRoot, {
        reportAck: { accepted: true, state: "ready_for_integration", http_status: 200, http_attempts: 1 },
      });
      const receipt = receipts[0]! as unknown as Record<string, unknown>;

      const allowed = new Set<string>();
      for (const [prefix, keys] of Object.entries(RECEIPT_ALLOWED_KEYS)) {
        for (const key of keys) allowed.add(prefix === "" ? `/${key}` : `/${prefix}/${key}`);
      }

      for (const keyPath of collectKeys(receipt)) {
        expect(allowed.has(keyPath), `收据出现白名单外的键：${keyPath}`).toBe(true);
      }

      // 明确禁止项：即便将来有人往收据里塞这些字段，这条断言也会立刻失败
      const flat = JSON.stringify(receipt);
      for (const banned of ["raw_stdout", "raw_stderr", "raw_test_output", "prompt", "token", "authorization"]) {
        expect(flat).not.toContain(`"${banned}"`);
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. 泄漏哨兵
 * ------------------------------------------------------------------ */

describe("P1 收据：泄漏哨兵", () => {
  it("token / 原始测试输出 / prompt 三者都不出现在收据文件里（逐字节搜索）", async () => {
    const repoRoot = tempRepo();
    try {
      // 把哨兵塞进**所有可能被误带出来**的来源：token、原始输出、证据命令。
      const outcome = makeOutcome({
        raw_test_output: SENTINEL_RAW_OUTPUT,
        report: makeReport({
          evidence: {
            evidence_id: "EVID-1",
            command: ["node", "--test", SENTINEL_PROMPT],
            exit_code: 0,
            summary: { passed: 3, failed: 0, skipped: 0 },
            log_artifact: null,
            output_sha256: "2".repeat(64),
          },
        }),
      });
      await runOnce(repoRoot, {
        outcome,
        reportAck: { accepted: true, state: "validating", http_status: 200, http_attempts: 1 },
      });

      const bytes = readFileSync(reportReceiptPath(repoRoot, LEASE.attempt_id), "utf8");
      expect(bytes).not.toContain(SENTINEL_TOKEN);
      expect(bytes).not.toContain(SENTINEL_RAW_OUTPUT);
      expect(bytes).not.toContain(SENTINEL_PROMPT);

      // 而**纯摘要**必须在：这是唯一可供交叉核对、又不泄漏内容的量。
      expect(bytes).toContain("2".repeat(64));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. 跨 attempt 隔离
 * ------------------------------------------------------------------ */

describe("P1 收据：跨 attempt 隔离", () => {
  it("两个 attempt 各写一份、互不覆盖，文件数与 attempt 数一致", async () => {
    const repoRoot = tempRepo();
    try {
      const attemptA = "TASK-0001-A1";
      const attemptB = "TASK-0001-A2";
      const base = makeOutcome();
      const outcomeA: AttemptOutcome = {
        ...base,
        report: makeReport({ attempt_id: attemptA, status: "repair_pending", error_code: "TESTS_FAILED" }),
      };
      const outcomeB: AttemptOutcome = { ...base, report: makeReport({ attempt_id: attemptB }) };

      const first = await runOnce(repoRoot, {
        lease: { ...LEASE, attempt_id: attemptA },
        outcome: outcomeA,
        options: { max_attempts: 1 },
        reportAck: { accepted: true, state: "validating", http_status: 200, http_attempts: 1 },
      });
      const second = await runOnce(repoRoot, {
        lease: { ...LEASE, attempt_id: attemptB },
        outcome: outcomeB,
        options: { max_attempts: 1 },
        reportAck: { accepted: true, state: "validating", http_status: 200, http_attempts: 1 },
      });

      expect(first.receipts).toHaveLength(1);
      expect(second.receipts).toHaveLength(1);

      const files = readdirSync(receiptsDir(repoRoot)).filter((name) => name.endsWith(".json"));
      expect(files).toHaveLength(2);

      const readA = readReportReceipt(repoRoot, attemptA);
      const readB = readReportReceipt(repoRoot, attemptB);
      expect(readA?.attempt_id).toBe(attemptA);
      expect(readB?.attempt_id).toBe(attemptB);
      // A 那份没有被 B 覆盖
      expect(readA?.result_status).toBe("repair_pending");
      expect(readB?.result_status).toBe("ready_for_integration");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. 写失败降级
 * ------------------------------------------------------------------ */

describe("P1 收据：写失败降级", () => {
  it("收据写失败不影响 attempt 结果与停机判定，只多一行降级日志", async () => {
    const repoRoot = tempRepo();
    try {
      const { report, logs } = await runOnce(repoRoot, {
        deps: {
          write_report_receipt: () => {
            throw new Error("模拟磁盘写失败");
          },
        },
        reportAck: { accepted: true, state: "validating", http_status: 200, http_attempts: 1 },
      });

      expect(report.attempts).toHaveLength(1);
      expect(report.attempts[0]!.result).toBe("reported");
      expect(report.stop_reason).toBe("idle_limit");
      expect(logs.some((line) => line.includes("[receipt]") && line.includes("降级继续"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. 观察者异常
 * ------------------------------------------------------------------ */

describe("P1 收据：观察者异常", () => {
  it("on_response 抛错时请求结果与无观察者时逐字节相同", async () => {
    const script: FakeResponseSpec[] = [{ status: 200, body: { accepted: true, status: "validating" } }];
    const makeClientWith = (scripted: FakeResponseSpec[]): CoordinatorClient => {
      const fake = new FakeFetch(scripted);
      return new CoordinatorClient(CONFIG, {
        fetch: fake.fetch.bind(fake),
        sleep: async () => {},
        random: () => 0.5,
        now: () => 1_700_000_000_000,
      });
    };

    const plain = await makeClientWith(script).request({ method: "POST", path: "/x", body: { a: 1 } });
    const observed = await makeClientWith(script).request({
      method: "POST",
      path: "/x",
      body: { a: 1 },
      on_response: () => {
        throw new Error("观察者炸了");
      },
    });

    expect(JSON.stringify(observed)).toBe(JSON.stringify(plain));
  });
});

/* ------------------------------------------------------------------ *
 * 8. 失败路径不伪造
 * ------------------------------------------------------------------ */

describe("P1 收据：失败路径不伪造成功", () => {
  for (const status of [401, 403, 409]) {
    it(`HTTP ${status} 时收据 ack 为 null，且不出现 accepted:true`, async () => {
      const repoRoot = tempRepo();
      try {
        const failure = new CoordinatorHttpError({
          code: status === 409 ? "LEASE_EPOCH_STALE" : "AUTH_EXPIRED",
          message: `请求失败：HTTP ${status}`,
          status,
          retryable: false,
        });
        const { report, reports } = await runOnce(repoRoot, { reportAck: { fail: failure } });

        expect(report.attempts[0]!.result).toBe("failed_to_report");

        const raw = readFileSync(reportReceiptPath(repoRoot, LEASE.attempt_id), "utf8");
        const receipt = JSON.parse(raw) as ReportReceipt;
        expect(receipt.ack).toBeNull();
        expect(receipt.http.status).toBe(status);
        // result_status 来自**上报体**（不是应答），且必须带错误分类
        expect(receipt.result_status).toBe(reports[0]!.status);
        expect(receipt.error_code).toBe(reports[0]!.error_code);
        // 关键：整份收据里不存在 accepted:true
        expect(raw).not.toContain('"accepted":true');
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 9. 无自动删除
 * ------------------------------------------------------------------ */

describe("P1 收据：无自动删除", () => {
  it("attempt 结束后收据仍在磁盘上（无自动删除副作用）", async () => {
    const repoRoot = tempRepo();
    try {
      const { report } = await runOnce(repoRoot, {
        reportAck: { accepted: true, state: "validating", http_status: 200, http_attempts: 1 },
      });
      expect(report.stop_reason).toBe("idle_limit");
      expect(existsSync(reportReceiptPath(repoRoot, LEASE.attempt_id))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("常驻入口源码里不存在清理收据/审计的调用", () => {
    const daemonSource = fileURLToPath(new URL("../../apps/executor/src/daemon.ts", import.meta.url));
    const source = readFileSync(daemonSource, "utf8");
    // 自动删除只可能经由这两个显式清理入口发生；它们不得出现在常驻入口。
    expect(source).not.toContain("clearReportReceipt");
    expect(source).not.toContain("clearAuditJournal");
  });
});

/* ------------------------------------------------------------------ *
 * 构造器自身的边界
 * ------------------------------------------------------------------ */

describe("P1 收据：构造器护栏", () => {
  it("非白名单取值一律降级为 null（state/哈希/计数）", () => {
    const receipt = buildReportReceipt({
      task_id: "T",
      attempt_id: "T-A1",
      lease_epoch: 1,
      http_status: 200,
      http_attempts: 1,
      // state 含空格与标点 → 不是有界短标识 → null
      ack: { accepted: true, state: "ready for integration!" },
      report: makeReport({
        evidence: {
          evidence_id: "EVID-1",
          command: ["node", "--test"],
          exit_code: 0,
          summary: { passed: 1, failed: 0, skipped: 0 },
          log_artifact: null,
          // 不是 64 位小写 hex → null
          output_sha256: "NOT-A-SHA",
        },
      }),
      pushed: true,
      commit_sha: "not-a-sha",
      remote_sha: SHA_B,
    });

    expect(receipt.ack).toEqual({ accepted: true, state: null });
    expect(receipt.evidence?.output_sha256).toBeNull();
    expect(receipt.commit_sha).toBeNull();
    expect(receipt.remote_sha).toBe(SHA_B);
  });

  it("没有证据时 tests/evidence 为 null（不伪造 0/0/0）", () => {
    const receipt = buildReportReceipt({
      task_id: "T",
      attempt_id: "T-A1",
      lease_epoch: 1,
      http_status: 200,
      http_attempts: 1,
      ack: { accepted: true },
      report: makeReport({ evidence: null, evidence_id: null }),
      pushed: false,
      commit_sha: null,
      remote_sha: null,
    });
    expect(receipt.tests).toBeNull();
    expect(receipt.evidence).toBeNull();
  });

  it("写盘层再判：pushed 非 true 时，手工塞入的 commit_sha / remote_sha 一律降级 null（§七.1）", () => {
    // 先造一张「已推送」的合法收据（两个 SHA 均为 40 位 hex，形状合格）
    const pushedReceipt = buildReportReceipt({
      task_id: "T",
      attempt_id: "T-A1",
      lease_epoch: 1,
      http_status: 200,
      http_attempts: 1,
      ack: { accepted: true },
      report: makeReport({ evidence: null, evidence_id: null }),
      pushed: true,
      commit_sha: SHA_A,
      remote_sha: SHA_B,
    });
    expect(pushedReceipt.commit_sha).toBe(SHA_A);
    expect(pushedReceipt.remote_sha).toBe(SHA_B);

    // 绕过构造器，手工把 pushed 改成 false、但仍带着两个 SHA：
    // 这一层必须清成 null，否则「没推」的收据读起来像「推了」
    const tampered = sanitizeReportReceipt({ ...pushedReceipt, pushed: false });
    expect(tampered.pushed).toBe(false);
    expect(tampered.commit_sha).toBeNull();
    expect(tampered.remote_sha).toBeNull();

    // 反向对照：pushed:true 时两个 SHA 保留（证明不是把所有值一律抹掉）
    const kept = sanitizeReportReceipt({ ...pushedReceipt, pushed: true });
    expect(kept.commit_sha).toBe(SHA_A);
    expect(kept.remote_sha).toBe(SHA_B);

    // 再补一条：pushed:true 但 SHA 形状不合规 → 仍按形状判 null
    const badShape = sanitizeReportReceipt({
      ...pushedReceipt,
      pushed: true,
      commit_sha: "not-a-sha",
      remote_sha: "x",
    });
    expect(badShape.commit_sha).toBeNull();
    expect(badShape.remote_sha).toBeNull();
  });
});
