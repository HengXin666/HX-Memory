// scripts/eval-retrieval.ts — 检索质量评测: 同义改写的召回率 (用户核心诉求)。
//
// 背景: 精确/字面匹配在"同一件事换个说法"上会失效。这个脚本量化"到底差多少、修完是多少"。
// 用法: node --experimental-strip-types scripts/eval-retrieval.ts
//
// 方法: 每条记忆配一个**字面不重合但语义相同**的查询 (paraphrase);
// 对比三种配置的 Recall@1/@3:
//   A. 字面 only  (无向量通道, 模拟 v1 的关键词包含)
//   B. 本地离线语义 (LaxicalEmbedder, 零依赖)
//   C. 真语义嵌入 (OpenAI 兼容端点; 未配置时跳过)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../src/storage/file-store.ts";
import { HybridRetriever } from "../src/retrieval/hybrid.ts";
import { LinearVectorIndex } from "../src/retrieval/vector.ts";
import { ProjectedVectorIndex } from "../src/retrieval/vector-projected.ts";
import { LexicalEmbedder } from "../src/retrieval/embedding-lexical.ts";
import { openAiEmbedderFromEnv } from "../src/retrieval/embedding-http.ts";

/** 语料: [记忆内容, 同义查询] —— 查询尽量不与原文共享长词 (模拟真实改写)。 */
const CASES: Array<[string, string]> = [
  ["每次发版之前要跑一遍完整校验", "上线前应该做什么检查"],
  ["容器并发要显式设置上限", "服务并行处理需要限制并发度"],
  ["数据库连接池超时要设置重试与熔断", "DB 连接拿不到时的兜底策略"],
  ["缓存过期时间统一设为 60 秒", "本地缓存多久失效"],
  ["接口鉴权失败要返回 401 而不是 500", "权限校验不通过时的状态码"],
  ["消息队列堆积时要先限流再扩容", "下游消费不过来怎么办"],
  ["日志采样率提高到 10% 方便排查", "线上问题定位需要更详细的记录"],
  ["前端构建产物要开启 gzip 压缩", "静态资源体积优化"],
  ["定时任务必须加分布式锁防止重复执行", "多实例调度同一个 job 会打架"],
  ["回滚方案必须在发布前准备好", "出事之前要先想好怎么退回去"],
];

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

async function evaluate(label: string, retriever: HybridRetriever, warmup: () => Promise<void>) {
  await warmup();
  let hit1 = 0;
  let hit3 = 0;
  const misses: string[] = [];
  for (const [content, query] of CASES) {
    const out = retriever.retrieveSync({ text: query, limit: 3 });
    const ids = out.hits.map((h) => h.entry.content);
    if (ids[0] === content) hit1++;
    if (ids.includes(content)) hit3++;
    else misses.push(query + " → " + (ids[0] ?? "(空)"));
  }
  const pct = (n: number) => ((n / CASES.length) * 100).toFixed(0) + "%";
  console.log(
    `${label.padEnd(26)} Recall@1=${pct(hit1).padStart(4)}  Recall@3=${pct(hit3).padStart(4)}`,
  );
  if (misses.length) for (const m of misses.slice(0, 3)) console.log("   miss: " + m);
  return { hit1, hit3 };
}

const root = mkdtempSync(join(tmpdir(), "hxmem-eval-"));
const store = new FileBackend({ root });
CASES.forEach(([content], i) => {
  store.add({ id: "m" + i, kind: "lesson", content, source: "eval", scope: "agent", ts: T });
});

console.log("语料: " + CASES.length + " 条记忆, 每条配一个同义改写查询\n");

// A. 字面 only
const literal = new HybridRetriever(store, {
  capabilities: {
    engine: "sqlite-fts5+cjk",
    fullText: true,
    cjk: true,
    semantic: false,
    graph: "relations",
    multiProcess: true,
  },
});
await evaluate("A. 字面 only", literal, async () => undefined);

// B. 本地离线语义 (词典归一 + 字级 n-gram, 同步)
const lexical = new LexicalEmbedder();
const lexicalIndex = new LinearVectorIndex({ embedder: lexical });
const localRetriever = new HybridRetriever(store, { vectorIndex: lexicalIndex });
await evaluate("B. 本地离线语义", localRetriever, async () => undefined);

// C. 真语义嵌入 (需要 HX_MEMORY_EMBEDDING_BASE_URL + MODEL)
const httpEmbedder = openAiEmbedderFromEnv();
if (!httpEmbedder) {
  console.log("C. 真语义嵌入          (跳过: 未配置 HX_MEMORY_EMBEDDING_BASE_URL/MODEL)");
} else {
  const projected = new ProjectedVectorIndex({ embedder: httpEmbedder, floor: 0.3 });
  const semanticRetriever = new HybridRetriever(store, { vectorIndex: projected });
  await evaluate("C. 真语义嵌入", semanticRetriever, async () => {
    await projected.refresh();
    await projected.refresh();
  });
}

store.close();
rmSync(root, { recursive: true, force: true });
