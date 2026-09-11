// tests/s2/normalize.test.ts — 主动整理 / 无损迁移 (s2, 带真实文件 IO)。
//
// 三条必须被钉住的契约 (缺一条就不是"无损"):
//   1. **陌生 frontmatter 键原样保留**: 文件可能由更新版本写过, 写回是整块重组 ——
//      不搬运就会在"整理"的那一刻静默吃掉未来字段 (数据丢失);
//   2. **幂等**: 跑第二遍必须零改动 (否则整理本身就成了每次都改文件的噪声源);
//   3. **dryRun 不写盘**: 先看清单再决定 —— 真相文件是人的资产, 不是缓存。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryNormalizer } from "../../src/app/normalize.ts";

let root: string;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-normalize-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 写入一条记忆, 返回它落盘的真相文件路径 (digest/ 或 rules/ 由 kind 决定)。 */
function writeOne(id = "mA"): string {
  const store = new FileBackend({ root });
  store.add({
    id,
    kind: "lesson",
    content: "老形态的一条记忆",
    source: "t",
    scope: "project",
    project: "p1",
    ts: T,
  });
  store.close();
  const dir = join(root, "digest");
  return join(dir, readdirSync(dir)[0]!);
}

describe("MemoryNormalizer: 无损整理", () => {
  it("干跑只出报告, 不写盘 (幂等性检查为 0 改动)", () => {
    const file = writeOne();
    const before = readFileSync(file, "utf8");
    const store = new FileBackend({ root });
    const dry = new MemoryNormalizer(store, root).run({ dryRun: true });
    expect(dry.scanned).toBe(1);
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(false);
    // 干跑不得改文件 (哪怕只有一个字节)
    expect(readFileSync(file, "utf8")).toBe(before);
    store.close();
  });

  it("写回时保留当前代码不认识的 frontmatter 键 (无损的核心)", () => {
    const file = writeOne();
    // 模拟"更新版本写入的字段" + 一个缩进续行
    const patched = readFileSync(file, "utf8").replace(
      "status: active",
      "status: active\nfuture_field: 未来版本写的值\nfuture_nested: 缩进续行",
    );
    writeFileSync(file, patched, "utf8");

    const store = new FileBackend({ root });
    // 直接触发一次写回 (整理/更新走的是同一条 upsertBlockInFile 路径)
    store.update("mA", { importance: 7 });
    store.close();

    const after = readFileSync(file, "utf8");
    expect(after).toContain("future_field: 未来版本写的值");
    expect(after).toContain("future_nested: 缩进续行");
    expect(after).toContain("importance: 7");
  });

  it("跑第二遍是零改动 (幂等: 否则整理本身会成为噪声源)", () => {
    writeOne();
    const store = new FileBackend({ root });
    const n = new MemoryNormalizer(store, root);
    const first = n.run({ dryRun: false });
    const second = n.run({ dryRun: false });
    expect(first.changed).toBe(0); // 当前写入路径产出的就是当前形态
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(1);
    store.close();
  });

  it("真实库上跑: 干跑不报假改动 (数组字段不能按引用比较)", () => {
    // 带 tags 的条目曾经被误报"需改动" —— 数组 === 永远为 false, 必须先序列化再比。
    const file = writeOne("mB");
    const withTags = readFileSync(file, "utf8").replace(
      "status: active",
      'status: active\ntags: ["a","b"]',
    );
    writeFileSync(file, withTags, "utf8");
    const store = new FileBackend({ root });
    const report = new MemoryNormalizer(store, root).run({ dryRun: true });
    expect(report.changes.map((c) => c.fields.flat())).toEqual([]);
    store.close();
  });
});
