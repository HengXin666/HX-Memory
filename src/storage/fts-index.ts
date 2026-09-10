// storage/fts-index.ts — 记忆的全文索引 (SQLite FTS5), 记忆文本 → 可召回。
//
// 为什么把它单独一层: "用什么文本索引" 是最容易变的部分 (FTS5 → LanceDB → Qdrant → Meilisearch)。
// 这里只做一件事: 维护 <id, 可检索文本> 的倒排索引, 并给出 BM25 排序的 id 列表。
// 存储/检索引擎替换时, 这个类整体被换掉, 上层 (Retriever) 只认"给我一批按相关性排序的 id"。
//
// 设计要点:
//   1. 双列 (words / bigrams): 中文 2 字查询与未登录词靠 bigram 列兜底 (见 kernel/cjk.ts 实测说明)。
//   2. 索引带 tokenizer 版本: 分词逻辑一变, 旧索引必须重建而不是混用 (混用 = 静默召回失真)。
//   3. FTS5 不可用时 (精简构建) 不报错: enabled=false, 上层退回 LIKE (能力降级要可见, 不是崩溃)。
//   4. FTS 是**派生物**: 任何时候都能从 memories 表重建; 删掉不影响真相。
import type { DatabaseSync } from "node:sqlite";
import { TOKENIZER_VERSION, indexTermColumns, matchExpression } from "../kernel/cjk.ts";

export interface FtsHit {
  id: string;
  /** BM25 归一后的正分 (越大越相关); 仅用于同一查询内排序, 不跨查询比较。 */
  score: number;
}

const TABLE = "memories_fts";
const META = "index_meta";

export class FtsIndex {
  // 注意: 不使用 TS 参数属性 (constructor(private x)) ——
  // Node 的 strip-only TS 模式 (子进程直接 import .ts) 不支持这种非可擦除语法, 会直接崩。
  private readonly db: DatabaseSync;
  private enabled = false;
  private initError: string | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 是否可用 (SQLite 构建里带 FTS5 时为 true)。 */
  get available(): boolean {
    return this.enabled;
  }

  /** 不可用原因 (可观测: 降级不是静默的)。 */
  get degradation(): string | null {
    return this.initError;
  }

  /** 当前分词版本 (索引与查询共用; 版本不一致必须重建)。 */
  get tokenizerVersion(): number {
    return TOKENIZER_VERSION;
  }

  /**
   * 建表 + 版本校验。返回 true 表示索引需要重建 (分词版本变化 / 索引为空但记忆非空)。
   * 幂等: 可以每次打开数据库都调用。
   */
  ensure(memoryCount: number): boolean {
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${TABLE} USING fts5(words, bigrams, memory_id UNINDEXED, tokenize='unicode61');`,
      );
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
      );
      this.enabled = true;
      this.initError = null;
    } catch (error) {
      this.enabled = false;
      this.initError =
        "fts5 unavailable: " + String(error instanceof Error ? error.message : error);
      return false;
    }

    const stored = this.metaGet("tokenizer_version");
    if (stored !== String(TOKENIZER_VERSION)) {
      this.clear();
      this.metaSet("tokenizer_version", String(TOKENIZER_VERSION));
      return memoryCount > 0 || stored !== null;
    }
    return this.count() === 0 && memoryCount > 0;
  }

  /** 写入/覆盖一条记忆的索引 (FTS5 不支持 REPLACE, 必须先删后插)。 */
  upsert(id: string, text: string): void {
    if (!this.enabled) return;
    const cols = indexTermColumns(text);
    try {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE memory_id = ?`).run(id);
      this.db
        .prepare(`INSERT INTO ${TABLE} (words, bigrams, memory_id) VALUES (?, ?, ?)`)
        .run(cols.words, cols.bigrams, id);
    } catch (error) {
      // 单条索引失败不该让整次写入失败 (真相文件已经写成功); 但要留痕。
      this.initError = "fts upsert failed for " + id + ": " + String(error);
    }
  }

  remove(id: string): void {
    if (!this.enabled) return;
    this.db.prepare(`DELETE FROM ${TABLE} WHERE memory_id = ?`).run(id);
  }

  clear(): void {
    if (!this.enabled) return;
    this.db.exec(`DELETE FROM ${TABLE}`);
  }

  count(): number {
    if (!this.enabled) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get() as { n: number };
    return row.n;
  }

  /**
   * 全文检索: 返回按 BM25 排序的 id (score 已转成正分, 越大越相关)。
   * 查询侧与索引侧共用 kernel/cjk.ts 的分词, 保证对称。
   */
  search(query: string, limit: number): FtsHit[] {
    if (!this.enabled) return [];
    const expr = matchExpression(query);
    if (!expr) return [];
    const rows = this.db
      .prepare(
        `SELECT memory_id AS id, bm25(${TABLE}, 1.0, 0.4, 0.0) AS s FROM ${TABLE} WHERE ${TABLE} MATCH ? ORDER BY s LIMIT ?`,
      )
      .all(expr, limit) as Array<{ id: string; s: number }>;
    return rows.map((r) => ({ id: r.id, score: -r.s }));
  }

  private metaGet(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM ${META} WHERE key = ?`).get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  private metaSet(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO ${META} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
