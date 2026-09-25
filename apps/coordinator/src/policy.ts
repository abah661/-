import { canRunInParallel, type TaskNode, type ResultReport } from "@dac/protocol";
import { ApiError } from "./api.js";

function safePath(path: string): boolean {
  return path.length > 0 && !/[\\:\x00-\x1f]/.test(path) &&
    !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

export function validatePlannedTask(task: TaskNode): void {
  if (task.status !== "ready" || task.assigned_executor !== null || task.attempts_used !== 0) {
    throw new ApiError(422, "TASK_GRAPH_INVALID", "新任务必须 ready、未分配且 attempts_used 为 0");
  }
  for (const path of [...task.write_scope.allow, ...task.write_scope.deny, ...task.contracts.map((c) => c.path)]) {
    if (!safePath(path)) throw new ApiError(422, "TASK_GRAPH_INVALID", "路径必须是规范的仓库相对路径");
  }
}

export function safelyParallel(a: TaskNode, b: TaskNode): boolean {
  // 两台 Windows 电脑的路径大小写不敏感；冻结协议的纯函数之外加保守保护。
  const lower = (task: TaskNode): TaskNode => ({
    ...task,
    write_scope: { ...task.write_scope, allow: task.write_scope.allow.map((p) => p.toLowerCase()) },
  });
  return canRunInParallel(lower(a), lower(b));
}

function matches(path: string, pattern: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { expression += "(?:.*/)?"; i += 2; }
      else { expression += ".*"; i++; }
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "i").test(path);
}

export function validateReadyReport(task: TaskNode, report: ResultReport): void {
  if (report.status !== "ready_for_integration") return;
  if (report.error_code !== null || !report.evidence || report.evidence_id !== report.evidence.evidence_id ||
      report.evidence.summary.passed < 1 || !report.commit_shas.includes(report.head_sha)) {
    throw new ApiError(422, "RESULT_SCHEMA_INVALID", "成功回报需一致证据 ID、实际通过用例、无错误和包含 head 的提交列表");
  }
  for (const path of report.changed_files) {
    if (!safePath(path) || !task.write_scope.allow.some((p) => matches(path, p)) ||
        task.write_scope.deny.some((p) => matches(path, p))) {
      throw new ApiError(422, "DIFF_OUT_OF_SCOPE", "结果声明包含越界路径");
    }
    if (/(^|\/)(\.env(?:\.[^/]*)?|auth\.json|credentials\.json|\.credentials\.json|id_rsa[^/]*|\.codex|\.git)(\/|$)/i.test(path) ||
        /\.(pem|key|p12|pfx|cer|p7m)$/i.test(path)) {
      throw new ApiError(422, "SENSITIVE_FILE_DETECTED", "结果声明包含敏感路径");
    }
  }
}
