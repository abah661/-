/**
 * @dac/protocol —— 协议 v1 的单一事实来源。
 *
 * 本包是 A 端（协调器 / Codex 适配器 / CLI）与 B 端（执行器内核 / OpenCode 适配器）
 * 共同依赖的唯一契约定义。双方不得各自复制一份类型定义。
 */

export * from "./version.js";
export * from "./status.js";
export * from "./errors.js";
export * from "./schemas.js";
export * from "./defaults.js";
export * from "./graph.js";
