// tests/s1/vector-projected.test.ts — 异步嵌入器的投影索引 (不阻塞预步注入)。
import { describe, expect, it } from "vitest";
import { ProjectedVectorIndex } from "../../src/retrieval/vector-projected.ts";
import type { Embedder } from "../../src/kernel/ports.ts";

/** 可控异步嵌入器: 记录调用、模拟延迟/失败。 */
class ManualEmbedder implements Embedder {
  id = "manual";
  dim = 3;
  calls: string[][] = [];
  failNext = false;
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("endpoint down");
    }
    return texts.map((t) => (t.includes("部署") || t.includes("上线") ? [1, 0, 0] : [0, 1, 0]));
  }
}

describe("ProjectedVectorIndex", () => {
  it("upsert 是同步登记; 未 refresh 前 search 返回空并触发后台补算", async () => {
    const embedder = new ManualEmbedder();
    const index = new ProjectedVectorIndex({ embedder, floor: 0.5 });
    index.upsert([{ id: "a", content: "部署前的检查流程" }]);
    expect(index.ready).toBe(false);
    expect(index.progress).toEqual({ embedded: 0, total: 1 });
    // 第一次检索: 查询向量没缓存 → 空 + 触发后台
    expect(index.search("上线检查", 5)).toEqual([]);
    await index.refresh();
    expect(index.ready).toBe(true);
    expect(index.progress).toEqual({ embedded: 1, total: 1 });
    // 上一步的 search 已经把查询文本排进 queryPending, refresh 顺带补齐了它 → 第二次命中
    const hits = index.search("上线检查", 5);
    expect(hits.map((h) => h.id)).toEqual(["a"]);
    // 若查询从未登记过, 首次仍是空 (宁可少召回, 也不阻塞)
    expect(index.search("从未见过的查询词", 5)).toEqual([]);
  });

  it("内容未变不重复嵌入; 变化后重新排队", async () => {
    const embedder = new ManualEmbedder();
    const index = new ProjectedVectorIndex({ embedder, floor: 0.5 });
    index.upsert([{ id: "a", content: "部署前的检查流程" }]);
    await index.refresh();
    const firstCalls = embedder.calls.length;
    index.upsert([{ id: "a", content: "部署前的检查流程" }]);
    await index.refresh();
    expect(embedder.calls.length).toBe(firstCalls);
    index.upsert([{ id: "a", content: "完全不同的内容" }]);
    await index.refresh();
    expect(embedder.calls.length).toBeGreaterThan(firstCalls);
  });

  it("投影里消失的条目被淘汰", async () => {
    const embedder = new ManualEmbedder();
    const index = new ProjectedVectorIndex({ embedder, floor: 0.5 });
    index.upsert([
      { id: "a", content: "部署前的检查流程" },
      { id: "b", content: "部署后的回滚" },
    ]);
    await index.refresh();
    expect(index.progress.total).toBe(2);
    index.upsert([{ id: "a", content: "部署前的检查流程" }]);
    await index.refresh();
    expect(index.progress.total).toBe(1);
    expect(index.remove("a") ?? true).toBeTruthy();
    expect(index.size()).toBe(0);
  });

  it("远端失败不抛穿: 条目放回队列 + onError 可观测 (记忆层不许打穿宿主)", async () => {
    const embedder = new ManualEmbedder();
    const errors: unknown[] = [];
    const index = new ProjectedVectorIndex({
      embedder,
      floor: 0.5,
      onError: (e) => errors.push(e),
    });
    index.upsert([{ id: "a", content: "部署前的检查流程" }]);
    embedder.failNext = true;
    await index.refresh();
    expect(errors.length).toBe(1);
    expect(index.ready).toBe(false); // 放回队列, 下次再试
    await index.refresh();
    expect(index.ready).toBe(true);
    expect(index.size()).toBe(1);
  });

  it("批量分批 (远端 API 一次别塞太多)", async () => {
    const embedder = new ManualEmbedder();
    const index = new ProjectedVectorIndex({ embedder, floor: 0.5, batchSize: 2 });
    index.upsert(Array.from({ length: 5 }, (_, i) => ({ id: "m" + i, content: "部署流程 " + i })));
    await index.refresh();
    expect(embedder.calls.length).toBe(3); // 2 + 2 + 1
    expect(index.size()).toBe(5);
  });
});
