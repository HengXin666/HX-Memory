// tests/s1/embedding-lexical.test.ts — 离线语义嵌入器: 同义改写可召回 (v1 的精确匹配做不到)。
//
// 这是用户核心诉求的回归护栏: "语义相近但字面不同"必须能匹配上。
import { describe, expect, it } from "vitest";
import { LexicalEmbedder } from "../../src/retrieval/embedding-lexical.ts";
import { cosine } from "../../src/retrieval/embedding.ts";

/** 语料 + 同义改写查询 (尽量不共享长词, 模拟真实"换个说法")。 */
const CASES: Array<{ doc: string; paraphrase: string; unrelated: string }> = [
  {
    doc: "每次发版之前要跑一遍完整校验",
    paraphrase: "上线前应该做什么检查",
    unrelated: "前端按钮圆角改成 8px",
  },
  {
    doc: "容器并发要显式设置上限",
    paraphrase: "服务并行处理需要限制并发度",
    unrelated: "数据库索引优化",
  },
  {
    doc: "数据库连接池超时要设置重试与熔断",
    paraphrase: "DB 连接拿不到时的兜底策略",
    unrelated: "日志采样率提高到 10%",
  },
  {
    doc: "缓存过期时间统一设为 60 秒",
    paraphrase: "本地缓存多久失效",
    unrelated: "接口鉴权失败返回 401",
  },
  {
    doc: "定时任务必须加分布式锁防止重复执行",
    paraphrase: "多实例调度同一个 job 会打架",
    unrelated: "静态资源开启 gzip",
  },
  {
    doc: "回滚方案必须在发布前准备好",
    paraphrase: "出事之前要先想好怎么退回去",
    unrelated: "队列堆积时先限流再扩容",
  },
];

describe("LexicalEmbedder: 离线语义近似", () => {
  const embedder = new LexicalEmbedder();

  it("同义改写的相似度显著高于无关文本 (逐条判定, 不是平均值糊弄)", () => {
    for (const { doc, paraphrase, unrelated } of CASES) {
      const [a, b, c] = embedder.embed([doc, paraphrase, unrelated]) as number[][];
      const near = cosine(a!, b!);
      const far = cosine(a!, c!);
      expect(near, `同义 "${paraphrase}" 应当比无关更接近 "${doc}"`).toBeGreaterThan(far);
      expect(near, `同义相似度应当达到下限之上`).toBeGreaterThanOrEqual(embedder.floor);
    }
  });

  it("平均区分度: 同义 >= 0.35 且 无关 <= 0.10", () => {
    let near = 0;
    let far = 0;
    for (const { doc, paraphrase, unrelated } of CASES) {
      const [a, b, c] = embedder.embed([doc, paraphrase, unrelated]) as number[][];
      near += cosine(a!, b!);
      far += cosine(a!, c!);
    }
    expect(near / CASES.length).toBeGreaterThanOrEqual(0.35);
    expect(far / CASES.length).toBeLessThanOrEqual(0.1);
  });

  it("确定性 + 归一化 + 身份串", () => {
    const [a] = embedder.embed(["容器并发上限"]) as number[][];
    const [b] = embedder.embed(["容器并发上限"]) as number[][];
    expect(a).toEqual(b);
    expect(cosine(a!, a!)).toBeCloseTo(1, 10);
    expect(embedder.id).toBe("lexical-v1");
    expect(embedder.floor).toBeGreaterThan(0);
  });

  it("词典归一真的在起作用: 同义术语对 (发布/上线) 相似度接近 1", () => {
    const [a, b] = embedder.embed(["发布流程", "上线流程"]) as number[][];
    expect(cosine(a!, b!)).toBeGreaterThan(0.9);
  });

  it("英文词形归一 (retry/retries) 与空文本安全", () => {
    const [a, b] = embedder.embed(["retry policy", "retries policy"]) as number[][];
    expect(cosine(a!, b!)).toBeGreaterThan(0.8);
    const [empty] = embedder.embed([""]) as number[][];
    expect(empty?.every((x) => Number.isFinite(x))).toBe(true);
  });
});
