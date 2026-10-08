/**
 * @dac/executor —— Windows 执行器（B 端负责）。
 *
 * 第 8 节流程的落地结构：
 *   core/      公共内核：Git/worktree、进程控制、租约、心跳、恢复、证据
 *   adapters/  适配器：OpenCode（本端）；Codex 由 A 端提供，此处留有对齐接口
 *   result/    结果归一化为协议 ResultReport
 *   daemon.ts  **常驻入口**：领取→续租/心跳→执行→校验→推送→上报
 *
 * 本包**只依赖** `@dac/protocol`，不复制任何类型定义。
 *
 * 注意：本文件是**纯导出面**，`import` 它不会启动任何进程。
 * 要真正跑起来用 `npm run start -w @dac/executor`（入口是 `daemon.ts`）。
 */

export * from "./core/index.js";
export * from "./adapters/index.js";
export * from "./transport/index.js";
export * from "./result/index.js";
export * from "./daemon.js";
