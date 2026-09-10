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
import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryKind,
  MemoryScope,
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

const KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "event",
  "decision",
  "lesson",
  "rule",
  "pattern",
  "context",
];
const SCOPES: readonly MemoryScope[] = ["project", "agent", "global"];
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
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isIso(value: string): boolean {
  return ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

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
    if (!KINDS.includes(input.kind)) throw new Error("invalid kind: " + JSON.stringify(input.kind));
    const scope: MemoryScope = input.scope ?? "agent";
    if (!SCOPES.includes(scope)) throw new Error("invalid scope: " + JSON.stringify(scope));
    const validAt = input.ts?.validAt ?? this.now();
    const assertedAt = input.ts?.assertedAt ?? this.now();
    if (!isIso(validAt)) throw new Error("invalid validAt: " + JSON.stringify(validAt));
    if (!isIso(assertedAt)) throw new Error("invalid assertedAt: " + JSON.stringify(assertedAt));
    const entry: MemoryEntry = {
      id: input.id ?? "m" + randomUUID().replace(/-/g, "").slice(0, 16),
      kind: input.kind,
      content: input.content,
      source: input.source,
      scope,
      ts: { validAt, assertedAt },
      status: input.status ?? "active",
      ...(input.project ? { project: input.project } : {}),
      ...(input.confirmedBy ? { confirmedBy: input.confirmedBy } : {}),
      ...(input.confirmedAt ? { confirmedAt: input.confirmedAt } : {}),
      ...(input.tags?.length ? { tags: [...input.tags] } : {}),
      ...(input.structured ? { structured: structuredClone(input.structured) } : {}),
      ...(input.relations?.length ? { relations: validateRelations(input.relations) } : {}),
      ...(input.entities?.length ? { entities: [...input.entities] } : {}),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.reinforcement === undefined ? {} : { reinforcement: input.reinforcement }),
      ...(input.lastHitAt ? { lastHitAt: input.lastHitAt } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.derivedFrom?.length ? { derivedFrom: [...input.derivedFrom] } : {}),
      ...(input.mergedFrom?.length ? { mergedFrom: [...input.mergedFrom] } : {}),
    };
    if (entry.kind === "rule" && !(entry.confirmedBy && entry.confirmedAt)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
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
      if (!q.includeShadow && entry.status === "shadow") continue;
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

  traverse(fromId: string, relationType: string): MemoryEntry[] {
    const from = this.entries.get(fromId);
    if (!from) return [];
    const out: MemoryEntry[] = [];
    for (const relation of from.relations ?? []) {
      if (relation.type !== relationType) continue;
      const target = this.entries.get(relation.toId);
      if (target && target.status !== "shadow") out.push(clone(target));
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
      if (entry.status === "shadow" || entry.status === "merged" || entry.status === "expired")
        continue;
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
