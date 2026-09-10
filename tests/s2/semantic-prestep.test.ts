// tests/s2/semantic-prestep.test.ts — 真语义检索在预步注入路径上的行为 (含硬时限权衡)。
//
// 这条链路把三件事缝在一起: 远端嵌入器 (异步) + 投影索引 (后台补齐) + 同步预步注入。
// 契约: **预热最多花 warmupMs, 绝不阻塞对话**; 没补完就降级并在结果里说明。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { ProjectedVectorIndex } from "../../src/retrieval/vector-projected.ts";
import { OpenAiCompatibleEmbedder } from "../../src/retrieval/embedding-http.ts";
import { Binder, type BindingConfig } from "../../src/kernel/binder.ts";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";

let server: Server;
let baseUrl: string;
let delayMs = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { input?: string[] };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [];
      const vectors = inputs.map((t) =>
        /部署|上线|发布|发版|deploy|release|校验|回归/i.test(t) ? [1, 0, 0] : [0, 1, 0],
      );
      const respond = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
        );
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});
afterAll(() => server.close());

async function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "hxmem-sem-"));
  const store = new FileBackend({ root });
  store.add({
    id: "deploy",
    kind: "lesson",
    scope: "project",
    project: "api",
    content: "每次发版之前要跑一遍完整校验",
    source: "t",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    tags: ["release"],
  });
  const embedder = new OpenAiCompatibleEmbedder({ baseUrl, model: "stub" });
  const index = new ProjectedVectorIndex({ embedder, floor: 0.5 });
  const retriever = new HybridRetriever(store, { vectorIndex: index });
  const configs: BindingConfig[] = [
    {
      project: "api",
      bindings: [
        {
          id: "api-memory",
          query: { scope: "project", project: "api" },
          max: 5,
          signalWords: ["上线", "发版", "发布"],
        },
      ],
    },
  ];
  const binder = new Binder(
    (q) => store.query(q),
    () => configs,
    retriever,
  );
  return { root, store, index, retriever, binder };
}

function payload(text: string) {
  return {
    agent: { session: { id: "s1", header: { origin: "root", cwd: "/code/api" } } },
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] }],
    step: 1,
  };
}

const next = async () => ({ kind: "enter" as const, messages: [] });

describe("预步注入 × 真语义检索", () => {
  it("首次预热 (时限内补齐) → 字面不重合的查询也能语义召回", async () => {
    delayMs = 0;
    const h = await makeHarness();
    const handler = makePreStepHandler(h.binder, {
      rootAgentsOnly: () => true,
      enabled: () => true,
      projectOf: () => "api",
      warmupMs: () => 200,
    });
    const decision = await handler(payload("上线前我要做什么?"), next);
    const messages =
      decision.kind === "enter"
        ? (decision.messages as Array<{ content: Array<{ text: string }> }>)
        : [];
    const texts = messages.map((m) => m.content.map((c) => c.text).join("")).join("\n");
    expect(texts).toContain("每次发版之前要跑一遍完整校验");
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
  });

  it("嵌入服务慢于硬时限 → 不注入空等 (降级而不是阻塞)", async () => {
    delayMs = 500; // 远大于 warmupMs
    const h = await makeHarness();
    const handler = makePreStepHandler(h.binder, {
      rootAgentsOnly: () => true,
      enabled: () => true,
      projectOf: () => "api",
      warmupMs: () => 30,
    });
    const started = performance.now();
    const decision = await handler(payload("上线前我要做什么?"), next);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(400); // 远小于服务延迟, 说明真的没有空等
    // 本轮可能注入不到 (投影未就绪), 但绝不能超时阻塞
    expect(decision.kind).toBe("enter");
    // 让后台请求结束, 避免悬挂
    await h.index.refresh();
    delayMs = 0;
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
  });

  it("warmupMs=0 时完全不等待 (最保守配置)", async () => {
    delayMs = 300;
    const h = await makeHarness();
    const handler = makePreStepHandler(h.binder, {
      rootAgentsOnly: () => true,
      enabled: () => true,
      projectOf: () => "api",
      warmupMs: () => 0,
    });
    const started = performance.now();
    await handler(payload("上线前我要做什么?"), next);
    expect(performance.now() - started).toBeLessThan(150);
    delayMs = 0;
    h.store.close();
    rmSync(h.root, { recursive: true, force: true });
  });
});
