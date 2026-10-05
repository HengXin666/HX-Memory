// tests/s1/truth-scan-and-tag-provenance.test.ts — 两个**读真相的权威实现**的不变量。
//
// 为什么需要它 (2026-09-18, §728 实测: **两者零测试覆盖**): `scanTruth` 与 `readFileTags`
// 此前**只有真机验收 (`verify-real-library`) 在用**, 而没有任何单元测试。
//
// 而它们各有一个"漏了就一直错"的不变量:
//
// | 函数 | 不变量 | 漏了的后果 |
// | --- | --- | --- |
// | `scanTruth` | 扫**全部** `TRUTH_DIRS` | 重建/一致性核对会**静默漏掉整个目录** |
// | `readFileTags` | 同上 (它此前**手写**了那份清单, §725 才改成 `TRUTH_DIRS`) | tag 一致性判据基于不全的数据 |
// | `scanTruth` | 同 id 保留 `assertedAt` **较新**的 | 重建后拿到旧版本 |
//
// ⇒ 那正是 §722 我连踩三次的成因 (自己手写目录清单, 漏了 `daily/`)。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTruth, TRUTH_DIRS } from "../../src/storage/truth-scan.ts";
import { readFileTags } from "../../scripts/lib/tag-provenance.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };

/** 造一个真相块 (最小合法形态)。 */
function block(id: string, tags: string, assertedAt = T.assertedAt): string {
  return [
    "## " + id,
    "",
    "---",
    "id: " + id,
    "kind: fact",
    "source: t",
    "scope: agent",
    "valid_at: " + T.validAt,
    "asserted_at: " + assertedAt,
    "status: active",
    "format: 2",
    "tags: " + tags,
    "---",
    "",
    "正文 " + id,
    "",
  ].join("\n");
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "truthscan-"));
}

describe("scanTruth / readFileTags: 读真相的权威实现", () => {
  it("**扫全部 TRUTH_DIRS** —— 每个目录各放一条, 三条都要被读到", () => {
    const root = newRoot();
    try {
      for (const dir of TRUTH_DIRS) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, "2026-01-01.md"), block(dir + "-1", '["a"]'));
      }
      // 再造一个**不在** TRUTH_DIRS 的目录 (它不该被读成真相)。
      mkdirSync(join(root, "episodes"), { recursive: true });
      writeFileSync(join(root, "episodes", "x.md"), block("not-truth", '["b"]'));

      const { entries } = scanTruth(root);
      expect(entries.size, "每个真相目录都要被扫到").toBe(TRUTH_DIRS.length);
      expect(entries.has("not-truth"), "非真相目录不该被读成条目").toBe(false);

      const tags = readFileTags(root);
      for (const dir of TRUTH_DIRS) {
        expect(tags.has(dir + "-1"), dir + " 的 tags 必须被 readFileTags 读到").toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("### 负例: **手写目录清单会漏** —— 这正是 §722/§725 的成因", () => {
    const root = newRoot();
    try {
      // 只往**第一个**真相目录写 (若有人手写 ["digest","rules"], 而 daily 才是第一个, 它就会漏)。
      const first = TRUTH_DIRS[0]!;
      mkdirSync(join(root, first), { recursive: true });
      writeFileSync(join(root, first, "2026-01-01.md"), block("only-first", '["z"]'));

      const { entries } = scanTruth(root);
      expect(entries.has("only-first"), "只写在 " + first + " 的条目必须被读到").toBe(true);
      expect(readFileTags(root).has("only-first")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**同 id 保留 assertedAt 较新的那条** (重建不能拿到旧版本)", () => {
    const root = newRoot();
    try {
      const dir = TRUTH_DIRS[0]!;
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, "2026-01-01.md"),
        block("dup", '["old"]', "2026-01-01T00:00:00Z") + block("dup", '["new"]', "2026-06-01T00:00:00Z"),
      );
      const { entries, skipped } = scanTruth(root);
      expect(entries.size).toBe(1);
      expect(entries.get("dup")!.ts.assertedAt).toBe("2026-06-01T00:00:00Z");
      expect(skipped.length, "重复 id 要被记进 skipped (可见, 不静默)").toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
