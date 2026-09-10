// tests/s2/embedding-http.test.ts — OpenAI 兼容远端嵌入器 (真·语义检索的接入点)。
//
// 用一个本地 stub 服务验证协议细节: 批量/乱序响应/维度身份/超时/失败传播。
// 这样即使没有外网, "真语义向量"这条路径也是被测试覆盖的。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { OpenAiCompatibleEmbedder } from "../../src/retrieval/embedding-http.ts";
import { ProjectedVectorIndex } from "../../src/retrieval/vector-projected.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";
import type { RetrievalSource } from "../../src/kernel/ports.ts";

let server: Server;
let baseUrl: string;
let seenAuth: string | undefined;
let seenModel: string | undefined;
let requestCount = 0;
/** 用确定性"语义"函数模拟真模型: 部署/上线/发布 同类; 其它按字母分组。 */
function fakeVector(text: string): number[] {
  if (/部署|上线|发布|deploy|release/i.test(text)) return [1, 0, 0];
  if (/并发|容器|锁|限流/i.test(text)) return [0, 1, 0];
  return [0, 0, 1];
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requestCount++;
    seenAuth = req.headers["authorization"] as string | undefined;
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { model?: string; input?: string[] };
      seenModel = parsed.model;
      const inputs = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? "")];
      if (inputs.some((t) => t.includes("触发错误"))) {
        res.writeHead(500).end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      // 故意乱序返回 + 带 index, 验证客户端会按 index 归位。
      res.end(
        JSON.stringify({
          data: inputs.map((t, i) => ({ index: i, embedding: fakeVector(t) })).reverse(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});
afterAll(() => {
  server.close();
});

const entry = (id: string, content: string): MemoryEntry => ({
  id,
  kind: "lesson",
  content,
  source: "t",
  scope: "agent",
  ts: { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" },
  status: "active",
});

describe("OpenAiCompatibleEmbedder", () => {
  it("协议: POST /embeddings + Bearer + model 字段 + 按 index 归位", async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: "m1", apiKey: "k1" });
    const vectors = await embedder.embed(["部署流程", "并发上限", "无关内容"]);
    expect(seenAuth).toBe("Bearer k1");
    expect(seenModel).toBe("m1");
    expect(vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(embedder.dim).toBe(3);
  });

  it("批量分批: batchSize=2 时 5 条 → 3 次请求", async () => {
    requestCount = 0;
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: "m1", batchSize: 2 });
    await embedder.embed(["a", "b", "c", "d", "e"]);
    expect(requestCount).toBe(3);
  });

  it("HTTP 错误会传播 (由投影层决定重试, 而不是被静默吞掉)", async () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: "m1" });
    await expect(embedder.embed(["触发错误"])).rejects.toThrow(/500/);
  });

  it("身份串包含模型与端点 (换模型/换端点 = 换索引身份)", () => {
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl: baseUrl + "/", model: "bge-m3" });
    expect(embedder.id).toBe(`openai-compat:bge-m3@${baseUrl}`);
  });

  it("环境变量驱动 (没配就退回本地默认)", async () => {
    const { openAiEmbedderFromEnv } = await import("../../src/retrieval/embedding-http.ts");
    expect(openAiEmbedderFromEnv({})).toBeNull();
    expect(openAiEmbedderFromEnv({ HX_MEMORY_EMBEDDING_BASE_URL: baseUrl })).toBeNull();
    const fromEnv = openAiEmbedderFromEnv({
      HX_MEMORY_EMBEDDING_BASE_URL: baseUrl,
      HX_MEMORY_EMBEDDING_MODEL: "m2",
      HX_MEMORY_EMBEDDING_API_KEY: "k2",
    });
    expect(fromEnv?.id).toContain("m2");
  });
});

describe("真语义检索端到端 (远端嵌入器 + 投影索引 + 混合检索)", () => {
  class TinySource implements RetrievalSource {
    constructor(private readonly entries: MemoryEntry[]) {}
    searchText(text: string, limit = 20): MemoryEntry[] {
      // 故意只做整串包含: 与真语义无关的查询在这里必然搜不到 (逼着向量通道兜住)。
      return this.entries.filter((e) => e.content.includes(text)).slice(0, limit);
    }
    query(q: Query): MemoryEntry[] {
      return this.entries.slice(0, q.limit ?? 50);
    }
    get(id: string): MemoryEntry | null {
      return this.entries.find((e) => e.id === id) ?? null;
    }
    traverse(): MemoryEntry[] {
      return [];
    }
  }

  it("字面完全不重合但语义同类 → 由 vector 通道召回", async () => {
    const entries = [
      entry("deploy", "每次发布之前要跑一遍完整校验"),
      entry("ui", "按钮圆角改成 8px"),
    ];
    const source = new TinySource(entries);
    const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: "m1" });
    const index = new ProjectedVectorIndex({ embedder, floor: 0.5 });
    const retriever = new HybridRetriever(source, { vectorIndex: index });

    // 第一次: 投影还没暖 (向量在后台补), 结果里会说明降级
    const first = retriever.retrieveSync({ text: "上线前要做什么", limit: 3 });
    expect(first.hits.map((h) => h.entry.id)).not.toContain("deploy");
    expect(first.degraded.some((d) => d.includes("projection-warming"))).toBe(true);

    // 等投影补齐 (真实宿主会在注入前带硬时限 await refresh; 这里直接 await)
    await index.refresh();
    await index.refresh(); // 第二次补上查询向量
    const second = retriever.retrieveSync({ text: "上线前要做什么", limit: 3 });
    const hit = second.hits.find((h) => h.entry.id === "deploy");
    expect(hit?.channels).toContain("vector");
    expect(second.degraded.some((d) => d.includes("projection-warming"))).toBe(false);
    expect(second.hits.map((h) => h.entry.id)).not.toContain("ui");
  });
});
