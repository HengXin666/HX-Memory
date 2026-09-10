// tests/s1/vector-index.test.ts — 向量索引端口默认实现 (线性扫描) 的契约。
import { describe, expect, it } from "vitest";
import { LinearVectorIndex } from "../../src/retrieval/vector.ts";
import { HashingEmbedder } from "../../src/retrieval/embedding.ts";

function makeIndex(floor = 0.35) {
  return new LinearVectorIndex({ embedder: new HashingEmbedder(), floor });
}

describe("LinearVectorIndex", () => {
  it("身份自述来自嵌入器 (换模型 = 换索引身份)", () => {
    const index = makeIndex();
    expect(index.embedderId).toBe("hashing-v1");
    expect(index.dim).toBe(256);
    expect(index.size()).toBe(0);
  });

  it("近邻检索按余弦降序, 无关内容被 floor 挡住", () => {
    const index = makeIndex();
    index.upsert([
      { id: "a", content: "容器并发要显式设上限" },
      { id: "b", content: "前端按钮圆角改成 8px" },
    ]);
    const hits = index.search("容器并发上限", 5);
    expect(hits[0]?.id).toBe("a");
    expect(hits.map((h) => h.id)).not.toContain("b");
  });

  it("增量同步: 内容未变不重复嵌入 (embeddedCount 不变)", () => {
    const index = makeIndex();
    const docs = [
      { id: "a", content: "容器并发要显式设上限" },
      { id: "b", content: "数据库连接池超时" },
    ];
    index.upsert(docs);
    const first = index.embeddedCount;
    expect(first).toBe(2);
    index.upsert(docs);
    expect(index.embeddedCount).toBe(first);
    expect(index.size()).toBe(2);
  });

  it("内容变了会重新嵌入 (不会拿旧向量糊弄)", () => {
    const index = makeIndex();
    index.upsert([{ id: "a", content: "容器并发要显式设上限" }]);
    const before = index.embeddedCount;
    index.upsert([{ id: "a", content: "完全换掉的内容: 前端圆角" }]);
    expect(index.embeddedCount).toBe(before + 1);
    expect(index.search("容器并发", 5)).toEqual([]);
  });

  it("投影里消失的条目会被淘汰 (撤回/删除后不再参与语义召回)", () => {
    const index = makeIndex();
    index.upsert([
      { id: "a", content: "容器并发要显式设上限" },
      { id: "b", content: "数据库连接池超时" },
    ]);
    expect(index.size()).toBe(2);
    index.upsert([{ id: "a", content: "容器并发要显式设上限" }]);
    expect(index.size()).toBe(1);
    expect(index.search("连接池", 5)).toEqual([]);
  });

  it("remove / clear / 空查询", () => {
    const index = makeIndex();
    index.upsert([{ id: "a", content: "容器并发要显式设上限" }]);
    expect(index.search("  ", 5)).toEqual([]);
    index.remove("a");
    expect(index.search("容器并发", 5)).toEqual([]);
    index.upsert([{ id: "a", content: "容器并发要显式设上限" }]);
    index.clear();
    expect(index.size()).toBe(0);
  });

  it("floor 可调: 调低能召回弱相关, 调高更保守", () => {
    const entries = [
      { id: "a", content: "容器并发要显式设上限" },
      { id: "b", content: "并发相关但话题不同的一句话" },
    ];
    const loose = new LinearVectorIndex({ embedder: new HashingEmbedder(), floor: 0.05 });
    loose.upsert(entries);
    expect(loose.search("并发", 5).length).toBeGreaterThan(0);
    const strict = new LinearVectorIndex({ embedder: new HashingEmbedder(), floor: 0.99 });
    strict.upsert(entries);
    expect(strict.search("并发", 5).length).toBe(0);
  });
});
