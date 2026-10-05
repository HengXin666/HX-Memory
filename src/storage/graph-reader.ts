// storage/graph-reader.ts — 关系图的**双向遍历** (出边 / 入边)。
//
// 为什么从 index-reader.ts 拆出来 (2026-09-18): 加 `traverseIncoming` 后那个文件到了 425 行,
// 越过仓库的 400 行上限 (verify-structure)。上限的用意正是"超过 400 行通常是两个职责被塞进了一个文件",
// 而这里确实是两个职责:
//   · index-reader 管**平面查询** (query/searchText/recent/投影) —— 随检索需求变;
//   · 本文件管**图遍历** (沿边一跳) —— 随关系语义变 (例如新增边类型、或改变可遍历方向)。
//
// 一个实测驱动的边界: "出边 vs 入边"这个区别本身是有内容的 ——
// 语义边只有「抽象 → 实例」一个方向, 而用户的提问方向常是反的 (见 traverseIncoming 的头注)。
// 两者放在一起才看得见那个不对称。
import type { DatabaseSync } from "node:sqlite";
import type { MemoryEntry, RelationType } from "../kernel/types.ts";
import { visibleClause } from "../kernel/visibility.ts";
import type { RowLike } from "./index-reader.ts";

// 可见性 SQL 片段来自 kernel/visibility.ts (单一实现) —— 见该文件的说明。
// ⚠ **两条遍历的两个端点都要判** (源端与邻居端), 否则已撤回的源仍会把邻居带出来。

/** 把一行 hydrate 成完整条目 (由 IndexReader 注入, 避免本文件重复实现映射)。 */
export type Hydrate = (row: RowLike) => MemoryEntry;

/**
 * 图遍历的读侧。**无状态**: 只持有 db 与 hydrate 函数。
 *
 * 为什么用注入的 hydrate 而不是 import: hydrate 是 index-reader 的职责 (它知道列与实体的映射),
 * 复制一份到本文件就会有两份必然分叉的口径 (本项目已踩过"索引与查询各写一份分词口径")。
 */
export class GraphReader {
  // ⚠ 显式字段 + 赋值, **不用** TS 参数属性 (`constructor(private readonly x)`) ——
  // 后者在 Node strip-only 模式下是语法错误 (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), 而子进程会直接
  // import 这些 .ts 文件。本项目有专门的 verify-structure 检查守这条 (而我写第一版时就踩了)。
  private readonly db: DatabaseSync;
  private readonly hydrate: Hydrate;

  constructor(db: DatabaseSync, hydrate: Hydrate) {
    this.db = db;
    this.hydrate = hydrate;
  }

  /**
   * 关系遍历 (**出边**): 源与邻居**都必须存活** (非 shadow), 与 query 的可见性一致。
   *
   * 为什么源端也要判 (真实缺陷, 2026-09-18 实测): 撤回保留 relations (真相文件里那条是
   * 可审计记录), 于是已撤回节点的边留在库里 —— 实测 60 条 generalizes 边里 41 条挂在
   * 10 个已撤回的占位草稿上, 全图度数最高的节点就是一条被否定的草稿 (10 条边)。
   * 此前只挡"撤回的邻居", 漏了"撤回的源"。修在读取侧而非删数据: 可见性是读取期的性质,
   * 于是存量残留边立刻失效, 不必写迁移。详见 bug-fix/2026-09-18-shadow-source-edges.md。
   */
  out(fromId: string, relationType: RelationType): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
           JOIN relations r ON r.to_id = m.id
           JOIN memories src ON src.id = r.from_id
          WHERE r.from_id = ? AND r.type = ?
            AND ${visibleClause("m")} AND ${visibleClause("src")}`,
      )
      .all(fromId, relationType) as unknown[];
    return (rows as RowLike[]).map((r) => this.hydrate(r));
  }

  /**
   * 关系遍历 (**入边**): 找出所有**指向** toId 的存活条目。
   *
   * 为什么需要它 (2026-09-18, 实测发现): 语义边只有「抽象 → 实例」一个方向 ——
   * 而**用户的提问方向是反的** ("这个具体的坑, 对应哪条通用规则?")。
   * 真实库实测: 4 条从**实例细节**提问、gold 是**短抽象**的用例上, 只走出边命中 **0/4**;
   * 加入边后 **2/4** (两条都靠 graph 通道拿到)。同库同用例的 A/B 对照。
   *
   * 可见性判据与 out() 对称: **两端都必须存活** (非 shadow)。
   */
  incoming(toId: string, relationType: RelationType): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
           JOIN relations r ON r.from_id = m.id
           JOIN memories dst ON dst.id = r.to_id
          WHERE r.to_id = ? AND r.type = ?
            AND ${visibleClause("m")} AND ${visibleClause("dst")}`,
      )
      .all(toId, relationType) as unknown[];
    return (rows as RowLike[]).map((r) => this.hydrate(r));
  }
}
