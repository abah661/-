/**
 * 协议版本与冻结元数据。
 *
 * 第 6 节：接口契约一经冻结，双方按同一版本并行开发。
 * 任何字段增删或语义变化都必须走版本化变更提案，不能由一端私自修改。
 */

/** 当前协议主版本。结果与请求载荷中的 `protocol_version` 必须等于此值。 */
export const PROTOCOL_VERSION = "1" as const;

/** 协议冻结状态。frozen 表示双方已确认按此版本并行开发。 */
export type ProtocolStatus = "draft" | "frozen" | "superseded";

export interface ProtocolMeta {
  version: string;
  status: ProtocolStatus;
  /**
   * 冻结时的 git 提交号；未冻结时为 null。
   * 冻结校验会要求它是完整的 40 位 SHA。
   */
  frozenAt: string | null;
  /**
   * 冻结时 `packages/protocol/` 子树的树哈希。
   *
   * 注意：这是**子树**哈希，不是仓库根树哈希。
   * 用 `git rev-parse "<frozenAt>:packages/protocol"` 获取，
   * 它只随协议包内容变化，不随其他目录的改动而变——
   * 这正是核对"协议未被悄悄改动"所需要的。
   *
   * 自引用说明：本文件（version.ts）自己也在被冻结的子树之内，
   * 因此"写入冻结记录"这个动作本身就会改变子树哈希——冻结点之后的
   * `HEAD:packages/protocol` **不会**等于此值，这是预期行为，不是错误。
   * 所以此字段定义为"冻结点自身子树的事实快照"，供下面这条校验使用：
   * `git rev-parse "<frozenAt>:packages/protocol" === frozenTreeSha`；
   * 而"冻结后有没有人改协议"由 freeze.test.ts 逐文件比对（排除本文件）来保证。
   */
  frozenTreeSha: string | null;
  /** 已落地的变更提案 ID，例如 CP-0003。空数组表示仍是初始版本。 */
  changeProposals: string[];
}

/**
 * 协议冻结信息。变更提案落地时同步更新，并记录批准依据。
 *
 * 注意：不要给整个 `PROTOCOL_META` 加 `as const`——它会把 `status` 收窄成
 * 字面量类型，导致下游的冻结状态校验变成编译期死代码（tsc 会报 TS2367）。
 * 用上面的 `interface ProtocolMeta` 显式标注即可。
 *
 * 冻结记录：
 * - v1 由双方确认冻结于 2026-09-21。
 * - 冻结点提交 `frozenAt` 是一个**冻结前**的快照（当时 status 仍为 draft）；
 *   冻结动作本身只改动了本文件，其余协议文件自冻结点起逐字节未变。
 * - B 端（OpenCode）已完成 Windows/OpenCode 可实现性核对，并确认样例可复现。
 * - 冻结后任何字段增删或语义变化必须走 `docs/protocol-changes.md` 的提案流程。
 */
export const PROTOCOL_META: ProtocolMeta = {
  version: PROTOCOL_VERSION,
  status: "frozen",
  frozenAt: "a577d6688b323afbdbc647b3a1288c0316f7fb1e",
  frozenTreeSha: "f9644c44628d5fe8445bcbbb54ad336d7fbe0abc",
  changeProposals: [],
};

/**
 * 幂等键的作用域前缀。写请求必须携带幂等键，服务端按此作用域去重。
 * 第 7 节：写请求使用幂等键，回调验证签名并去重。
 */
export const IDEMPOTENCY_SCOPES = [
  "register_executor",
  "submit_requirement",
  "lease_task",
  "renew_lease",
  "report_result",
  "contract_proposal",
  "github_event",
] as const;

export type IdempotencyScope = (typeof IDEMPOTENCY_SCOPES)[number];
