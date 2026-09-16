// tests/s2/entity-channel.test.ts — S2: 检索期的实体反查通道。
//
// 复现的是 docs/benchmark-review.md §二之二 的那一类查询: 目标与查询**字面不重合**,
// 唯一可用的桥是"共享实体"。该文档实测的结论是本文件的前提:
//   - 写入期建边解决不了它 (把共享实体的全部配对都建边, 命中只从 19/104 涨到 22/104);
//   - 真瓶颈在检索期 (候选池平均 12.9 条, 目标平均排第 8, 而图配额只有 3);
//   - 以及一个关键读数: **104 条 case 里只有 4 条把实体写在查询里**, 其余 100 条必须先有
//     字面种子才能反查 —— 所以本通道是"种子驱动"的, 不能只做查询词反查。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { openMemoryStack } from "../../src/app/stack.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-entchan-"));
  store = new FileBackend({ root, allowTruthDelete: true });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 种子: 字面可命中查询, 且带实体 prestep.ts。 */
const SEED = "prestep.ts 由 Binder 组装, 通道顺序决定了谁先拿到预算。";
/**
 * 目标: 与查询**字面完全不重合** (覆盖率低于门槛会被 bm25 丢掉), 唯一相同的是实体 prestep.ts。
 * 刻意避开"通道/顺序/预算"这些词 —— 一旦沾上, bm25 自己就能召回它, 这条 case 就测不到反查了
 * (第一版 fixture 就踩了这个坑: 断言"关掉通道目标消失"直接失败, 因为它本来就被词面命中了)。
 */
const TARGET = "prestep.ts 里 MMR 曾被误当成排名用, 实测分最高的那条排在了第二位。";
const QUERY = "通道顺序决定了谁先拿到预算";

function seedEntries(): void {
  store.add({ id: "m-seed", kind: "fact", content: SEED, source: "t", scope: "agent" });
  store.add({ id: "m-target", kind: "fact", content: TARGET, source: "t", scope: "agent" });
}

function make(opts: ConstructorParameters<typeof HybridRetriever>[1] = {}): HybridRetriever {
  return new HybridRetriever(store, { channelWeights: { bm25: 2 }, ...opts });
}

function idsOf(r: HybridRetriever, limit = 10): string[] {
  return r.retrieveSync({ text: QUERY, limit, purpose: "recall" }).hits.map((h) => h.entry.id);
}

describe("实体反查通道", () => {
  it("目标字面不可达, 但靠**种子的实体**被反查出来 (通道存在的理由)", () => {
    seedEntries();
    const r = make();
    const hits = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall" }).hits;
    const ids = hits.map((h) => h.entry.id);
    expect(ids).toContain("m-seed");
    expect(ids).toContain("m-target");
    // 这一条是"字面不重合"的证明: 目标在 bm25 通道里被覆盖率门槛丢掉了。
    const target = hits.find((h) => h.entry.id === "m-target")!;
    expect(target.channels).toEqual(["entity"]);
    expect(target.why).toContain("entity:shared-");
  });

  it("关掉该通道 → 目标消失 (证明是它拿到的, 不是别的通道顺手命中)", () => {
    seedEntries();
    expect(idsOf(make({ entityMaxIds: 0 }))).not.toContain("m-target");
  });

  it("默认走独立配额的尾巴: **不参与主排序竞争**, 因此不挤掉词面命中", () => {
    seedEntries();
    // 主榜单 (bm25) 的第一名在两种配置下必须一致 —— 这正是"分层"要保住的性质
    // (图通道当初进主排序时把全体 R@1 从 0.684 拉到 0.630, 教训在 channels.ts 里记着)。
    const on = idsOf(make());
    const off = idsOf(make({ entityMaxIds: 0 }));
    expect(on[0]).toBe(off[0]);
    expect(off.slice(0, off.length)).toEqual(on.slice(0, off.length));
  });

  it("配额为 0 与 mode='main' 都是生效的开关 (标定项真的被透传)", () => {
    seedEntries();
    expect(idsOf(make({ entityQuota: 0 }))).not.toContain("m-target");
    expect(idsOf(make({ entityMode: "main" }))).toContain("m-target");
  });

  it("确定性: 同一查询连跑两次逐位相同 (快照与重建的前提)", () => {
    seedEntries();
    expect(idsOf(make())).toEqual(idsOf(make()));
  });

  it("共享实体越多的候选排在越前 (相关性由共享计数决定, 不依赖 SQL 返回顺序)", () => {
    store.add({ id: "m-seed", kind: "fact", content: SEED, source: "t", scope: "agent" });
    // weak 只共享一个实体; strong 同时共享 prestep.ts 与 Binder
    store.add({
      id: "m-weak",
      kind: "fact",
      content: "prestep.ts 的顺序曾被误用。",
      source: "t",
      scope: "agent",
    });
    store.add({
      id: "m-strong",
      kind: "fact",
      content: "prestep.ts 与 Binder 的关系记在这里。",
      source: "t",
      scope: "agent",
    });
    const ids = idsOf(make({ entityQuota: 5 }));
    expect(ids.indexOf("m-strong")).toBeLessThan(ids.indexOf("m-weak"));
  });

  it("没有实体可抽的种子 → 通道静默不出现, 不报错也不污染结果", () => {
    store.add({
      id: "m-plain",
      kind: "fact",
      content: "通道顺序决定了谁先拿到预算, 这是纯中文陈述。",
      source: "t",
      scope: "agent",
    });
    const ids = idsOf(make());
    expect(ids).toEqual(["m-plain"]);
  });

  it("标定项真的**被透传**到检索器 (踩过的坑: 只存在于构造参数里 = 永远不生效)", () => {
    seedEntries();
    // 用组装根而不是直接 new: 这条断言防的正是"参数只在检索器里, 组装时忘了传"。
    // 症状是"扫描多组配置得到完全相同的读数", 看起来像参数无影响 —— 实测踩到过。
    const root2 = mkdtempSync(join(tmpdir(), "hxmem-entchan-stack-"));
    const stack = openMemoryStack(root2, { embedder: null, entityMaxIds: 0 });
    try {
      stack.store.add({ id: "x-seed", kind: "fact", content: SEED, source: "t", scope: "agent" });
      stack.store.add({
        id: "x-target",
        kind: "fact",
        content: TARGET,
        source: "t",
        scope: "agent",
      });
      const hits = stack.retriever.retrieveSync({ text: QUERY, limit: 10, purpose: "recall" }).hits;
      expect(hits.map((h) => h.entry.id)).not.toContain("x-target");
    } finally {
      stack.close();
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("引擎没有实体倒排能力时该通道整体缺席 (能力自述必须与行为一致)", () => {
    // 结构性 stub: 只实现 RetrievalSource 的必选面, 不提供 byEntities。
    const entries: MemoryEntry[] = [
      {
        id: "s1",
        kind: "fact",
        content: SEED,
        source: "t",
        scope: "agent",
        ts: { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" },
      },
    ];
    const stub = {
      searchText: (text: string) => entries.filter((e) => e.content.includes(text.slice(0, 2))),
      query: () => [],
      get: (id: string) => entries.find((e) => e.id === id) ?? null,
      traverse: () => [],
    };
    const r = new HybridRetriever(stub, {
      capabilities: {
        engine: "stub",
        fullText: true,
        cjk: true,
        semantic: false,
        graph: "none",
        multiProcess: false,
      },
    });
    const hits = r.retrieveSync({ text: QUERY, limit: 10, purpose: "recall" }).hits;
    expect(hits.map((h) => h.entry.id)).toEqual(["s1"]);
    expect(hits.every((h) => !h.channels.includes("entity"))).toBe(true);
  });
});
