/**
 * P2 回归：受控审计记录（B18 实施）。
 *
 * 对应方案 §7 的 9 条用例。核心纪律有两条，其余用例都服务于它们：
 * 1. **只追加**：不存在重写/截断/删除路径，常驻入口也不调用显式清理；
 * 2. **不改恢复语义**：`completed_phases` 仍是断点标记，审计记录**不回填**它。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Lease, ResultReport, TaskNode } from "@dac/protocol";
import type { AttemptOutcome } from "../../apps/executor/src/core/attempt.js";
import type { HeartbeatRequest, HeartbeatTransport } from "../../apps/executor/src/core/heartbeat.js";
import type { LeaseTransport, RenewOutcome } from "../../apps/executor/src/core/lease.js";
import type { InFlightRecord, RecoveryTransport, TaskOwnership } from "../../apps/executor/src/core/recovery.js";
import { auditDir, auditJournalPath, openAuditJournal, readAuditJournal } from "../../apps/executor/src/core/audit.js";
import type { AuditBase } from "../../apps/executor/src/core/audit.js";
import { buildReportReceipt, writeReportReceipt, receiptsDir } from "../../apps/executor/src/core/receipts.js";
import { main as auditReadMain } from "../../apps/executor/src/audit-read.js";
import type {
  LeaseAcquirer,
  LeaseAcquisition,
  RegistrationTransport,
  ReportAck,
  ResultReporter,
} from "../../apps/executor/src/transport/adapters.js";
import type { ExecutorConfig } from "../../apps/executor/src/transport/http.js";
import { fileAuditStore, fileInFlightStore, fileReceiptStore, runDaemon } from "../../apps/executor/src/daemon.js";
import type { DaemonDeps, DaemonOptions, PushResult } from "../../apps/executor/src/daemon.js";

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const SENTINEL_TOKEN = "SENTINEL-TOKEN-9f3c7a1d";
const SENTINEL_TAP = "SENTINEL-TAP-v13-pass-42";
const SENTINEL_PROMPT = "SENTINEL-PROMPT-internal-instructions";

const BASE: AuditBase = { task_id: "TASK-0001", attempt_id: "TASK-0001-A1", lease_epoch: 4 };

const BINDING = {
  base_sha: SHA_A,
  rules_sha: SHA_B,
  contract_sha: "c".repeat(40),
  acceptance_sha: "d".repeat(40),
};

const LEASE: Lease = {
  task_id: BASE.task_id,
  attempt_id: BASE.attempt_id,
  executor_id: "EXE-B-OPENCODE",
  lease_epoch: BASE.lease_epoch,
  expires_at: "2030-01-01T00:00:00.000Z",
  binding: BINDING,
  agent_kind: "opencode",
};

const TASK: TaskNode = {
  task_id: BASE.task_id,
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
    raw_test_output: SENTINEL_TAP,
    ...overrides,
  };
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "b18-audit-"));
}

function auditSource(): string {
  return readFileSync(fileURLToPath(new URL("../../apps/executor/src/core/audit.ts", import.meta.url)), "utf8");
}

function daemonSource(): string {
  return readFileSync(fileURLToPath(new URL("../../apps/executor/src/daemon.ts", import.meta.url)), "utf8");
}

/* ------------------------------------------------------------------ *
 * 1. 追加语义
 * ------------------------------------------------------------------ */

describe("P2 审计：追加语义", () => {
  it("三次追加得到三行，且前两行逐字节未被后续追加改动", () => {
    const repoRoot = tempRepo();
    try {
      const journal = openAuditJournal(repoRoot, BASE);
      journal.append({ event: "phase", phase: "preparing_worktree" });
      journal.append({ event: "phase", phase: "running_agent" });

      const snapshot = readFileSync(auditJournalPath(repoRoot, BASE.attempt_id), "utf8");
      journal.append({ event: "phase", phase: "running_tests" });
      const after = readFileSync(auditJournalPath(repoRoot, BASE.attempt_id), "utf8");

      // 前缀逐字节相同 == 既有行未被重写
      expect(after.startsWith(snapshot)).toBe(true);
      expect(after.trim().split("\n")).toHaveLength(3);

      const parsed = readAuditJournal(repoRoot, BASE.attempt_id);
      expect(parsed.error).toBeNull();
      expect(parsed.tail_parse_error).toBe(false);
      expect(parsed.records.map((record) => record.seq)).toEqual([1, 2, 3]);
      expect(parsed.records.map((record) => record.phase)).toEqual([
        "preparing_worktree",
        "running_agent",
        "running_tests",
      ]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("seq 从已有可解析行数续号（重启后继续追加不重号）", () => {
    const repoRoot = tempRepo();
    try {
      openAuditJournal(repoRoot, BASE).append({ event: "phase", phase: "preparing_worktree" });
      const reopened = openAuditJournal(repoRoot, BASE);
      reopened.append({ event: "phase", phase: "running_agent" });
      const parsed = readAuditJournal(repoRoot, BASE.attempt_id);
      expect(parsed.records.map((record) => record.seq)).toEqual([1, 2]);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. 只追加不删除（源码约束）
 * ------------------------------------------------------------------ */

describe("P2 审计：只追加，无重写/截断路径", () => {
  it("模块内只有 appendFileSync，不存在 writeFileSync（覆盖式）与 truncate", () => {
    const source = auditSource();
    expect(source).toContain("appendFileSync");
    expect(source).not.toContain("writeFileSync");
    expect(source).not.toContain("truncate");
  });

  it("常驻入口不调用显式清理", () => {
    const source = daemonSource();
    expect(source).not.toContain("clearAuditJournal");
    expect(source).not.toContain("clearReportReceipt");
  });
});

/* ------------------------------------------------------------------ *
 * 3. detail 护栏
 * ------------------------------------------------------------------ */

describe("P2 审计：detail 禁自由文本", () => {
  it("自由文本 / 超长串 / 含换行串一律落盘为 null，且换行不被注入成新行", () => {
    const repoRoot = tempRepo();
    try {
      const onError = vi.fn();
      const journal = openAuditJournal(repoRoot, BASE, { on_error: onError });

      journal.append({ event: "phase", phase: "running_tests", outcome: "echo hello && rm -rf /" });
      journal.append({ event: "phase", phase: "running_agent", outcome: "x".repeat(64) });
      journal.append({ event: "phase", phase: "committing", outcome: "a\nb" });

      const raw = readFileSync(auditJournalPath(repoRoot, BASE.attempt_id), "utf8");
      expect(raw.trim().split("\n")).toHaveLength(3);
      const records = readAuditJournal(repoRoot, BASE.attempt_id).records;
      expect(records).toHaveLength(3);
      expect(records.every((record) => record.outcome === null)).toBe(true);
      // 降级日志必须留痕（不静默丢信息）
      expect(onError).toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("合法短标识（如 exit_0）原样保留", () => {
    const repoRoot = tempRepo();
    try {
      openAuditJournal(repoRoot, BASE).append({
        event: "phase",
        phase: "running_tests",
        outcome: "exit_0",
      });
      expect(readAuditJournal(repoRoot, BASE.attempt_id).records[0]!.outcome).toBe("exit_0");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. 敏感哨兵
 * ------------------------------------------------------------------ */

describe("P2 审计：敏感哨兵", () => {
  it("哨兵 token / TAP 文本 / prompt 都不出现在日志文件里", () => {
    const repoRoot = tempRepo();
    try {
      const journal = openAuditJournal(repoRoot, BASE);
      journal.append({ event: "phase", phase: "running_tests", outcome: SENTINEL_TAP });
      journal.append({ event: "phase", phase: "running_agent", outcome: SENTINEL_TOKEN });
      journal.append({ event: "phase", phase: "preparing_worktree", outcome: SENTINEL_PROMPT });

      const raw = readFileSync(auditJournalPath(repoRoot, BASE.attempt_id), "utf8");
      expect(raw).not.toContain(SENTINEL_TOKEN);
      expect(raw).not.toContain(SENTINEL_TAP);
      expect(raw).not.toContain(SENTINEL_PROMPT);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("经常驻入口跑一遍后，日志里同样没有原始测试输出的哨兵", async () => {
    const repoRoot = tempRepo();
    try {
      await runDaemonOnce(repoRoot, { withRealAudit: true });
      const raw = readFileSync(auditJournalPath(repoRoot, LEASE.attempt_id), "utf8");
      expect(raw).not.toContain(SENTINEL_TAP);
      expect(raw).not.toContain(SENTINEL_TOKEN);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. 跨 attempt 隔离
 * ------------------------------------------------------------------ */

describe("P2 审计：跨 attempt 隔离", () => {
  it("两个 attempt 各写自己的文件，内容互不污染", () => {
    const repoRoot = tempRepo();
    try {
      const baseA: AuditBase = { task_id: "T", attempt_id: "T-A1", lease_epoch: 1 };
      const baseB: AuditBase = { task_id: "T", attempt_id: "T-A2", lease_epoch: 2 };
      openAuditJournal(repoRoot, baseA).append({ event: "terminal", state: "reported" });
      openAuditJournal(repoRoot, baseB).append({ event: "terminal", state: "failed_to_report" });

      const files = readdirSync(auditDir(repoRoot)).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(2);

      const recordsA = readAuditJournal(repoRoot, "T-A1").records;
      const recordsB = readAuditJournal(repoRoot, "T-A2").records;
      expect(recordsA).toHaveLength(1);
      expect(recordsB).toHaveLength(1);
      expect(recordsA[0]!.attempt_id).toBe("T-A1");
      expect(recordsA[0]!.state).toBe("reported");
      expect(recordsB[0]!.state).toBe("failed_to_report");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. 截断尾行
 * ------------------------------------------------------------------ */

describe("P2 审计：崩溃截断（fail-closed）", () => {
  it("尾行不可解析时明示并丢弃，reader 返回 tail_parse_error 且 CLI 非零退出", async () => {
    const repoRoot = tempRepo();
    try {
      const journal = openAuditJournal(repoRoot, BASE);
      journal.append({ event: "phase", phase: "preparing_worktree" });
      journal.append({ event: "phase", phase: "running_agent" });
      // 模拟进程被杀：追加半行
      const path = auditJournalPath(repoRoot, BASE.attempt_id);
      writeFileSync(path, `${readFileSync(path, "utf8")}{"schema":"executor-audit/1","seq":3,"at":"202`, "utf8");

      const parsed = readAuditJournal(repoRoot, BASE.attempt_id);
      expect(parsed.error).toBeNull();
      expect(parsed.tail_parse_error).toBe(true);
      expect(parsed.records).toHaveLength(2);

      const code = await auditReadMain(["--attempt", BASE.attempt_id, "--repo", repoRoot]);
      expect(code).not.toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("中间坏行（非尾行）判为日志不可信，拒绝采信", () => {
    const repoRoot = tempRepo();
    try {
      const journal = openAuditJournal(repoRoot, BASE);
      journal.append({ event: "phase", phase: "preparing_worktree" });
      journal.append({ event: "phase", phase: "running_agent" });
      const path = auditJournalPath(repoRoot, BASE.attempt_id);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      writeFileSync(path, `${lines[0]}\n{"broken":true}\n${lines[1]}\n`, "utf8");

      const parsed = readAuditJournal(repoRoot, BASE.attempt_id);
      expect(parsed.error).not.toBeNull();
      expect(parsed.records).toHaveLength(1);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. 与收据一致性（--verify 灵敏度自证）
 * ------------------------------------------------------------------ */

describe("P2 审计：--verify 与收据交叉核对", () => {
  function seed(repoRoot: string, receiptHttpStatus: number): void {
    openAuditJournal(repoRoot, BASE).append({
      event: "report",
      http_status: 200,
      accepted: true,
      result_status: "ready_for_integration",
    });
    writeReportReceipt(
      repoRoot,
      buildReportReceipt({
        task_id: BASE.task_id,
        attempt_id: BASE.attempt_id,
        lease_epoch: BASE.lease_epoch,
        http_status: receiptHttpStatus,
        http_attempts: 1,
        ack: { accepted: true, state: "ready_for_integration" },
        report: makeReport(),
        pushed: false,
        commit_sha: null,
        remote_sha: null,
      }),
    );
  }

  it("一致时退出 0", async () => {
    const repoRoot = tempRepo();
    try {
      seed(repoRoot, 200);
      expect(await auditReadMain(["--verify", BASE.attempt_id, "--repo", repoRoot])).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("注入不一致（收据 503 vs 审计 200）时必须报错退出非零", async () => {
    const repoRoot = tempRepo();
    try {
      seed(repoRoot, 503);
      const code = await auditReadMain(["--verify", BASE.attempt_id, "--repo", repoRoot]);
      expect(code).not.toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("收据缺失时也必须非零退出（不猜结论）", async () => {
    const repoRoot = tempRepo();
    try {
      openAuditJournal(repoRoot, BASE).append({
        event: "report",
        http_status: 200,
        accepted: true,
        result_status: "ready_for_integration",
      });
      expect(await auditReadMain(["--verify", BASE.attempt_id, "--repo", repoRoot])).not.toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 8. 失败不阻断
 * ------------------------------------------------------------------ */

describe("P2 审计：写失败不阻断", () => {
  it("打开审计日志抛错时 attempt 结果与停机判定不变", async () => {
    const repoRoot = tempRepo();
    try {
      const { report, logs } = await runDaemonOnce(repoRoot, { breakOpen: true });
      expect(report.attempts[0]!.result).toBe("reported");
      expect(report.stop_reason).toBe("idle_limit");
      expect(logs.some((line) => line.includes("[audit]"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("append 抛错时 attempt 结果与停机判定不变", async () => {
    const repoRoot = tempRepo();
    try {
      const { report, logs } = await runDaemonOnce(repoRoot, { breakAppend: true });
      expect(report.attempts[0]!.result).toBe("reported");
      expect(report.stop_reason).toBe("idle_limit");
      expect(logs.some((line) => line.includes("[audit]") && line.includes("降级继续"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 9. 不改恢复语义
 * ------------------------------------------------------------------ */

describe("P2 审计：不改恢复语义", () => {
  it("引入审计后 completed_phases / local_commits 仍为空，且与审计记录分目录", async () => {
    const repoRoot = tempRepo();
    try {
      const { saved } = await runDaemonOnce(repoRoot, { withRealAudit: true });
      expect(saved.length).toBeGreaterThan(0);
      for (const record of saved) {
        expect(record.completed_phases).toEqual([]);
        expect(record.local_commits).toEqual([]);
      }
      // 审计记录与恢复记录**物理分开**
      expect(auditDir(repoRoot)).not.toBe(receiptsDir(repoRoot));
      expect(existsSync(auditJournalPath(repoRoot, LEASE.attempt_id))).toBe(true);
      expect(existsSync(join(repoRoot, ".local", "executor-attempts"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ *
 * 常驻入口夹具
 * ------------------------------------------------------------------ */

interface RunOptions {
  /** 使用真实的文件审计实现 */
  withRealAudit?: boolean;
  /** 让 open_audit_journal 抛错 */
  breakOpen?: boolean;
  /** 让 append 抛错 */
  breakAppend?: boolean;
}

async function runDaemonOnce(
  repoRoot: string,
  options: RunOptions = {},
): Promise<{ report: Awaited<ReturnType<typeof runDaemon>>; logs: string[]; saved: InFlightRecord[] }> {
  const logs: string[] = [];
  const saved: InFlightRecord[] = [];
  let acquireIndex = 0;
  const script: LeaseAcquisition[] = [{ kind: "leased", task: TASK, lease: LEASE }];

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
  const heartbeatTransport: HeartbeatTransport = { async send(_r: HeartbeatRequest): Promise<void> {} };
  const recoveryTransport: RecoveryTransport = {
    async queryOwnership(): Promise<TaskOwnership> {
      return { kind: "unknown_task" };
    },
  };
  const resultReporter: ResultReporter = {
    async report(): Promise<ReportAck> {
      return { accepted: true, state: "validating", http_status: 200, http_attempts: 1 };
    },
  };

  const auditSink: Partial<DaemonDeps> = options.breakOpen
    ? {
        open_audit_journal: () => {
          throw new Error("模拟打开审计日志失败");
        },
      }
    : options.breakAppend
      ? {
          open_audit_journal: () => ({
            path: "in-memory",
            append: () => {
              throw new Error("模拟追加失败");
            },
          }),
        }
      : options.withRealAudit
        ? fileAuditStore(repoRoot)
        : {};

  const deps: DaemonDeps = {
    health: async () => ({ ok: true }),
    registration,
    acquirer,
    lease_transport: leaseTransport,
    heartbeat_transport: heartbeatTransport,
    recovery_transport: recoveryTransport,
    result_reporter: resultReporter,
    // 假编排：主动驱动 on_phase，验证阶段轨迹的接线（真实编排同一条路径）。
    attempt_runner: async (_input, attemptDeps) => {
      attemptDeps.on_phase?.("preparing_worktree");
      attemptDeps.on_phase?.("running_agent", SENTINEL_PROMPT);
      attemptDeps.on_phase?.("running_tests", "exit_0");
      attemptDeps.on_phase?.("reporting");
      return makeOutcome();
    },
    push_branch: (): PushResult => ({
      pushed: false,
      error_code: null,
      message: null,
      local_sha: null,
      remote_sha: null,
    }),
    load_in_flight_records: () => [],
    load_in_flight: () => null,
    // 真实写盘（这样「审计与恢复记录分目录」是可验证的事实），同时留一份副本。
    ...fileInFlightStore(repoRoot),
    ...fileReceiptStore(repoRoot),
    ...auditSink,
  };
  // 包一层以便断言在途记录内容；底层仍是真实的文件实现。
  const realSave = deps.save_in_flight;
  deps.save_in_flight = (record) => {
    saved.push(record);
    realSave?.(record);
  };

  const daemonOptions: DaemonOptions = {
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
    enable_push: false,
    log: (line) => logs.push(line),
  };

  const report = await runDaemon(daemonOptions, deps);
  return { report, logs, saved };
}
