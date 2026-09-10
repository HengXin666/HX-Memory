// storage/truth-scan.ts — 从真相目录**收集**条目 (文件 → 去重后的记忆集合)。
//
// 为什么独立: "真相目录里现在有哪些记忆"是一个自洽的问题, 与索引/检索/SQL 都无关。
// 重建 (rebuildFromFiles)、一致性自检 (verify)、以及"索引为空是首次使用还是索引丢失"的判断
// 都需要它 —— 三处共用同一份遍历口径, 才不会出现"重建看到 100 条、verify 看到 98 条"的鬼故事。
//
// 去重规则: 同一 id 出现在多个文件 (kind/日期变更的残留) 时取 assertedAt **较新**的那个,
// 且不依赖遍历顺序 (文件系统返回顺序不保证稳定)。被丢弃的会记进 warnings, 不静默吞掉。
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "../kernel/types.ts";
import { DAILY_DIR, DIGEST_DIR, RULES_DIR } from "./entry-normalize.ts";
import { parseEntryBlocks, walkMd } from "./markdown-parse.ts";

/** 三个真相目录 (kind → 目录的映射见 entry-normalize.kindToDir)。 */
export const TRUTH_DIRS = [DAILY_DIR, DIGEST_DIR, RULES_DIR] as const;

/**
 * 扫描真相目录, 返回按 id 去重后的条目表 (以及解析/去重过程中被跳过的原因)。
 * 纯读: 不修改磁盘, 不碰索引。
 */
export function scanTruth(root: string): { entries: Map<string, MemoryEntry>; skipped: string[] } {
  const skipped: string[] = [];
  const seen = new Map<string, MemoryEntry>();
  for (const dir of TRUTH_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const file of walkMd(base)) {
      for (const parsed of parseEntryBlocks(file, skipped)) {
        const previous = seen.get(parsed.id);
        if (previous === undefined || parsed.ts.assertedAt > previous.ts.assertedAt) {
          seen.set(parsed.id, parsed);
          if (previous !== undefined) {
            skipped.push("duplicate id " + parsed.id + " in " + file + " (kept newer)");
          }
        } else {
          skipped.push("duplicate id " + parsed.id + " in " + file + " (kept newer)");
        }
      }
    }
  }
  return { entries: seen, skipped };
}

/** 真相目录里是否存在 Markdown (用于判断"索引为空"是首次使用还是索引丢失)。 */
export function hasTruthFiles(root: string): boolean {
  for (const dir of TRUTH_DIRS) {
    const base = join(root, dir);
    if (existsSync(base) && walkMd(base).length > 0) return true;
  }
  return false;
}

/** 真相文件里的条目数 (不依赖索引; 解析警告会累加到 skipped)。 */
export function countTruthEntries(root: string, skipped?: string[]): number {
  const seen = new Set<string>();
  for (const dir of TRUTH_DIRS) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const file of walkMd(base)) {
      for (const parsed of parseEntryBlocks(file, skipped)) seen.add(parsed.id);
    }
  }
  return seen.size;
}
