// scripts/lib/tag-provenance.ts — **tags 的三个来源, 判据只能有一份**。
//
// 为什么必须抽成共享模块 (2026-09-18, §550): 我在同一个判据上**连错三次**:
//   · §544 v1: 把"索引 tags != 文件 tags"一律算漂移 —— **不懂"派生 tag"这个第三态**;
//   · §544 v2: 改判"索引多出的必须能由 extractTags 重建" —— **漏了"文件 tags 行"这一源**;
//   · §547:    写诊断脚本时**又漏了"文件 tags 行"**(同一个错误重写了一遍)。
//
// 三次的共同机制: **一个 tag 有三个可能来源, 而我只认其中一两个**。
//
//   ① **索引字段** (memories.tags / 索引里的 tags 表);
//   ② **真相文件的 `tags:` 行** (frontmatter);
//   ③ **正文派生** —— `indexEntry` 在 `e.tags` 为空时用 `extractTags(e.content)` 兜底抽取,
//      而 `entryToMarkdown` 只在 `e.tags` 非空时写 `tags:` 行 ⇒ **派生 tag 不进文件**。
//
// 判据: **文件里有而索引无 = 真不一致** (须为 0);
//       **索引多出的 → 文件里有 或 正文能重建 = 正常**;
//       **两处都没有 = 真孤儿** (只能来自旧版抽取器, 是历史残留)。
//
// 本模块是**唯一实现**。任何脚本要判 tags 一致性都用它, 不要重写。
import { readdirSync } from "node:fs";
// 真相目录清单的**唯一实现** (§725) —— 见下面 readFileTags 的说明。
import { TRUTH_DIRS } from "../../src/storage/truth-scan.ts";
import { join } from "node:path";
import { readFileParts } from "../../src/storage/markdown-codec.ts";
import { extractTags } from "../../src/storage/entry-normalize.ts";

/**
 * 真相文件里每个条目的 `tags:` 行 (缺失 = 空数组)。
 *
 * ⚠ **复用产品自己的分块器`readFileParts`, 不自己写状态机** (2026-09-18, §553):
 * 我第一版在这里手写了一个 `---` 状态机 —— 而产品**已有权威实现**
 * (`markdown-codec.ts`, 用 `/(^|\n)---\nid: /` 分块, 还处理 BOM 与 CRLF 归一化)。
 *
 * 实测两者在真库上**结果完全一致** (387 个 id / 0 差异) —— 但"结果一致"**不等于"该有两份"**:
 * 这是**同一件事的两个实现**, 任何一边改了分块规则 (例如新增一种 frontmatter 形态),
 * 另一边就会**静默分叉**, 而分叉后的读数会被当成"产品的行为"。§544/§547 那三次错判
 * 全都是"我按自己的理解重写了一遍判据"。
 */
export function readFileTags(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // ⚠ **不手写目录清单** (§725): 此前这里是 `["daily","digest","rules"]` —— 而那是
  // `src/storage/truth-scan.ts` 的 `TRUTH_DIRS` 的**副本**。真相目录一旦新增,
  // 本脚本会**静默漏掉整个目录**(而它正是"tag 一致性"的判据来源)。
  for (const dir of TRUTH_DIRS) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      // 产品解析器已处理 BOM / CRLF / 块分隔符的容忍度 —— 与写入路径同一口径。
      for (const block of readFileParts(join(root, dir, f)).blocks) {
        const id = /^id: (.*)$/m.exec(block)?.[1]?.trim();
        if (!id) continue;
        const tm = /^tags: (.*)$/m.exec(block);
        let tags: string[] = [];
        if (tm) {
          try {
            const parsed: unknown = JSON.parse(tm[1]!);
            if (Array.isArray(parsed)) tags = parsed.filter((v): v is string => typeof v === "string");
          } catch {
            tags = [];
          }
        }
        out.set(id, tags);
      }
    }
  }
  return out;
}

export interface TagProvenance {
  /** 文件里有而索引无 —— **真不一致**, 须为 0。 */
  indexMissing: string[];
  /** 索引多出且文件里也没有, 但**正文能重建** (派生 tag) —— 正常。 */
  derived: string[];
  /** 索引多出、文件里没有、**正文也重建不出** —— 历史残留 (旧抽取器)。 */
  orphan: string[];
}

/** 按**三个来源**判定某条目的 tags 一致性 (唯一实现, 勿重写)。 */
export function tagProvenance(
  entry: { id: string; content: string; tags?: readonly string[] },
  fileTags: Map<string, string[]>,
): TagProvenance {
  const idx = new Set(entry.tags ?? []);
  const file = new Set(fileTags.get(entry.id) ?? []);
  const rebuildable = new Set(extractTags(entry.content));
  const res: TagProvenance = { indexMissing: [], derived: [], orphan: [] };
  for (const t of file) if (!idx.has(t)) res.indexMissing.push(t);
  for (const t of idx) {
    if (file.has(t)) continue;
    if (rebuildable.has(t)) res.derived.push(t);
    else res.orphan.push(t);
  }
  return res;
}

/** 全库汇总 (脚本用这个, 而不是自己写循环)。 */
export function summarizeProvenance(
  entries: ReadonlyArray<{ id: string; content: string; tags?: readonly string[] }>,
  root: string,
): { indexMissing: number; derivedEntries: number; orphanEntries: number; orphanPairs: string[] } {
  const ft = readFileTags(root);
  const orphanPairs: string[] = [];
  let indexMissing = 0;
  let derivedEntries = 0;
  let orphanEntries = 0;
  for (const e of entries) {
    const p = tagProvenance(e, ft);
    indexMissing += p.indexMissing.length;
    if (p.derived.length) derivedEntries++;
    if (p.orphan.length) {
      orphanEntries++;
      for (const t of p.orphan) orphanPairs.push(e.id.slice(0, 12) + ":" + t);
    }
  }
  return { indexMissing, derivedEntries, orphanEntries, orphanPairs };
}
