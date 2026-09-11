// storage/index-schema.ts — 派生索引的 DDL 与迁移 (纯函数, 不含业务逻辑)。
//
// 为什么独立: 表结构与迁移策略是"索引的内部实现细节", 与"真相文件怎么读写"完全无关 ——
// 它们的变化原因不同 (改表 vs 改格式)。放在一起会让 file-store 每次加列都变长。
//
// 迁移原则: 索引是**派生物**, 加列不会丢真相 (真值文件是唯一事实源)。
// 因此老库只需 ALTER 补列, 不需要数据搬迁; 补不上就重建 (rebuildFromFiles)。
import type { DatabaseSync } from "node:sqlite";

/** 建表 + 索引 (幂等: 全部 IF NOT EXISTS)。 */
const DDL = `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        scope TEXT NOT NULL,
        valid_at TEXT NOT NULL,
        asserted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        confirmed_by TEXT,
        confirmed_at TEXT,
        project TEXT,
        structured TEXT,
        entities TEXT,
        importance REAL,
        confidence REAL,
        reinforcement INTEGER,
        last_hit_at TEXT,
        expires_at TEXT,
        derived_from TEXT,
        merged_from TEXT,
        feedback TEXT,
        file TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        from_id TEXT NOT NULL,
        type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        weight REAL,
        PRIMARY KEY (from_id, type, to_id)
      );
      CREATE TABLE IF NOT EXISTS tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);
`;

/**
 * v2 新增列 (老库逐列补齐)。
 * check-then-ALTER 不是原子的: 并发打开时可能撞 duplicate column, 这里吞掉该错误 ——
 * 目标状态已达成, 报错没有信息量 (另一个进程刚补过)。
 */
const MIGRATIONS: ReadonlyArray<readonly [string, string]> = [
  ["structured", "ALTER TABLE memories ADD COLUMN structured TEXT"],
  ["entities", "ALTER TABLE memories ADD COLUMN entities TEXT"],
  ["importance", "ALTER TABLE memories ADD COLUMN importance REAL"],
  ["confidence", "ALTER TABLE memories ADD COLUMN confidence REAL"],
  ["reinforcement", "ALTER TABLE memories ADD COLUMN reinforcement INTEGER"],
  ["last_hit_at", "ALTER TABLE memories ADD COLUMN last_hit_at TEXT"],
  ["expires_at", "ALTER TABLE memories ADD COLUMN expires_at TEXT"],
  ["derived_from", "ALTER TABLE memories ADD COLUMN derived_from TEXT"],
  ["merged_from", "ALTER TABLE memories ADD COLUMN merged_from TEXT"],
  ["feedback", "ALTER TABLE memories ADD COLUMN feedback TEXT"],
];

export function initSchema(db: DatabaseSync): void {
  db.exec(DDL);
  const existing = new Set(
    (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [name, sql] of MIGRATIONS) {
    if (existing.has(name)) continue;
    try {
      db.exec(sql);
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  }
}
