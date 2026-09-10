// tests/conformance/paraphrase-recall.test.ts — 语义检索的端到端质量契约 (用户核心诉求)。
//
// 为什么要有这条: "记忆是精确匹配"是本项目最初的硬伤 —— 同一件事换个说法就找不到。
// 这条测试固定一份语料与同义改写查询, 断言 Recall@3 达到阈值; 任何回归都会在这里被拦下。
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { LinearVectorIndex } from "../../src/retrieval/vector.ts";
import { LexicalEmbedder } from "../../src/retrieval/embedding-lexical.ts";

const CORPUS: Array<{ content: string; paraphrases: string[] }> = [
  {
    content: "每次发版之前要跑一遍完整校验",
    paraphrases: ["上线前应该做什么检查", "发布流程需要哪些把关"],
  },
  {
    content: "容器并发要显式设置上限",
    paraphrases: ["服务并行处理需要限制并发度", "要不要给并发加个天花板"],
  },
  {
    content: "数据库连接池超时要设置重试与熔断",
    paraphrases: ["DB 连接拿不到时的兜底策略", "拿不到连接怎么办"],
  },
  { content: "缓存过期时间统一设为 60 秒", paraphrases: ["本地缓存多久失效", "缓存什么时候过期"] },
  {
    content: "接口鉴权失败要返回 401 而不是 500",
    paraphrases: ["权限校验不通过时的状态码", "没登录该返回什么码"],
  },
  {
    content: "消息队列堆积时要先限流再扩容",
    paraphrases: ["下游消费不过来怎么办", "队列堵了怎么处理"],
  },
  {
    content: "日志采样率提高到 10% 方便排查",
    paraphrases: ["线上问题定位需要更详细的记录", "怎么让日志更有用"],
  },
  {
    content: "前端构建产物要开启 gzip 压缩",
    paraphrases: ["静态资源体积优化", "怎么让页面加载更快"],
  },
  {
    content: "定时任务必须加分布式锁防止重复执行",
    paraphrases: ["多实例调度同一个 job 会打架", "任务被跑了两遍"],
  },
  {
    content: "回滚方案必须在发布前准备好",
    paraphrases: ["出事之前要先想好怎么退回去", "上线前要不要准备回退方案"],
  },
];

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function build(withSemantic: boolean): HybridRetriever {
  const store = new MemoryBackend();
  CORPUS.forEach((item, i) =>
    store.add({
      id: "m" + i,
      kind: "lesson",
      content: item.content,
      source: "eval",
      scope: "agent",
      ts: T,
    }),
  );
  if (!withSemantic) return new HybridRetriever(store);
  return new HybridRetriever(store, {
    vectorIndex: new LinearVectorIndex({ embedder: new LexicalEmbedder() }),
  });
}

function recall(retriever: HybridRetriever, k: number): number {
  let hit = 0;
  let total = 0;
  for (const item of CORPUS) {
    for (const paraphrase of item.paraphrases) {
      total++;
      const hits = retriever.retrieveSync({ text: paraphrase, limit: k }).hits;
      if (hits.some((h) => h.entry.content === item.content)) hit++;
    }
  }
  return hit / total;
}

describe("同义改写召回 (v1 的核心缺陷)", () => {
  it("只有字面检索时召回很差 (证明这个缺陷真实存在, 不是假想)", () => {
    expect(recall(build(false), 3)).toBeLessThan(0.5);
  });

  it("开启离线语义后 Recall@3 达到 0.8 以上", () => {
    expect(recall(build(true), 3)).toBeGreaterThanOrEqual(0.8);
  });

  it("语义检索显著优于字面检索 (相对提升 >= 2 倍)", () => {
    const literal = recall(build(false), 3);
    const semantic = recall(build(true), 3);
    expect(semantic).toBeGreaterThanOrEqual(Math.max(0.5, literal * 2));
  });

  it("无关查询仍然不返回东西 (语义通道没有把噪声放进来)", () => {
    const retriever = build(true);
    expect(retriever.retrieveSync({ text: "量子退相干实验装置校准", limit: 3 }).hits).toEqual([]);
  });
});
