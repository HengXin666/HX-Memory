// scripts/bench-retrieval.ts — 本地性能基准: 万级记忆的读写延迟 (目标: 检索 < 1s)。
// 用法: node --experimental-strip-types scripts/bench-retrieval.ts [N]
// 说明: 这是一份"可复现的性能凭据", 不是断言测试 (CI 机器性能波动大, 断言会变成 flaky)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../src/storage/file-store.ts";
import { HybridRetriever } from "../src/retrieval/hybrid.ts";
import { LinearVectorIndex } from "../src/retrieval/vector.ts";
import { HashingEmbedder } from "../src/retrieval/embedding.ts";
import { MemoryFacade } from "../src/app/facade.ts";

const N = Number(process.argv[2] ?? 10000);
const root = mkdtempSync(join(tmpdir(), "hxmem-bench-"));
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

const TOPICS = [
  "容器并发策略",
  "数据库连接池超时",
  "部署流水线回滚",
  "缓存过期时间",
  "接口鉴权失效",
  "前端构建缓存",
  "消息队列堆积",
  "日志采样策略",
];
const WORDS = ["上限", "重试", "幂等", "熔断", "限流", "降级", "回滚", "超时"];

function content(i: number): string {
  const topic = TOPICS[i % TOPICS.length]!;
  const word = WORDS[i % WORDS.length]!;
  return `第 ${i} 条经验: ${topic}要显式设置${word}, 项目 p${i % 20} 中踩过坑 (id=${i})`;
}

const ms = (start: number): number => Number((performance.now() - start).toFixed(1));
const store = new FileBackend({ root });
const embedder = new HashingEmbedder();
const vectorIndex = new LinearVectorIndex({ embedder });
const retriever = new HybridRetriever(store, { vectorIndex });
const facade = new MemoryFacade({ store, retriever }, { embedder });

// ---- 写入 ----
let t = performance.now();
for (let i = 0; i < N; i++) {
  store.add({
    id: "m" + i,
    kind: i % 7 === 0 ? "decision" : "lesson",
    content: content(i),
    source: "bench:" + (i % 50),
    scope: "project",
    project: "p" + (i % 20),
    tags: ["t" + (i % 20)],
    ts: T,
  });
}
const writeMs = ms(t);

// ---- 检索 (冷: 首次会建向量索引) ----
const queries = [
  "容器并发上限",
  "连接池超时重试",
  "部署回滚",
  "缓存过期",
  "鉴权限流",
  "队列堆积",
  "日志采样",
  "前端构建",
  "并发幂等",
  "超时熔断",
];

t = performance.now();
const cold = retriever.retrieveSync({ text: queries[0]!, limit: 8 });
const coldMs = ms(t);

t = performance.now();
const ITER = 50;
let hits = 0;
for (let i = 0; i < ITER; i++) {
  hits += retriever.retrieveSync({ text: queries[i % queries.length]!, limit: 8 }).hits.length;
}
const warmMs = ms(t);
const perQuery = Number((warmMs / ITER).toFixed(2));

// ---- 记忆写入 (含裁决 + 索引) ----
t = performance.now();
for (let i = 0; i < 20; i++)
  await facade.remember({ content: content(1_000_000 + i), kind: "lesson", project: "pbench" });
const rememberMs = ms(t);
const perRemember = Number((rememberMs / 20).toFixed(2));

// ---- 面板/统计 ----
t = performance.now();
const stats = await facade.stats();
const statsMs = ms(t);

t = performance.now();
const recent = await facade.recent(20);
const recentMs = ms(t);

t = performance.now();
const verify = await store.verify();
const verifyMs = ms(t);

t = performance.now();
const rebuild = store.rebuildFromTruth();
const rebuildMs = ms(t);

console.log(
  JSON.stringify(
    {
      entries: N,
      write_total_ms: writeMs,
      write_per_entry_ms: Number((writeMs / N).toFixed(3)),
      cold_first_query_ms: coldMs,
      warm_query_avg_ms: perQuery,
      warm_queries: ITER,
      hits: hits,
      vector_index_rows: vectorIndex.size(),
      facade_remember_avg_ms: perRemember,
      stats_ms: statsMs,
      stats_total: stats.total,
      recent_ms: recentMs,
      recent_rows: recent.length,
      verify_ms: verifyMs,
      verify_ok: verify.ok,
      rebuild_ms: rebuildMs,
      rebuilt: rebuild,
      cold_hits: cold.hits.length,
    },
    null,
    2,
  ),
);

store.close();
rmSync(root, { recursive: true, force: true });
