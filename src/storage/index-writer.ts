// storage/index-writer.ts — 派生索引的**写入侧** (MemoryEntry → SQL 行 + FTS 行)。
//
// 与 index-reader.ts 对称: 读侧负责"怎么查", 写侧负责"怎么写"。
// 独立的理由是**治理闸门必须只有一处**: "未确认的 rule 不许入库"这条规则
// 同时约束正常写入 (add/update) 与全量重建 (rebuildFromFiles) —— 两处各写一遍迟早会漏一处,
// 而漏掉的那条路会让人工闸门在重建时被静默绕过 (重建是常见操作)。
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry } from "../kernel/types.ts";
import { searchableText } from "../kernel/cjk.ts";
import type { FtsIndex } from "./fts-index.ts";
import { extractTags, fileFor, isConfirmed } from "./entry-normalize.ts";

export class IndexWriter {
  // 显式字段 + 赋值 (不用 TS 参数属性): 见 index-reader.ts 的同类注释。
  private readonly db: DatabaseSync;
  private readonly fts: FtsIndex;

  constructor(db: DatabaseSync, fts: FtsIndex) {
    this.db = db;
    this.fts = fts;
  }

  /** 写入索引; 未确认的 rule 一律拒绝 (与 add() 同一套闸门, 重建也不能绕过)。 */
  indexEntry(e: MemoryEntry, skipped: string[]): boolean {
    if (e.kind === "rule" && !isConfirmed(e)) {
      skipped.push("unconfirmed rule " + e.id + " rejected at index time");
      return false;
    }
    let file: string;
    try {
      file = fileFor(e);
    } catch (error) {
      skipped.push(String(error));
      return false;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories (id, kind, content, source, scope, valid_at, asserted_at, status, confirmed_by, confirmed_at, project, structured,
         entities, importance, confidence, reinforcement, last_hit_at, expires_at, derived_from, merged_from, file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.kind,
        e.content,
        e.source,
        e.scope,
        e.ts.validAt,
        e.ts.assertedAt,
        e.status ?? "active",
        e.confirmedBy ?? null,
        e.confirmedAt ?? null,
        e.project ?? null,
        e.structured ? JSON.stringify(e.structured) : null,
        e.entities?.length ? JSON.stringify(e.entities) : null,
        e.importance ?? null,
        e.confidence ?? null,
        e.reinforcement ?? null,
        e.lastHitAt ?? null,
        e.expiresAt ?? null,
        e.derivedFrom?.length ? JSON.stringify(e.derivedFrom) : null,
        e.mergedFrom?.length ? JSON.stringify(e.mergedFrom) : null,
        file,
      );
    for (const rel of e.relations ?? []) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO relations (from_id, type, to_id, weight) VALUES (?, ?, ?, ?)",
        )
        .run(e.id, rel.type, rel.toId, rel.weight ?? null);
    }
    for (const tag of e.tags?.length ? e.tags : extractTags(e.content)) {
      this.db.prepare("INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)").run(e.id, tag);
    }
    // 全文索引 (派生): 正文 + 摘要 + 要点 + 标签 + 实体。
    this.fts.upsert(e.id, searchableText(e));
    return true;
  }

  /** 删掉某条的关系/标签行 (重新建索引之前调用)。 */
  clearRelationsAndTags(id: string): void {
    this.db.prepare("DELETE FROM relations WHERE from_id = ?").run(id);
    this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
  }

  /** 清空全部索引行 (重建前调用)。 */
  clearAll(): void {
    this.db.exec("DELETE FROM memories; DELETE FROM relations; DELETE FROM tags;");
  }

  /** 彻底删除一条 (allowTruthDelete 路径; FTS 行也一并删)。 */
  deleteEntry(id: string): void {
    this.db.prepare("DELETE FROM relations WHERE from_id = ?").run(id);
    this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.fts.remove(id);
  }

  /** 置为 shadow (默认撤回路径: 真相文件里也写 shadow, 重建不会复活)。 */
  markShadow(id: string): void {
    this.db.prepare("UPDATE memories SET status='shadow' WHERE id = ?").run(id);
  }

  /**
   * 从 memories 表重建全文索引 (T1 级重建: 索引 → 索引)。
   * 上游仍是真相文件 (memories 表本身可从文件重建), 因此这一步永远可重复执行。
   */
  repopulateFts(rows: Array<{ id: string }>, rowOf: (id: string) => MemoryEntry | null): number {
    if (!this.fts.available) return 0;
    this.fts.clear();
    let n = 0;
    for (const { id } of rows) {
      const entry = rowOf(id);
      if (!entry) continue;
      this.fts.upsert(id, searchableText(entry));
      n++;
    }
    return n;
  }

}
