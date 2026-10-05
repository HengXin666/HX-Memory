// storage/index-reader.ts — 派生索引的**读取侧** (SQL → MemoryEntry)。
//
// 为什么独立: 读路径 (query/searchText/recent/traverse + row→实体映射) 与写路径
// (归一化/落盘/建索引) 的**变化原因完全不同** —— 前者随检索需求变, 后者随真相格式变。
// 拆开之后, 改"怎么查"不会碰到"怎么存", 也让 file-store.ts 回到可通读的规模。
//
// 不变量:
//   1. 每次返回的都是**完整**条目 (relations/tags 一并 hydrate), 不给半个记忆;
//   2. 可见性口径只有一处: 默认排除 **shadow / merged / expired** (即 `HIDDEN` 常量),
//      `includeShadow` 时**只放行 shadow** (另两种仍排除 —— 它们不是"撤回", 是"已被替代/已过期");
//      (superseded 仍可见 —— 演进链与 history 需要它);
//
//      ⚠ **本文件的每一条读路径都必须用 `HIDDEN`** (2026-09-18, §686 实测):
//      `query()` 此前只写了 `status != 'shadow'` —— 与 `searchText()` / `recent()` 口径分叉,
//      于是 TTL 过期的条目在**结构化查询**里可见而**全文检索**里不可见。
//      权威定义在 `retrieval/lifecycle.ts` 的 `isLiveEntry` —— 新增读路径时照它写。
//   3. LIKE 路径必须转义 %/_ (否则 query({text:"_"}) 会命中全部)。
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  Query,
  RelationType,
} from "../kernel/types.ts";
import { normalizeFeedback } from "../kernel/feedback.ts";
import type { IndexDoc } from "../kernel/ports.ts";
import { visibleClause } from "../kernel/visibility.ts";
import type { FtsIndex } from "./fts-index.ts";
import { finiteOrUndefined, jsonStrings } from "./entry-normalize.ts";
import { GraphReader } from "./graph-reader.ts";
import { entityKey } from "../kernel/entity.ts";
import { IndexEntities } from "./index-entities.ts";

/** 索引行形状 (与 memories 表列一一对应)。 */
export interface RowLike {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  scope: MemoryScope;
  valid_at: string;
  asserted_at: string;
  status: MemoryStatus;
  confirmed_by: string | null;
  confirmed_at: string | null;
  project: string | null;
  structured: string | null;
  // v2 字段 (老库经迁移补齐; 全部可空, 缺省 = v1 行为)
  entities: string | null;
  importance: number | null;
  confidence: number | null;
  reinforcement: number | null;
  last_hit_at: string | null;
  expires_at: string | null;
  derived_from: string | null;
  merged_from: string | null;
  feedback: string | null;
  file: string;
}

/** 行 → 条目 (不含 relations/tags; 那两项由 IndexReader.hydrate 补齐)。 */
export function rowToEntry(row: RowLike): MemoryEntry {
  let structured: MemoryEntry["structured"];
  if (row.structured) {
    try {
      const parsed = JSON.parse(row.structured) as MemoryEntry["structured"];
      if (parsed && typeof parsed.summary === "string") structured = parsed;
    } catch {
      structured = undefined;
    }
  }
  const entities = jsonStrings(row.entities);
  const derivedFrom = jsonStrings(row.derived_from);
  const mergedFrom = jsonStrings(row.merged_from);
  const importance = finiteOrUndefined(row.importance);
  const confidence = finiteOrUndefined(row.confidence);
  const reinforcement = finiteOrUndefined(row.reinforcement);
  let feedback: MemoryEntry["feedback"];
  if (row.feedback) {
    try {
      feedback = normalizeFeedback(JSON.parse(row.feedback));
    } catch {
      feedback = undefined;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    scope: row.scope,
    ts: { validAt: row.valid_at, assertedAt: row.asserted_at },
    status: row.status,
    confirmedBy: row.confirmed_by ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    project: row.project ?? undefined,
    ...(structured === undefined ? {} : { structured }),
    ...(entities === undefined ? {} : { entities }),
    ...(importance === undefined ? {} : { importance }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(reinforcement === undefined ? {} : { reinforcement }),
    ...(row.last_hit_at ? { lastHitAt: row.last_hit_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
    ...(mergedFrom === undefined ? {} : { mergedFrom }),
    ...(feedback === undefined ? {} : { feedback }),
  };
}

/** LIKE 元字符转义 (否则 % 与 _ 会被当成通配符)。 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

/** 默认不可见的状态 (撤回/合并/过期); match 时可用 includeShadow 放行 shadow。 */
// (可见性 SQL 片段来自 kernel/visibility.ts —— 见该文件的说明; 这里不再定义副本。)

/**
 * 索引读取器: 持有 db 与 fts 引用, 提供全部只读查询。
 * 它不做任何写入 —— 写入路径在 file-store.ts (归一化 → 落盘 → 建索引)。
 */
export class IndexReader {
  // 显式字段 + 赋值, 不用 TS 参数属性: 后者在 Node strip-only 模式下是语法错误
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), 而子进程会直接 import 这些 .ts 文件。
  private readonly db: DatabaseSync;
  private readonly fts: FtsIndex;
  /** 图遍历职责 (出边/入边)。拆出去的理由见 storage/graph-reader.ts 的头注。 */
  private readonly graph: GraphReader;

  /** 实体反查与计数 (已按职责拆到 index-entities.ts; 见那个文件的头注)。 */
  private readonly entities: IndexEntities;

  constructor(db: DatabaseSync, fts: FtsIndex) {
    // entities 与 reader 共享同一份 db 与 hydrate 逻辑 (可见性口径必须一致)。
    this.entities = new IndexEntities({ db, hydrate: (row) => this.hydrate(row as never) });
    this.db = db;
    this.fts = fts;
    // hydrate 以**注入**方式给 GraphReader: 它是本类的职责, 复制一份会产生两份必然分叉的口径。
    this.graph = new GraphReader(db, (row) => this.hydrate(row));
  }

  /** memories 表行数 (含 shadow/merged/expired: 索引与真相必须一一对应)。 */
  countMemories(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    return row.n;
  }

  /** 行 → 完整条目 (含 relations/tags), 避免调用方拿到"半个记忆"。 */
  hydrate(row: RowLike): MemoryEntry {
    const e = rowToEntry(row);
    const rels = this.db
      .prepare("SELECT type, to_id, weight FROM relations WHERE from_id = ?")
      .all(row.id) as Array<{ type: RelationType; to_id: string; weight: number | null }>;
    if (rels.length) {
      e.relations = rels.map((r) => ({
        type: r.type,
        toId: r.to_id,
        ...(r.weight === null ? {} : { weight: r.weight }),
      }));
    }
    const tags = this.db.prepare("SELECT tag FROM tags WHERE memory_id = ?").all(row.id) as Array<{
      tag: string;
    }>;
    if (tags.length) e.tags = tags.map((t) => t.tag);
    return e;
  }

  get(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      RowLike | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** 最近捕获的 N 条 (按 assertedAt 倒序), 附 tags。供知情权面板用。 */
  recent(limit = 20): MemoryEntry[] {
    // ⚠ **必须用 HIDDEN, 不能只写 'shadow'** (§689 —— 与 §686 同一类分叉)。
    // `gateway.ts` 的注释早已声明了这条契约: "走 facade.recent 而不是 store.all:
    // **可见性 (shadow/merged/expired 默认隐藏)** 与排序口径只有一处 —— 面板不该看到已撤回的条目"。
    // 而此处此前只挡 shadow ⇒ **面板的"最近"与"被标注"列表会显示 merged/expired 条目**。
    // 权威定义: `retrieval/lifecycle.ts` 的 `isLiveEntry`。
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE " + visibleClause() + " ORDER BY asserted_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as RowLike[];
    return rows.map((r) => this.hydrate(r));
  }

  query(q: Query): MemoryEntry[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    // ⚠ **必须用 HIDDEN, 不能只写 'shadow'** (§686): 此前只挡 shadow, 而 searchText() 用了
    // HIDDEN ⇒ 口径分叉 (TTL 过期的条目: 全文检索看不到、结构化查询看得到 —— 面板
    // contradictions 与 memoryQuery 的 LIKE 降级分支都会显示它)。
    // 权威定义在 retrieval/lifecycle.ts 的 isLiveEntry —— 新增读路径照它写。
    if (!q.includeShadow) clauses.push(visibleClause());
    if (q.kind) {
      clauses.push("kind = ?");
      params.push(q.kind);
    }
    if (q.scope) {
      clauses.push("scope = ?");
      params.push(q.scope);
    }
    if (q.tag) {
      clauses.push("id IN (SELECT memory_id FROM tags WHERE tag = ?)");
      params.push(q.tag);
    }
    // 实体过滤走倒排表; 键必须先规范化 —— 否则「HX-Memory」与「hx-memory」会查出两个不同的集合。
    if (q.entity) {
      clauses.push("id IN (SELECT memory_id FROM entities WHERE entity = ?)");
      params.push(entityKey(q.entity));
    }
    if (q.text) {
      const escaped = escapeLike(q.text);
      clauses.push("(content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')");
      params.push("%" + escaped + "%", "%" + escaped + "%");
    }
    if (q.at) {
      clauses.push("valid_at <= ?");
      params.push(q.at);
    }
    if (q.project) {
      clauses.push("project = ?");
      params.push(q.project);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const limit = q.limit ?? 50;
    const rows = this.db
      .prepare("SELECT * FROM memories" + where + " ORDER BY valid_at DESC, rowid DESC LIMIT ?")
      .all(...params, limit) as unknown[];
    return (rows as RowLike[]).map((r) => this.hydrate(r));
  }

  /**
   * 全文检索 (BM25 排序; 中文按 词 + bigram 双列, 见 kernel/cjk.ts)。
   * 与 query() 的分工: query() 是"结构化条件过滤", searchText() 是"和这段文本最相关"。
   * 降级: FTS5 不可用时退回 LIKE 宽召回 (仍可用, 但没有相关性排序; 见 ftsStatus())。
   */
  searchText(text: string, limit = 20, opts: { includeHidden?: boolean } = {}): MemoryEntry[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const cap = Math.max(1, Math.min(limit, 500));
    const visible = opts.includeHidden ? "" : " AND " + visibleClause();
    const picked: MemoryEntry[] = [];
    const seen = new Set<string>();
    const take = (id: string): void => {
      if (seen.has(id) || picked.length >= cap) return;
      seen.add(id);
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?" + visible).get(id) as
        RowLike | undefined;
      if (row) picked.push(this.hydrate(row));
    };
    if (this.fts.available) {
      // 多取一些再按可见性过滤: 否则被过滤掉的命中会让结果莫名变少。
      for (const hit of this.fts.search(trimmed, cap * 3)) take(hit.id);
      if (picked.length) return picked;
      return [];
    }
    const escaped = escapeLike(trimmed);
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')" +
          visible +
          " ORDER BY valid_at DESC, rowid DESC LIMIT ?",
      )
      .all("%" + escaped + "%", "%" + escaped + "%", cap) as unknown as RowLike[];
    for (const row of rows) take(row.id);
    return picked;
  }

  /** 全量条目 (不截断): warmUp/重建等需要完整集合的调用点。 */
  all(): MemoryEntry[] {
    return this.query({ limit: Number.MAX_SAFE_INTEGER });
  }

  // ⚠ 实体反查与计数三个方法**已抽到 index-entities.ts** (§686 行数上限触发, 职责不同):
  // 它们都只碰 entities 表, 与"怎么查记忆" (query/searchText) 的变化原因不同。
  // 委托见 index-entities.ts 的 withEntities().
  byEntities(keys: readonly string[], limit = 50): MemoryEntry[] {
    return this.entities.byEntities(keys, limit);
  }

  /** 有实体键的条目数 (与 countEntityRows 一起构成覆盖率读数)。 */
  countWithEntities(): number {
    return this.entities.countWithEntities();
  }

  /** 实体索引行数 (供重建/自检判断"倒排是否已补齐")。 */
  countEntityRows(): number {
    return this.entities.countEntityRows();
  }

  /**
   * 关系遍历: 源与邻居**都必须存活** (非 shadow), 与 query 的可见性一致。
   *
   * 为什么源端也要判 (真实缺陷, 2026-09-18 实测): 撤回保留 relations (真相文件里那条是
   * 可审计记录), 于是已撤回节点的边留在库里 —— 实测 60 条 generalizes 边里 41 条挂在
   * 10 个已撤回的占位草稿上, 全图度数最高的节点就是一条被否定的草稿 (10 条边)。
   * 此前只挡"撤回的邻居", 漏了"撤回的源"。修在读取侧而非删数据: 可见性是读取期的性质,
   * 于是存量残留边立刻失效, 不必写迁移。详见 bug-fix/2026-09-18-shadow-source-edges.md。
   */
  /** 关系遍历 (出边)。实现与完整说明在 graph-reader.ts (两个方向合看才见其不对称)。 */
  traverse(fromId: string, relationType: string): MemoryEntry[] {
    return this.graph.out(fromId, relationType as RelationType);
  }

  /** 关系遍历 (入边)。见 graph-reader.ts 的 incoming()。 */
  traverseIncoming(toId: string, relationType: string): MemoryEntry[] {
    return this.graph.incoming(toId, relationType as RelationType);
  }

  /**
   * 选择型候选的**廉价投影** (单条 SQL, 不 hydrate): 供 always-on 选择用。
   *
   * 为什么不能让调用方用 all(): all() 会为每条记忆做 relations + tags 两次子查询并构造完整对象。
   * 实测 10k 条: all() = 137ms, 单条 SQL 投影 = 6ms (22 倍)。而 always-on 走**预步路径**, 每轮都要跑,
   * 用 all() 做筛选等于每轮白付一次 hydrate 成本。
   */
  entrySummaries(): Array<
    Pick<
      MemoryEntry,
      | "id"
      | "kind"
      | "content"
      | "scope"
      | "project"
      | "importance"
      | "status"
      | "confirmedBy"
      | "confirmedAt"
    >
  > {
    // 必须带上 confirmed_by/confirmed_at: always-on 的治理闸门要求"已确认的规则才注入",
    // 缺了这两列会让所有规则被静默过滤掉 (写这个投影时真实踩过 —— 测试立刻抓到)。
    return this.db
      .prepare(
        `SELECT id, kind, content, scope, project, importance, status, confirmed_by AS confirmedBy, confirmed_at AS confirmedAt
         FROM memories WHERE status = 'active'`,
      )
      .all() as unknown as Array<
      Pick<
        MemoryEntry,
        | "id"
        | "kind"
        | "content"
        | "scope"
        | "project"
        | "importance"
        | "status"
        | "confirmedBy"
        | "confirmedAt"
      >
    >;
  }

  /**
   * 廉价全量投影 (单条 SQL, 不 hydrate): 供向量索引/FTS 同步。
   * 之前按查询扫 500 条候选的写法在万级下会**静默漏索引** (实测 10000 条只索引到 519 条)。
   */
  indexDocs(): IndexDoc[] {
    return this.db
      .prepare("SELECT id, content FROM memories WHERE status NOT IN ('shadow','merged','expired')")
      .all() as Array<{ id: string; content: string }>;
  }

  /** 全部行 (供 FTS 回填等内部用途; 不做 hydrate)。 */
  allRows(): RowLike[] {
    return this.db.prepare("SELECT * FROM memories").all() as unknown as RowLike[];
  }

  /** 所有 id (供 FTS 回填)。 */
  allIds(): Array<{ id: string }> {
    return this.db.prepare("SELECT id FROM memories").all() as Array<{ id: string }>;
  }

  /** 其它连接提交后的版本 (node:sqlite 的 PRAGMA data_version); 查询失败退回 0 (不影响正确性)。 */
  externalRevision(): number {
    try {
      const row = this.db.prepare("PRAGMA data_version").get() as
        { data_version?: number } | undefined;
      const value = row?.data_version;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }
}
