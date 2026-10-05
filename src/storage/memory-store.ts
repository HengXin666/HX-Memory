// storage/memory-store.ts — 内存实现 (第二实现, 证明端口是真的)。
//
// 它有三个用途:
//   1. 端口不是"只写在文档里"的装饰 —— 同一套 conformance 测试必须同时跑通文件实现与内存实现;
//   2. 测试里当"快后端"用 (不需要文件/索引的用例跑得快且零清理);
//   3. 迁移期的参照物: 新引擎的行为差异, 先和它对齐再谈优化。
//
// 诚实边界 (能力自述会如实说明):
//   - 无持久化 (进程退出即丢);
//   - 无真实全文索引 (searchText 是子串覆盖, 没有 BM25);
//   - 无重建概念 (它自己就是真相)。
//
// 治理铁律与文件实现完全一致: 未确认的 rule 一律拒绝入库 (换引擎不等于换规则)。
// (randomUUID 已不需要: id 生成走 entry-normalize.ts 的 entryId(); §704)
import type {
  MemoryEntry,
  MemoryEntryInput,
  Query,
  Relation,
  RelationType,
} from "../kernel/types.ts";
import type {
  MemoryStore,
  RetrievalCapabilities,
  RetrievalSource,
  SyncMemoryStore,
} from "../kernel/ports.ts";
// 可见性口径的**唯一实现** (§695): 本文件此前手写 "shadow" 比较, 与其它读路径分叉。
import { isLiveEntry } from "../kernel/visibility.ts";
// ⚠ 入库边界的**权威实现** (§704): 本文件此前手写了一份校验副本, 与 FileBackend 行为不一致。
import { entryId, normalizeEntry } from "./entry-normalize.ts";

// (KINDS/SCOPES 已不需要: 校验走 entry-normalize.ts 的 normalizeEntry(); §704)
// (SCOPES 同上)
const RELATION_TYPES: readonly RelationType[] = [
  "relates",
  "supersedes",
  "supersededBy",
  "generalizes",
  "appliesTo",
  "source",
  "mentions",
  "contradicts",
  "sameAs",
  "instanceOf",
  "derivedFrom",
];
// (isIso/ISO_PATTERN 已不需要: 时间戳校验走 normalizeEntry(); §704)

function clone(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry);
}

export class MemoryBackend implements MemoryStore, SyncMemoryStore, RetrievalSource {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => string;

  constructor(opts: { now?: () => string } = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  get size(): number {
    return this.entries.size;
  }

  add(input: MemoryEntryInput): MemoryEntry {
    // ⚠ **改用 normalizeEntry** (§704): 此前这里**手写了 5 条校验** (kind/scope/两个时间戳 + 默认值),
    // 而权威实现在 `entry-normalize.ts` 的 `normalizeEntry` (FileBackend 走的就是它)。
    // 实测两引擎对同一批非法输入**行为不一致**:
    //   · 非法 `status` ⇒ FileBackend 拒绝 / **本引擎接受** (而"无法识别的状态"会被
    //     `isLiveEntry` 当成"活着" ⇒ **既无效也过滤不掉**);
    //   · 非法 `id` ⇒ FileBackend 拒绝 / **本引擎接受**;
    //   · 且手写版**缺归一** (CRLF→LF、单行字段、tags 类型过滤) ⇒ 两引擎存下来的数据不同形状。
    // 现在两条路共用同一个入库边界 —— "换引擎不等于换规则"。
    const entry = normalizeEntry({
      ...input,
      id: input.id ?? entryId(),
      scope: input.scope ?? "agent",
      ts: {
        validAt: input.ts?.validAt ?? this.now(),
        assertedAt: input.ts?.assertedAt ?? this.now(),
      },
    }) as MemoryEntry;
    // MemoryStore 是内存实现: structured 要深拷贝一份, 免得调用方后续改动穿透进来。
    if (entry.structured) entry.structured = structuredClone(entry.structured);

    if (entry.kind === "rule" && !(entry.confirmedBy && entry.confirmedAt)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    // ⚠ **空内容闸门** (§701 实测: 此前 `store.add({content: ""})` 被接受, 而它**会进 always-on** ——
    // 一个空条目占保底预算、注入一块空白)。
    //
    // 而它是**第三道**防线, 不是唯一一道 —— 上游已有两道:
    //   · `memory_save` 工具: `if (!content) return "Error: content cannot be empty."`;
    //   · `facade.remember`: `if (!content) throw new Error("remember: content is required")`.
    // 真库实测 **0 条空内容** ⇒ 上游足够。但在**存储层**补它是"不变量该在最低层成立"——
    // 与上面那条 rule 闸门同一个理由: 换引擎/新调用点**绕不过**。
    if (!entry.content.trim()) {
      throw new Error("entry content must not be empty");
    }
    this.entries.set(entry.id, entry);
    return clone(entry);
  }

  get(id: string): MemoryEntry | null {
    const entry = this.entries.get(id);
    return entry ? clone(entry) : null;
  }

  query(q: Query): MemoryEntry[] {
    const limit = q.limit ?? 50;
    const out: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      // ⚠ 用 isLiveEntry (§695): 此前只挡 shadow ⇒ merged/expired 会被 query 返回。
      if (!q.includeShadow && !isLiveEntry(entry)) continue;
      if (q.kind && entry.kind !== q.kind) continue;
      if (q.scope && entry.scope !== q.scope) continue;
      if (q.project && entry.project !== q.project) continue;
      if (q.tag && !(entry.tags ?? []).includes(q.tag)) continue;
      if (q.at && entry.ts.validAt > q.at) continue;
      if (q.text) {
        const needle = q.text.toLowerCase();
        const haystack = (entry.content + " " + entry.source).toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      out.push(clone(entry));
    }
    out.sort((a, b) => (a.ts.validAt < b.ts.validAt ? 1 : a.ts.validAt > b.ts.validAt ? -1 : 0));
    return out.slice(0, limit);
  }

  all(): MemoryEntry[] {
    return this.query({ limit: Number.MAX_SAFE_INTEGER });
  }

  /** 关系遍历: 源与邻居都必须存活 (与 FileBackend/IndexReader 同口径; 见 index-reader 的说明)。 */
  traverse(fromId: string, relationType: string): MemoryEntry[] {
    // ⚠ 两端都判 isLiveEntry (§695): 注释说着"与 FileBackend/IndexReader 同口径",
    // 而这里只挡了 shadow ⇒ merged/expired 的源与邻居都会被带出来。
    const from = this.entries.get(fromId);
    if (!from || !isLiveEntry(from)) return [];
    const out: MemoryEntry[] = [];
    for (const relation of from.relations ?? []) {
      if (relation.type !== relationType) continue;
      const target = this.entries.get(relation.toId);
      if (target && isLiveEntry(target)) out.push(clone(target));
    }
    return out;
  }

  /** 反向遍历 (入边): 找出所有指向 toId 的存活条目。见 IndexReader.traverseIncoming。 */
  traverseIncoming(toId: string, relationType: string): MemoryEntry[] {
    // ⚠ 两端都判 isLiveEntry (§695, 与 traverse 对称): 此前只挡 shadow。
    const dst = this.entries.get(toId);
    if (!dst || !isLiveEntry(dst)) return [];
    const out: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      if (!isLiveEntry(entry)) continue;
      if ((entry.relations ?? []).some((r) => r.toId === toId && r.type === relationType)) {
        out.push(clone(entry));
      }
    }
    return out;
  }

  update(id: string, patch: Partial<MemoryEntry>): void {
    const existing = this.entries.get(id);
    if (!existing) throw new Error("not found: " + id);
    const merged: MemoryEntry = {
      ...existing,
      ...patch,
      id,
      ts: patch.ts ?? existing.ts,
      relations: patch.relations ?? existing.relations,
      tags: patch.tags ?? existing.tags,
    };
    if (merged.kind === "rule" && !(merged.confirmedBy && merged.confirmedAt)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    if (merged.relations?.length) merged.relations = validateRelations(merged.relations);
    this.entries.set(id, merged);
  }

  remove(id: string): void {
    const existing = this.entries.get(id);
    if (!existing) return;
    this.entries.set(id, { ...existing, status: "shadow" });
  }

  /** 子串覆盖评分 (没有 BM25, 因此 capabilities().fullText 为 false)。 */
  searchText(text: string, limit = 20): MemoryEntry[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    const scored: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      // ⚠ 用 isLiveEntry 而不是手写三态 (§698): 语义本来就对 (三态齐全), 但那是**第四种写法** ——
      // 而"新增第四种状态时是否记得改这一处"没有任何机制保证。统一到权威实现。
      if (!isLiveEntry(entry)) continue;
      const haystack = (entry.content + " " + (entry.structured?.summary ?? "")).toLowerCase();
      let score = 0;
      for (const token of needle.split(/\s+/).filter(Boolean)) {
        if (haystack.includes(token)) score += token.length;
      }
      if (haystack.includes(needle)) score += needle.length;
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => clone(s.entry));
  }

  capabilities(): RetrievalCapabilities {
    return {
      engine: "memory",
      fullText: false,
      cjk: false,
      semantic: false,
      graph: "relations",
      multiProcess: false,
    };
  }
}

function validateRelations(relations: readonly Relation[]): Relation[] {
  return relations.map((r) => {
    if (!RELATION_TYPES.includes(r.type)) throw new Error("invalid relation: " + JSON.stringify(r));
    if (!r.toId) throw new Error("invalid relation: " + JSON.stringify(r));
    return { type: r.type, toId: r.toId, ...(r.weight === undefined ? {} : { weight: r.weight }) };
  });
}
