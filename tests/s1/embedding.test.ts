// tests/s1/embedding.test.ts — 嵌入端口默认实现的契约 (确定性/归一化/中文可用/批量语义相似度)。
import { describe, expect, it } from "vitest";
import { HashingEmbedder, cosine, semanticScores } from "../../src/retrieval/embedding.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

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

describe("HashingEmbedder", () => {
  const embedder = new HashingEmbedder({ dim: 256 });

  it("确定性: 同一文本任何次调用得到同一向量 (索引与查询必须一致)", () => {
    const [a] = embedder.embed(["容器并发要显式设上限"]) as number[][];
    const [b] = embedder.embed(["容器并发要显式设上限"]) as number[][];
    expect(a).toEqual(b);
    expect(a?.length).toBe(256);
  });

  it("L2 归一化: 自身余弦为 1, 长短文本可比", () => {
    const [a] = embedder.embed(["容器并发"]) as number[][];
    expect(cosine(a!, a!)).toBeCloseTo(1, 10);
  });

  it("中英混排都可用, 相近文本余弦明显高于无关文本", () => {
    const [a, near, far] = embedder.embed([
      "容器并发要显式设上限",
      "容器并发要显式设置上限",
      "前端按钮圆角改成 8px",
    ]) as number[][];
    expect(cosine(a!, near!)).toBeGreaterThan(0.8);
    expect(cosine(a!, far!)).toBeLessThan(0.2);
  });

  it("身份串带版本 (换实现即换身份, 防止索引混用)", () => {
    expect(new HashingEmbedder().id).toBe("hashing-v1");
    expect(new HashingEmbedder({ tag: "v2" }).id).toBe("hashing-v1+v2");
    expect(new HashingEmbedder({ dim: 8 }).dim).toBe(16); // 下限保护
  });

  it("空文本不产生 NaN", () => {
    const [v] = embedder.embed([""]) as number[][];
    expect(v?.every((x) => Number.isFinite(x))).toBe(true);
    expect(cosine(v!, v!)).toBe(0);
  });
});

describe("semanticScores", () => {
  it("批量返回候选 ↔ 各邻居的余弦 (一次嵌入调用)", async () => {
    let calls = 0;
    const embedder = new HashingEmbedder();
    const counted = {
      id: embedder.id,
      dim: embedder.dim,
      embed(texts: readonly string[]) {
        calls++;
        return embedder.embed(texts);
      },
    };
    const scores = await semanticScores(counted, e("new", "容器并发要显式设上限"), [
      e("a", "容器并发要显式设上限!"),
      e("b", "前端按钮圆角改成 8px"),
    ]);
    expect(calls).toBe(1);
    expect(scores.get("a")).toBeGreaterThan(0.95);
    expect(scores.get("b")).toBeLessThan(0.3);
  });

  it("没有邻居时不调用嵌入器 (零开销)", async () => {
    let calls = 0;
    const embedder = {
      id: "noop",
      dim: 4,
      embed(texts: readonly string[]) {
        calls++;
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const scores = await semanticScores(embedder, e("new", "内容"), []);
    expect(calls).toBe(0);
    expect(scores.size).toBe(0);
  });
});
