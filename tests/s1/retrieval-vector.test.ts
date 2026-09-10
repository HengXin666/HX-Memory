// tests/s1/retrieval-vector.test.ts — 检索的向量通道 (语义召回) 与能力自述一致性。
//
// 用桩嵌入器构造"字面完全不重合但向量相近"的场景 —— 这正是向量通道存在的意义,
// 也是它无法被词/bigram 覆盖率替代的原因。
import { describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { LinearVectorIndex } from "../../src/retrieval/vector.ts";
import type { IndexDoc, RetrievalSource, SyncEmbedder } from "../../src/kernel/ports.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
const e = (id: string, content: string): MemoryEntry => ({
  id,
  kind: "lesson",
  content,
  source: "t",
  scope: "agent",
  ts: T,
  status: "active",
});

class TinySource implements RetrievalSource {
  constructor(private readonly entries: MemoryEntry[]) {}
  searchText(text: string, limit = 20): MemoryEntry[] {
    return this.entries.filter((x) => x.content.includes(text)).slice(0, limit);
  }
  query(q: Query): MemoryEntry[] {
    return this.entries.filter((x) => (q.kind ? x.kind === q.kind : true)).slice(0, q.limit ?? 50);
  }
  get(id: string): MemoryEntry | null {
    return this.entries.find((x) => x.id === id) ?? null;
  }
  traverse(): MemoryEntry[] {
    return [];
  }
}

/** 桩: 含 "部署" 的句子与含 "上线" 的句子被映射到几乎相同的向量 (语义等价)。 */
const stub: SyncEmbedder = {
  id: "stub-embed",
  dim: 2,
  embedSync(texts) {
    return texts.map((t) =>
      t.includes("部署") || t.includes("上线") || t.includes("发布") ? [1, 0] : [0, 1],
    );
  },
  embed(texts) {
    return this.embedSync(texts);
  },
};

describe("向量通道", () => {
  const entries = [e("deploy", "每次发布之前要跑一遍完整校验"), e("ui", "按钮圆角从 4px 改成 8px")];

  it("字面不重合但向量相近 → 通过 vector 通道召回, 且 why 可审计", () => {
    const index = new LinearVectorIndex({ embedder: stub, floor: 0.5 });
    const retriever = new HybridRetriever(new TinySource(entries), { vectorIndex: index });
    const out = retriever.retrieveSync({ text: "上线前的检查流程" });
    const hit = out.hits.find((h) => h.entry.id === "deploy");
    expect(hit).toBeDefined();
    expect(hit?.channels).toContain("vector");
    expect(hit?.why).toContain("vector:");
    expect(out.hits.map((h) => h.entry.id)).not.toContain("ui");
  });

  it("能力自述与真实行为一致: 有向量索引才声称 semantic", () => {
    const index = new LinearVectorIndex({ embedder: stub, floor: 0.5 });
    const withVector = new HybridRetriever(new TinySource(entries), { vectorIndex: index });
    expect(withVector.capabilities().semantic).toBe(true);
    expect(withVector.capabilities().engine).toContain("+vec");
    expect(
      withVector.retrieveSync({ text: "上线" }).degraded.some((d) => d.includes("semantic")),
    ).toBe(false);

    const withoutVector = new HybridRetriever(new TinySource(entries));
    expect(withoutVector.capabilities().semantic).toBe(false);
    expect(
      withoutVector.retrieveSync({ text: "上线" }).degraded.some((d) => d.includes("semantic")),
    ).toBe(true);
  });

  it("向量通道也遵守治理与可见性 (shadow/未确认规则进不来)", () => {
    const index = new LinearVectorIndex({ embedder: stub, floor: 0.5 });
    const retriever = new HybridRetriever(
      new TinySource(
        [e("gone", "发布前的检查流程")].map((x) => ({ ...x, status: "shadow" as const })),
      ),
      { vectorIndex: index },
    );
    expect(retriever.retrieveSync({ text: "上线前检查" }).hits).toEqual([]);
  });

  it("存储没有全量投影时退回扫候选 (有上限), 仍然能召回", () => {
    const many = Array.from({ length: 60 }, (_, i) => e("m" + i, "发布流程第 " + i + " 条"));
    const index = new LinearVectorIndex({ embedder: stub, floor: 0.5 });
    const retriever = new HybridRetriever(new TinySource(many), { vectorIndex: index });
    const out = retriever.retrieveSync({ text: "上线前检查" });
    expect(out.hits.length).toBeGreaterThan(0);
    // 降级路径: 索引只覆盖"这次查询能扫到的候选"(由 source.query 的 limit 决定), 因此是部分覆盖。
    expect(index.size()).toBeGreaterThan(0);
  });

  it("有全量投影+版本号时, 只在写入后重新同步一次 (稳态零开销)", () => {
    let indexDocsCalls = 0;
    let revision = 0;
    const entries = [e("a", "每次发布之前要跑一遍完整校验")];
    const source = {
      searchText: () => [] as MemoryEntry[],
      query: () => entries,
      get: (id: string) => entries.find((x) => x.id === id) ?? null,
      traverse: () => [],
      indexDocs: (): IndexDoc[] => {
        indexDocsCalls++;
        return entries.map((x) => ({ id: x.id, content: x.content }));
      },
      revision: () => revision,
    };
    const index = new LinearVectorIndex({ embedder: stub, floor: 0.5 });
    const retriever = new HybridRetriever(source, { vectorIndex: index });
    retriever.retrieveSync({ text: "上线前检查" });
    retriever.retrieveSync({ text: "上线前检查" });
    expect(indexDocsCalls).toBe(1);
    revision = 1;
    retriever.retrieveSync({ text: "上线前检查" });
    expect(indexDocsCalls).toBe(2);
  });
});
