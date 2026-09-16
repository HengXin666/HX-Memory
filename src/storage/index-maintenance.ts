// storage/index-maintenance.ts — 派生索引的**回填与自述** (FTS 与实体倒排)。
//
// 为什么独立: 这些操作的存在理由是"派生数据比真相互相落后一代", 与"怎么读写真相"无关。
// 两者的修法完全相同 (认版本水位 → 不一致就全量重算), 所以放在一起; 拆出去之后
// file-store.ts 回到只做编排的规模。
//
// 共同契约:
//   - **幂等**: 反复执行结果相同 (先清空再按当前抽取器/分词器重算);
//   - **认版本而不是认"表是否为空"**: "entities 表为空"会永远为真 (纯中文陈述型条目抽不出实体),
//     用它当信号会让每次打开都全量重算。因此与 FTS 的 tokenizer_version 同一机制记水位。
import type { DatabaseSync } from "node:sqlite";
import { ENTITY_EXTRACTOR_VERSION } from "../kernel/entity.ts";
import type { FtsIndex } from "./fts-index.ts";
import type { IndexReader } from "./index-reader.ts";
import type { IndexWriter } from "./index-writer.ts";

/** 实体抽取器的元数据键。 */
export const ENTITY_VERSION_KEY = "entity_version";

export class IndexMaintenance {
  private readonly db: DatabaseSync;
  private readonly reader: IndexReader;
  private readonly writer: IndexWriter;
  private readonly fts: FtsIndex;

  constructor(db: DatabaseSync, reader: IndexReader, writer: IndexWriter, fts: FtsIndex) {
    this.db = db;
    this.reader = reader;
    this.writer = writer;
    this.fts = fts;
  }

  /** 从 memories 表重建全文索引 (T1 级重建: 索引 → 索引)。永远可重复执行。 */
  repopulateFts(): number {
    return this.writer.repopulateFts(this.reader.allIds(), (id) => this.reader.get(id));
  }

  /** 实体抽取器版本水位; null = 从未抽过 (老库升级与"新加这张表"同一种情况)。 */
  entityVersion(): string | null {
    const row = this.db
      .prepare("SELECT value FROM index_meta WHERE key = ?")
      .get(ENTITY_VERSION_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setEntityVersion(): void {
    this.db
      .prepare(
        "INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(ENTITY_VERSION_KEY, ENTITY_EXTRACTOR_VERSION);
  }

  /**
   * 重建实体倒排 (T1 级重建: memories → entities)。幂等。
   * 存在的理由与 FTS 回填相同 —— 兜底抽取器上线前入库的条目, 否则反查对它们永远空转。
   */
  repopulateEntities(): number {
    this.db.exec("DELETE FROM entities");
    let indexed = 0;
    for (const { id } of this.reader.allIds()) {
      const entry = this.reader.get(id);
      if (!entry) continue;
      if (this.writer.indexEntities(entry) > 0) indexed++;
    }
    this.setEntityVersion();
    return indexed;
  }

  /** 实体倒排是否需要重算 (按水位判定, 而不是按"表是否为空")。 */
  needsEntityRebuild(): boolean {
    return this.entityVersion() !== ENTITY_EXTRACTOR_VERSION;
  }

  /** 实体倒排可观测面 (面板/CLI 靠它判断"反查是不是空转")。 */
  entityStatus(): { rows: number; entries: number; version: string } {
    return {
      rows: this.reader.countEntityRows(),
      entries: this.reader.countWithEntities(),
      version: this.entityVersion() ?? "none",
    };
  }

  /** FTS 索引是否需要回填 (分词版本变化或行数不一致)。 */
  needsFtsRebuild(memoryCount: number): boolean {
    return this.fts.available && this.fts.count() !== memoryCount;
  }
}
