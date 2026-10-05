// storage/index-entities.ts — 实体倒排的**读取侧** (反查 + 覆盖率计数)。
//
// 为什么独立 (2026-09-18, §686): 它原在 index-reader.ts 里, 而那个文件因注释增长触及 400 行上限。
// 按**职责**拆: index-reader 回答"**怎么按条件查记忆**" (query/searchText/recent/all),
// 而本文件回答"**按实体键反查**" —— 两者**变化原因不同** (前者随检索需求变, 后者随实体抽取变),
// 于是拆开。行数限制在这里起到了它该起的作用: 逼出一次职责划分。
//
// 为什么不是"把注释删短了事": 注释记录的是**判据的由来** (那些实测数字是"为什么这么写"的依据),
// 删掉它会让下一个人重新发现一遍。拆职责比删依据更有长期价值。
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry } from "../kernel/types.ts";
import { entityKey } from "../kernel/entity.ts";
import { visibleClause } from "../kernel/visibility.ts";

/** 与 index-reader 的 RowLike 同形 (SQL 行)。用结构化别名避免跨文件耦合内部类型。 */
type RowLike = Record<string, unknown>;

/** 默认不可见的状态 (与 index-reader.ts 同源 —— 可见性口径只有一处)。 */
// (可见性 SQL 片段来自 kernel/visibility.ts —— 见该文件。)

/**
 * 实体倒排的读取封装 (持有与 index-reader 同一份 db 引用)。
 *
 * 它**不做任何写入** —— 倒排的写入在 index-writer.ts。
 */
export class IndexEntities {
  private readonly db: DatabaseSync;
  private readonly hydrate: (row: RowLike) => MemoryEntry;

  constructor(deps: { db: DatabaseSync; hydrate: (row: RowLike) => MemoryEntry }) {
    this.db = deps.db;
    this.hydrate = deps.hydrate;
  }

  /**
   * 实体反查: **按实体键**取回提到它的条目 (倒排表命中, 不扫 memories)。
   *
   * 为什么需要它 (实测依据, docs/benchmark-review.md §二之二): 写入期建边再怎么调都解决不了
   * "字面不可达但共享实体"的查询 —— 把共享实体的**全部**配对建边 (442 条, 现状的 3.3 倍)
   * 只能把命中从 19/104 提到 22/104。真瓶颈在检索期: 种子实体反查出的候选池平均 12.9 条,
   * 而目标在池中平均排第 8 —— 写入期必须在**不知道查询**时猜"哪几条相关", 反查不必猜。
   *
   * 可见性口径与 query() 一致 (默认排除 shadow/merged/expired; 反查是召回, 不该回放已撤回的)。
   */
  byEntities(keys: readonly string[], limit = 50): MemoryEntry[] {
    const wanted: string[] = [];
    const seenKey = new Set<string>();
    for (const k of keys) {
      const key = entityKey(k);
      if (!key || seenKey.has(key)) continue;
      seenKey.add(key);
      wanted.push(key);
    }
    if (!wanted.length) return [];
    const placeholders = wanted.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        "SELECT m.* FROM memories m JOIN entities e ON e.memory_id = m.id" +
          " WHERE e.entity IN (" +
          placeholders +
          ") AND " + visibleClause("m") + " ORDER BY m.valid_at DESC, m.rowid DESC LIMIT ?",
      )
      .all(...wanted, limit) as unknown as RowLike[];
    return rows.map((r) => this.hydrate(r));
  }

  /** 有实体键的条目数 (与 countEntityRows 一起构成覆盖率读数)。 */
  countWithEntities(): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT memory_id) AS n FROM entities").get() as {
      n: number;
    };
    return row.n;
  }

  /** 实体索引行数 (供重建/自检判断"倒排是否已补齐")。 */
  countEntityRows(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
    return row.n;
  }

}
