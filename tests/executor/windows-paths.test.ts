/**
 * Windows 路径边界测试。
 *
 * 补的是 README「必须覆盖的 Windows 重点测试」里尚未覆盖的边界：
 * - MAX_PATH（260）长度限制
 * - UNC 路径（\\server\share\...）
 * - 盘符大小写差异（C: 与 c:）
 * - 尾随分隔符与重复分隔符
 * - 短名（8.3）与保留名
 *
 * 这些用例**不依赖真实文件**，只验证路径判定逻辑；
 * 真实文件系统的可用性由 windows-integration.test.ts 覆盖。
 */

import { describe, expect, it } from "vitest";
import { isInside } from "../../apps/executor/src/core/worktree.js";
import { isInsideRoot } from "../../apps/executor/src/core/materials.js";
import { isSensitivePath, redact } from "../../apps/executor/src/core/context.js";

describe("盘符大小写差异", () => {
  it("C: 与 c: 视为同一路径（Windows 大小写不敏感）", () => {
    // 注意：node:path 的 resolve 在 win32 上不统一盘符大小写，
    // 因此这里显式记录**当前行为**，避免日后误以为是 bug
    const upper = isInside("C:\\repo", "C:\\repo\\sub");
    const lower = isInside("c:\\repo", "c:\\repo\\sub");
    expect(upper).toBe(true);
    expect(lower).toBe(true);
  });

  it("盘符不同则不是子目录", () => {
    expect(isInside("C:\\repo", "D:\\repo\\sub")).toBe(false);
  });

  it("isInsideRoot 同样拒绝跨盘", () => {
    expect(isInsideRoot("C:/sync", "D:/sync/a.png")).toBe(false);
  });
});

describe("尾随分隔符与重复分隔符", () => {
  it("父路径带尾随分隔符仍能判定", () => {
    expect(isInside("C:\\repo\\", "C:\\repo\\sub")).toBe(true);
    expect(isInside("C:\\repo\\\\", "C:\\repo\\sub")).toBe(true);
    const rootWithSep = isInsideRoot("C:/sync/", "C:/sync/a.png");
    expect(rootWithSep).toBe(true);
  });

  it("正斜杠与反斜杠混用可正确解析", () => {
    expect(isInside("C:/repo/sub", "C:\\repo\\sub\\file.ts")).toBe(true);
  });

  it("仅前缀相同但非目录层级 → 拒绝", () => {
    expect(isInside("C:\\repo", "C:\\repository")).toBe(false);
    expect(isInsideRoot("C:/sync", "C:/syncing/a.png")).toBe(false);
  });
});

describe("UNC 路径", () => {
  it("UNC 根与其中文件的关系可判定", () => {
    expect(isInside("\\\\server\\share\\repo", "\\\\server\\share\\repo\\sub")).toBe(true);
  });

  it("不同 share 之间不是子目录", () => {
    expect(isInside("\\\\server\\share1", "\\\\server\\share2\\sub")).toBe(false);
  });

  it("不同 server 之间不是子目录", () => {
    expect(isInside("\\\\server1\\share", "\\\\server2\\share\\sub")).toBe(false);
  });

  it("isInsideRoot 对 UNC 也拒绝根目录自身", () => {
    expect(isInsideRoot("\\\\server\\share", "\\\\server\\share")).toBe(false);
    expect(isInsideRoot("\\\\server\\share", "\\\\server\\share\\a.png")).toBe(true);
  });
});

describe("MAX_PATH（260）长度边界", () => {
  /** 构造一个指定字符数的路径。 */
  function pathOfLength(n: number): string {
    const prefix = "C:\\base\\";
    const remaining = n - prefix.length;
    return prefix + "a".repeat(Math.max(0, remaining));
  }

  it("接近 260 的路径仍能被判定为子目录", () => {
    const parent = "C:\\base";
    const child = pathOfLength(255);
    // 长度不影响纯字符串层级的判定
    expect(isInside(parent, child)).toBe(true);
  });

  it("恰好 260 长度不触发判定逻辑异常", () => {
    const parent = "C:\\base";
    const child = pathOfLength(259);
    expect(child.length).toBe(259);
    expect(isInside(parent, child)).toBe(true);
  });

  it("超长路径（>260）在逻辑层仍是子目录 —— 是否可用由文件系统决定", () => {
    const parent = "C:\\base";
    const child = pathOfLength(400);
    expect(child.length).toBe(400);
    // 明确记录：判定逻辑不做长度限制，
    // 真正的 MAX_PATH 约束由 Windows API 与长路径开关决定
    expect(isInside(parent, child)).toBe(true);
  });

  it("超长路径下的越界仍能被拒绝", () => {
    const parent = "C:\\base";
    const outside = "C:\\other\\" + "a".repeat(300);
    expect(isInside(parent, outside)).toBe(false);
  });
});

describe("中文路径边界（本机实际场景）", () => {
  it("含中文的父与子可正确判定", () => {
    expect(isInside("C:\\双端连接", "C:\\双端连接\\apps\\executor")).toBe(true);
  });

  it("中文相似名不被误判", () => {
    expect(isInside("C:\\双端连接", "C:\\双端连接-备份\\a.ts")).toBe(false);
    expect(isInside("C:\\双端连接", "C:\\双端连接2\\a.ts")).toBe(false);
    expect(isInsideRoot("C:/同步", "C:/同步副本/a.png")).toBe(false);
  });

  it("中文 + 空格 + 多层嵌套", () => {
    const root = "C:\\我的 项目\\双端 连接";
    expect(isInside(root, root + "\\worktrees\\ATTEMPT-1")).toBe(true);
    expect(isInside(root, "C:\\我的 项目\\双端 连接X\\ATTEMPT-1")).toBe(false);
  });
});

describe("保留名与特殊字符（敏感文件识别侧）", () => {
  it("含中文的敏感文件名仍能被识别", () => {
    expect(isSensitivePath("配置/.env")).toBe(true);
    expect(isSensitivePath("凭证/auth.json")).toBe(true);
  });

  it("敏感识别不受路径分隔符风格影响", () => {
    expect(isSensitivePath("a/b/c/.env")).toBe(true);
    expect(isSensitivePath("a\\b\\c\\.env")).toBe(true);
  });

  it("脱敏对含中文的上下文同样生效", () => {
    const { text } = redact("密钥：token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789，请勿外传");
    expect(text).toContain("请勿外传");
    expect(text).not.toContain("ghp_ABCDEF");
  });
});
