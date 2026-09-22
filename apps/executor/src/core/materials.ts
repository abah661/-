/**
 * 同伴资料包的校验与读取（《项目书》第 10.2 / 10.3 节，验收 V15 / V16）。
 *
 * 规则来源（逐条对应，不自行发明）：
 * - 10.2「多个文件不是一次同步事务。接收方应等待清单中**所有文件齐全且哈希通过**，
 *   再将资料包标记可用；缺少附件则**等待或报告，不假装已读**。」          → V16
 * - 10.2「每份资料记录 SHA-256，任务**只使用绑定哈希的版本**，不能在运行途中
 *   悄悄读取另一份『最新资料』。」                                        → V15
 * - 10.2 命名建议：`<TASK_ID>/<ARTIFACT_ID>-<REVISION>.<EXT>`，
 *   发布后不原地修改，「新增版本替代」。
 * - 10.3「冲突文件**不能**自动作为正式输入。」
 * - P3「验证同伴资料**只能按清单读取，不能覆盖活动源码**。」
 * - 10.3「关闭 Syncthing 不应阻断不依赖附件的代码任务。涉及必要附件的任务
 *   必须等附件到齐。」
 *
 * 设计要点：
 * - 校验**只读**：本模块绝不写、移、删同步目录里的任何文件。
 * - 路径**必须**留在同步根内（含中文相似前缀的坑，见下）。
 * - 清单格式由外部解析（`parseManifest`）注入，默认实现接受 JSON，
 *   待 A 端确认格式后只换解析器、不动校验逻辑。
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/* ------------------------------------------------------------------ *
 * 清单的数据形状
 * ------------------------------------------------------------------ */

/** 清单中的一个资料条目。 */
export interface MaterialEntry {
  /** 资料 ID，例如 `DESIGN-001` */
  artifact_id: string;
  /** 版本号；发布后不原地修改，靠新版本替代（10.2） */
  revision: number | string;
  /** 相对同步根目录的路径，形如 `<TASK_ID>/<ARTIFACT_ID>-<REVISION>.<EXT>` */
  path: string;
  /** 期望的 SHA-256（64 位小写十六进制） */
  sha256: string;
  /** 期望字节数；可选，用于快速发现截断 */
  size?: number;
  /** 是否为该任务的**必要**附件。必要附件缺失 → 任务必须等待（10.3） */
  required?: boolean;
}

/** 一份资料包清单。 */
export interface MaterialManifest {
  task_id: string;
  /** 清单自身版本，便于审计 */
  revision?: number | string;
  entries: readonly MaterialEntry[];
}

/* ------------------------------------------------------------------ *
 * 清单解析（可替换入口）
 * ------------------------------------------------------------------ */

/** 清单解析失败时抛出的错误，调用方据此报 `needs_input`。 */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

export type ManifestParser = (raw: string) => MaterialManifest;

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * 默认清单解析器：接受 JSON。
 *
 * **格式待 A 端确认**（见 docs/handoff/B-status-and-pending.md §4.4）。
 * 一旦确认，只需替换此函数或向 `validateMaterials` 传入自定义 `parse`，
 * 校验逻辑不受影响。
 */
export const parseManifestJson: ManifestParser = (raw: string): MaterialManifest => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ManifestParseError(`清单不是合法 JSON：${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new ManifestParseError("清单根节点必须是对象");
  }
  const obj = value as Record<string, unknown>;
  const taskId = obj["task_id"];
  if (typeof taskId !== "string" || taskId.trim() === "") {
    throw new ManifestParseError("清单缺少非空字符串字段 task_id");
  }
  const rawEntries = obj["entries"];
  if (!Array.isArray(rawEntries)) {
    throw new ManifestParseError("清单缺少数组字段 entries");
  }

  const entries: MaterialEntry[] = rawEntries.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new ManifestParseError(`entries[${index}] 必须是对象`);
    }
    const e = item as Record<string, unknown>;
    const artifactId = e["artifact_id"];
    const revision = e["revision"];
    const path = e["path"];
    const sha256 = e["sha256"];
    if (typeof artifactId !== "string" || artifactId.trim() === "") {
      throw new ManifestParseError(`entries[${index}].artifact_id 必须是非空字符串`);
    }
    if (typeof revision !== "number" && typeof revision !== "string") {
      throw new ManifestParseError(`entries[${index}].revision 必须是数字或字符串`);
    }
    if (typeof path !== "string" || path.trim() === "") {
      throw new ManifestParseError(`entries[${index}].path 必须是非空字符串`);
    }
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      throw new ManifestParseError(
        `entries[${index}].sha256 必须是 64 位小写十六进制；收到：${String(sha256)}`,
      );
    }
    const size = e["size"];
    if (size !== undefined && (typeof size !== "number" || !Number.isInteger(size) || size < 0)) {
      throw new ManifestParseError(`entries[${index}].size 必须是非负整数`);
    }
    const required = e["required"];
    if (required !== undefined && typeof required !== "boolean") {
      throw new ManifestParseError(`entries[${index}].required 必须是布尔值`);
    }
    return {
      artifact_id: artifactId,
      revision,
      path,
      sha256,
      ...(typeof size === "number" ? { size } : {}),
      ...(typeof required === "boolean" ? { required } : {}),
    };
  });

  return {
    task_id: taskId,
    ...(typeof obj["revision"] === "number" || typeof obj["revision"] === "string"
      ? { revision: obj["revision"] as number | string }
      : {}),
    entries,
  };
};

/* ------------------------------------------------------------------ *
 * 路径安全
 * ------------------------------------------------------------------ */

/**
 * 目标路径是否确实位于同步根之下。
 *
 * **必须补分隔符再比较**：否则 `"同步根-备份"` 会被误判为 `"同步根"` 的子目录。
 * 中文目录名尤其容易踩到（例如 `双端连接` 与 `双端连接2`）。
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  if (r === c) return false; // 清单条目必须是**文件**，不能就是根目录本身
  const withSep = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(withSep);
}

/** 冲突副本文件名特征（Syncthing 用 `sync-conflict` 标记）。 */
const CONFLICT_RE = /sync-conflict|\.conflict\.|-conflict-/i;

/** 判断一个相对路径是否是同步冲突副本。冲突文件不能作为正式输入（10.3）。 */
export function isConflictCopy(relativePath: string): boolean {
  return CONFLICT_RE.test(relativePath);
}

/* ------------------------------------------------------------------ *
 * 哈希计算
 * ------------------------------------------------------------------ */

/** 计算文件的 SHA-256（流式，避免大文件占内存）。 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve_, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve_(hash.digest("hex")));
  });
}

/** 计算内存中内容的 SHA-256。 */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

/** 单个条目的校验结果。 */
export type EntryState =
  /** 文件存在、大小与哈希都符合 */
  | "ok"
  /** 文件不存在 */
  | "missing"
  /** 哈希不符（内容被改过，或读到了另一份「最新资料」） */
  | "hash_mismatch"
  /** 大小不符（截断/部分同步） */
  | "size_mismatch"
  /** 路径越出同步根，拒绝读取 */
  | "out_of_root"
  /** 是同步冲突副本，不能作为正式输入 */
  | "conflict_copy";

export interface EntryResult {
  entry: MaterialEntry;
  state: EntryState;
  /** 实际读到的哈希，state=ok 时与 entry.sha256 相同 */
  actual_sha256: string | null;
  actual_size: number | null;
  /** 该条目是否被清单标记为必要附件 */
  required: boolean;
  /** 人可读的原因，用于上报 note */
  detail: string;
}

/** 整包校验结果。 */
export interface MaterialValidationResult {
  task_id: string;
  /** 包是否**可用**：所有条目都 ok 才算可用（10.2） */
  usable: boolean;
  entries: readonly EntryResult[];
  /** 不可用的条目 */
  problems: readonly EntryResult[];
  /**
   * 是否因**必要附件**缺失/不符而必须等待。
   * true 时调用方应报 `needs_input` 等待，而不是当作「没读到就算了」（10.3）。
   */
  waiting_for_required: boolean;
  /** 若可用，返回可用于 agent 注入的绝对路径（**只在清单范围内**，P3） */
  available_paths: readonly string[];
  /** 供上报的简短说明，不含敏感路径细节 */
  summary: string;
}

export interface ValidateMaterialsInput {
  /** 同步根目录（发布/接收目录） */
  sync_root: string;
  /** 清单（已解析） */
  manifest: MaterialManifest;
  /**
   * 期望的任务 ID。提供时若与清单不符则整体拒绝——
   * 防止把别的任务的资料包当成自己的输入。
   */
  expect_task_id?: string;
  /** 自定义清单解析器（格式待 A 端确认时使用） */
  parse?: ManifestParser;
  /**
   * 计算哈希的注入点，便于测试；默认走真实文件流。
   * 返回 `{sha256,size}`，文件不存在时返回 null。
   */
  probe?: (absolutePath: string) => Promise<{ sha256: string; size: number } | null>;
}

async function defaultProbe(
  absolutePath: string,
): Promise<{ sha256: string; size: number } | null> {
  if (!existsSync(absolutePath)) return null;
  const stat = statSync(absolutePath);
  if (!stat.isFile()) return null;
  const sha256 = await hashFile(absolutePath);
  return { sha256, size: stat.size };
}

/**
 * 校验一份资料包。
 *
 * **纯读取**：不写、不移、不删同步目录里的任何东西（10.3 的删除语义要求人工批准）。
 *
 * 判定顺序刻意如此：先做**不需要 IO 的**检查（越界、冲突副本），
 * 再做文件级检查——这样路径不安全的条目不会被读入。
 */
export async function validateMaterials(
  input: ValidateMaterialsInput,
): Promise<MaterialValidationResult> {
  const { sync_root: syncRoot, manifest } = input;
  const probe = input.probe ?? defaultProbe;

  if (input.expect_task_id !== undefined && manifest.task_id !== input.expect_task_id) {
    return {
      task_id: manifest.task_id,
      usable: false,
      entries: [],
      problems: [],
      waiting_for_required: false,
      available_paths: [],
      summary: `资料包属于任务 ${manifest.task_id}，与期望的 ${input.expect_task_id} 不符，整体拒绝`,
    };
  }

  const entries: EntryResult[] = [];
  const availablePaths: string[] = [];

  for (const entry of manifest.entries) {
    const required = entry.required ?? false;
    const absolute = isAbsolute(entry.path)
      ? resolve(entry.path)
      : resolve(syncRoot, entry.path);

    const base: { actual_sha256: string | null; actual_size: number | null } = {
      actual_sha256: null,
      actual_size: null,
    };

    // 1) 冲突副本：不读，直接判不可用（10.3）
    if (isConflictCopy(entry.path)) {
      entries.push({
        entry,
        state: "conflict_copy",
        ...base,
        required,
        detail: "是同步冲突副本，不能作为正式输入",
      });
      continue;
    }

    // 2) 越界路径：不读，直接拒（P3「只能按清单读取」）
    if (!isInsideRoot(syncRoot, absolute)) {
      entries.push({
        entry,
        state: "out_of_root",
        ...base,
        required,
        detail: "路径越出同步根目录，拒绝读取",
      });
      continue;
    }

    // 3) 文件级检查
    const probed = await probe(absolute);
    if (probed === null) {
      entries.push({
        entry,
        state: "missing",
        ...base,
        required,
        detail: "清单列出的文件不存在",
      });
      continue;
    }

    if (entry.size !== undefined && probed.size !== entry.size) {
      entries.push({
        entry,
        state: "size_mismatch",
        actual_sha256: probed.sha256,
        actual_size: probed.size,
        required,
        detail: `大小不符：期望 ${entry.size}，实际 ${probed.size}（可能未同步完或已截断）`,
      });
      continue;
    }

    if (probed.sha256 !== entry.sha256) {
      entries.push({
        entry,
        state: "hash_mismatch",
        actual_sha256: probed.sha256,
        actual_size: probed.size,
        required,
        detail: "SHA-256 不符：内容已变或读到的不是绑定版本的资料",
      });
      continue;
    }

    entries.push({
      entry,
      state: "ok",
      actual_sha256: probed.sha256,
      actual_size: probed.size,
      required,
      detail: "校验通过",
    });
    availablePaths.push(absolute);
  }

  const problems = entries.filter((e) => e.state !== "ok");
  const usable = problems.length === 0;
  const waitingForRequired = problems.some((p) => p.required);

  return {
    task_id: manifest.task_id,
    usable,
    entries,
    problems,
    waiting_for_required: waitingForRequired,
    available_paths: usable ? availablePaths : [],
    summary: usable
      ? `资料包可用：${entries.length} 个文件全部校验通过`
      : `资料包不可用：${problems.length}/${entries.length} 个文件有问题` +
        (waitingForRequired ? "（含必要附件，任务须等待）" : ""),
  };
}

/* ------------------------------------------------------------------ *
 * 任务输入决策
 * ------------------------------------------------------------------ */

/** 资料包对任务的可用性判定。 */
export type MaterialDecision =
  /** 全部就绪，可用清单内的文件作为输入 */
  | { kind: "ready"; paths: readonly string[] }
  /** 必要附件未齐，等待（10.3）；不假装已读 */
  | { kind: "wait"; reason: string }
  /** 清单本身有问题，需人工/对方修正 */
  | { kind: "needs_input"; reason: string };

/**
 * 依据校验结果决定任务能否开工。
 *
 * 关键规则（10.3）：**不依赖附件的代码任务不该被同步问题阻断**。
 * 因此调用方先声明 `requires_materials`：
 * - false 时，资料不可用也照常开工（忽略资料）
 * - true 时，必要附件未齐必须返回 `wait`
 */
export function decideMaterialUsage(
  result: MaterialValidationResult,
  options: { requires_materials: boolean },
): MaterialDecision {
  if (!options.requires_materials) {
    // 不依赖附件：资料有问题也不阻断，但也不把不完整包当输入
    return { kind: "ready", paths: [] };
  }
  if (result.usable) {
    return { kind: "ready", paths: result.available_paths };
  }
  if (result.waiting_for_required) {
    return {
      kind: "wait",
      reason: `必要附件未就绪：${result.summary}。不将不完整包作为任务输入。`,
    };
  }
  return {
    kind: "needs_input",
    reason: `${result.summary}。清单与实际内容不符，需对方重新发布资料包。`,
  };
}
