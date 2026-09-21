/**
 * 适配器导出面。
 *
 * 第 8 节末：「启动、恢复、停止、错误映射分别验证后，再归一成同一种结果。」
 * 因此这里只负责「调起 agent 并给出结构化结果」，
 * 归一化（→ ResultReport）统一在 `../result/normalize.ts` 完成。
 */

export * from "./opencode.js";
