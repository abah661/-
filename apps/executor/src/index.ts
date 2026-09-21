/**
 * @dac/executor —— Windows 执行器（B 端负责）。
 *
 * 第 8 节流程的落地结构：
 *   core/      公共内核：Git/worktree、进程控制、租约、心跳、恢复、证据
 *   adapters/  适配器：OpenCode（本端）；Codex 由 A 端提供，此处留有对齐接口
 *   result/    结果归一化为协议 ResultReport
 *
 * 本包**只依赖** `@dac/protocol`，不复制任何类型定义。
 */

export * from "./core/index.js";
export * from "./adapters/index.js";
export * from "./result/index.js";
