/**
 * 资料校验测试（第 10.2 / 10.3 节，验收 V15 / V16）。
 *
 * 覆盖点对应验收原文：
 * - V15「正确方向、内容哈希一致、不影响 Git 工作目录」
 * - V16「等待或报告，**不把不完整包当成输入**」
 * - P3「同伴资料**只能按清单读取**，不能覆盖活动源码」
 *
 * 全部用注入的 `probe` 假实现，不碰真实文件系统——
 * 但**路径判定逻辑是真实的**，这是最容易出错的地方。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decideMaterialUsage,
  hashFile,
  hashText,
  isConflictCopy,
  isInsideRoot,
  ManifestParseError,
  parseManifestJson,
  validateMaterials,
} from "../../apps/executor/src/core/materials.js";
import type { MaterialManifest } from "../../apps/executor/src/core/materials.js";

/** 构造一个内容已知的假 probe。 */
function fakeProbe(map: Record<string, { sha256: string; size: number }>) {
  return async (absolute: string) => {
    const key = absolute.replace(/\\/g, "/");
    for (const [k, v] of Object.entries(map)) {
      if (key.endsWith(k.replace(/\\/g, "/"))) return v;
    }
    return null;
  };
}

const ROOT = "C:/sync/from-a";

function manifest(entries: MaterialManifest["entries"]): MaterialManifest {
  return { task_id: "TASK-1", entries };
}

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("清单解析（格式待 A 端确认，解析器可替换）", () => {
  it("解析合法 JSON 清单", () => {
    const m = parseManifestJson(
      JSON.stringify({
        task_id: "TASK-1",
        revision: 2,
        entries: [
          { artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1, size: 10, required: true },
        ],
      }),
    );
    expect(m.task_id).toBe("TASK-1");
    expect(m.revision).toBe(2);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.required).toBe(true);
  });

  it("缺 task_id 或 entries 时报错，不静默放过", () => {
    expect(() => parseManifestJson("{}")).toThrow(ManifestParseError);
    expect(() => parseManifestJson(JSON.stringify({ task_id: "T" }))).toThrow(ManifestParseError);
    expect(() => parseManifestJson("not json")).toThrow(ManifestParseError);
  });

  it("sha256 格式非法时报错（防止写错的哈希被当成通过）", () => {
    const bad = JSON.stringify({
      task_id: "T",
      entries: [{ artifact_id: "A", revision: 1, path: "a.png", sha256: "TOOSHORT" }],
    });
    expect(() => parseManifestJson(bad)).toThrow(/sha256/);
  });

  it("大写十六进制会被拒绝（协议要求小写）", () => {
    const bad = JSON.stringify({
      task_id: "T",
      entries: [{ artifact_id: "A", revision: 1, path: "a.png", sha256: "A".repeat(64) }],
    });
    expect(() => parseManifestJson(bad)).toThrow(/sha256/);
  });
});

describe("路径安全", () => {
  it("isInsideRoot 拒绝中文相似前缀（双端连接 vs 双端连接2）", () => {
    expect(isInsideRoot("C:/sync/双端连接", "C:/sync/双端连接/a.png")).toBe(true);
    expect(isInsideRoot("C:/sync/双端连接", "C:/sync/双端连接2/a.png")).toBe(false);
  });

  it("isInsideRoot 拒绝根目录自身（条目必须是文件）", () => {
    expect(isInsideRoot("C:/sync", "C:/sync")).toBe(false);
  });

  it("isInsideRoot 拒绝 .. 穿越", () => {
    expect(isInsideRoot("C:/sync/from-a", "C:/sync/from-a/../secret.txt")).toBe(false);
  });

  it("识别 Syncthing 冲突副本", () => {
    expect(isConflictCopy("TASK-1/A1-1.sync-conflict-20260922-101010-ABCDEF.png")).toBe(true);
    expect(isConflictCopy("TASK-1/A1-1-conflict-2.png")).toBe(true);
    expect(isConflictCopy("TASK-1/A1-1.png")).toBe(false);
  });
});

describe("整包校验", () => {
  it("全部通过时 usable=true，并给出可用路径", async () => {
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([
        { artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1 },
        { artifact_id: "A2", revision: 1, path: "TASK-1/A2-1.png", sha256: H2 },
      ]),
      probe: fakeProbe({
        "TASK-1/A1-1.png": { sha256: H1, size: 100 },
        "TASK-1/A2-1.png": { sha256: H2, size: 200 },
      }),
    });

    expect(result.usable).toBe(true);
    expect(result.problems).toHaveLength(0);
    expect(result.available_paths).toHaveLength(2);
    // 路径是绝对路径且留在同步根内
    for (const p of result.available_paths) {
      expect(isInsideRoot(ROOT, p)).toBe(true);
    }
  });

  it("V16：缺一个文件即整包不可用，且**不返回任何可用路径**", async () => {
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([
        { artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1 },
        { artifact_id: "A2", revision: 1, path: "TASK-1/A2-1.png", sha256: H2, required: true },
      ]),
      probe: fakeProbe({ "TASK-1/A1-1.png": { sha256: H1, size: 100 } }),
    });

    expect(result.usable).toBe(false);
    expect(result.available_paths).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]!.state).toBe("missing");
    // 缺失的是必要附件 → 必须等待
    expect(result.waiting_for_required).toBe(true);
  });

  it("V15：哈希不符被判 hash_mismatch（防止读到另一份『最新资料』）", async () => {
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([{ artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1 }]),
      // 实际内容哈希是 H2，与清单绑定的 H1 不符
      probe: fakeProbe({ "TASK-1/A1-1.png": { sha256: H2, size: 100 } }),
    });

    expect(result.usable).toBe(false);
    expect(result.problems[0]!.state).toBe("hash_mismatch");
    expect(result.problems[0]!.actual_sha256).toBe(H2);
    expect(result.problems[0]!.detail).toContain("SHA-256");
  });

  it("大小不符被判 size_mismatch（部分同步）", async () => {
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([
        { artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1, size: 500 },
      ]),
      probe: fakeProbe({ "TASK-1/A1-1.png": { sha256: H1, size: 120 } }),
    });

    expect(result.usable).toBe(false);
    expect(result.problems[0]!.state).toBe("size_mismatch");
    expect(result.problems[0]!.actual_size).toBe(120);
  });

  it("P3：越界路径**根本不读**，直接判 out_of_root", async () => {
    let probed = 0;
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([
        { artifact_id: "EVIL", revision: 1, path: "../外面/secret.txt", sha256: H1 },
      ]),
      probe: async (p) => {
        probed += 1;
        return { sha256: H1, size: 1 };
      },
    });

    expect(result.problems[0]!.state).toBe("out_of_root");
    // 关键：越界条目一次都没被读取
    expect(probed).toBe(0);
  });

  it("10.3：冲突副本不能作为正式输入，且不被读取", async () => {
    let probed = 0;
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([
        {
          artifact_id: "A1",
          revision: 1,
          path: "TASK-1/A1-1.sync-conflict-20260922-101010-ABC.png",
          sha256: H1,
        },
      ]),
      probe: async () => {
        probed += 1;
        return { sha256: H1, size: 1 };
      },
    });

    expect(result.problems[0]!.state).toBe("conflict_copy");
    expect(probed).toBe(0);
  });

  it("任务 ID 不符时整体拒绝（防止把别人的包当自己的输入）", async () => {
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([{ artifact_id: "A1", revision: 1, path: "TASK-1/A1-1.png", sha256: H1 }]),
      expect_task_id: "TASK-OTHER",
      probe: fakeProbe({ "TASK-1/A1-1.png": { sha256: H1, size: 1 } }),
    });

    expect(result.usable).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.summary).toContain("不符");
  });

  it("绝对路径条目若在根内仍可通过（正常同步场景）", async () => {
    const abs = join(ROOT, "TASK-1", "A1-1.png");
    const result = await validateMaterials({
      sync_root: ROOT,
      manifest: manifest([{ artifact_id: "A1", revision: 1, path: abs, sha256: H1 }]),
      probe: fakeProbe({ "TASK-1/A1-1.png": { sha256: H1, size: 5 } }),
    });
    expect(result.usable).toBe(true);
  });
});

describe("decideMaterialUsage：不依赖附件的任务不被同步问题阻断", () => {
  const unusable = {
    task_id: "T",
    usable: false,
    entries: [],
    problems: [],
    waiting_for_required: true,
    available_paths: [],
    summary: "缺必要附件",
  } as const;

  it("requires_materials=false 时照常开工，但不把不完整包当输入", () => {
    const d = decideMaterialUsage({ ...unusable }, { requires_materials: false });
    expect(d.kind).toBe("ready");
    expect(d.kind === "ready" && d.paths).toEqual([]);
  });

  it("requires_materials=true 且必要附件缺 → wait（不假装已读）", () => {
    const d = decideMaterialUsage({ ...unusable }, { requires_materials: true });
    expect(d.kind).toBe("wait");
    expect(d.kind === "wait" && d.reason).toContain("必要附件");
  });

  it("requires_materials=true 但缺的不是必要附件 → needs_input", () => {
    const d = decideMaterialUsage(
      { ...unusable, waiting_for_required: false },
      { requires_materials: true },
    );
    expect(d.kind).toBe("needs_input");
  });

  it("usable 时返回清单内路径", () => {
    const d = decideMaterialUsage(
      { ...unusable, usable: true, available_paths: ["C:/sync/from-a/T/A1-1.png"] },
      { requires_materials: true },
    );
    expect(d.kind).toBe("ready");
    expect(d.kind === "ready" && d.paths).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * 真实文件系统：哈希计算（不 mock）
 * ------------------------------------------------------------------ */

describe("真实文件 SHA-256", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dac-mat-"));
    mkdirSync(join(dir, "TASK-1"), { recursive: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hashFile 与 hashText 对相同内容给出一致结果", async () => {
    const content = "这是一份测试资料的内容\n";
    const filePath = join(dir, "TASK-1", "A1-1.txt");
    writeFileSync(filePath, content, "utf8");

    const fromFile = await hashFile(filePath);
    const fromText = hashText(content);
    expect(fromFile).toBe(fromText);
    expect(fromFile).toMatch(/^[0-9a-f]{64}$/);
  });

  it("真实文件全流程：清单哈希与实际内容一致才判可用", async () => {
    const content = "真实内容";
    const filePath = join(dir, "TASK-1", "real.bin");
    writeFileSync(filePath, content, "utf8");
    const realHash = hashText(content);

    // 正确哈希 → 可用
    const ok = await validateMaterials({
      sync_root: dir,
      manifest: {
        task_id: "TASK-1",
        entries: [{ artifact_id: "R", revision: 1, path: "TASK-1/real.bin", sha256: realHash }],
      },
    });
    expect(ok.usable).toBe(true);

    // 错误哈希 → 不可用
    const bad = await validateMaterials({
      sync_root: dir,
      manifest: {
        task_id: "TASK-1",
        entries: [{ artifact_id: "R", revision: 1, path: "TASK-1/real.bin", sha256: H1 }],
      },
    });
    expect(bad.usable).toBe(false);
    expect(bad.problems[0]!.state).toBe("hash_mismatch");
  });

  it("校验过程不修改同步目录（纯读取）", async () => {
    const filePath = join(dir, "TASK-1", "readonly.bin");
    writeFileSync(filePath, "不应被改动", "utf8");
    const before = await hashFile(filePath);

    await validateMaterials({
      sync_root: dir,
      manifest: {
        task_id: "TASK-1",
        entries: [
          { artifact_id: "R", revision: 1, path: "TASK-1/readonly.bin", sha256: H1 },
          { artifact_id: "X", revision: 1, path: "../outside.txt", sha256: H1 },
        ],
      },
    });

    // 文件内容与哈希都没变
    expect(await hashFile(filePath)).toBe(before);
  });
});
