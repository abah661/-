/**
 * 传输层导出面：HTTP 客户端 + 内核适配器。
 *
 * 分层意图：
 * - `http.ts` 只管「按契约发请求、分类错误、重试」
 * - `adapters.ts` 只管「把 HTTP 应答翻译成内核语义」
 * - `core/` 完全不知道 HTTP 的存在
 */

export * from "./http.js";
export * from "./adapters.js";
