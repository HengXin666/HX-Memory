// tests/s2/retrieval-store.test.ts — 检索层 × 真实存储的端到端契约。
//
// S1 用假 source 测"排序/过滤/预算"的逻辑; 这里测"接线是真的":
// FileBackend 满足 RetrievalSource、能力自述来自真实引擎、Binder 传了 retriever 就真的走混合检索。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { Binder, type BindingConfig } from "../../src/kernel/binder.ts";
import type { RetrievalSource } from "../../src/kernel/ports.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: "lesson",
    content: "容器并发要显式设上限",
    source: "session:s1",
    scope: "project",
    project: "api",
    ts: T,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-retrieval-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("检索层 × FileBackend", () => {
  it("FileBackend 满足 RetrievalSource (端口有实现, 不是文档)", () => {
    const source: RetrievalSource = store;
    expect(typeof source.searchText).toBe("function");
    expect(typeof source.traverse).toBe("function");
  });

  it("能力自述来自真实引擎 (FTS5 + 中文), 且不谎报语义检索", () => {
    const caps = new HybridRetriever(store).capabilities();
    expect(caps.engine).toBe("sqlite-fts5+cjk");
    expect(caps.fullText).toBe(true);
    expect(caps.cjk).toBe(true);
    expect(caps.semantic).toBe(false);
    expect(caps.multiProcess).toBe(true);
  });

  it("2 字中文查询端到端召回 (存储 → FTS → 融合 → 结果)", () => {
    store.add(entry({ id: "c1", content: "所有容器实际上都有并发策略问题" }));
    store.add(entry({ id: "c2", content: "数据库连接池超时设置" }));
    const out = new HybridRetriever(store).retrieveSync({ text: "并发" });
    expect(out.hits.map((h) => h.entry.id)).toContain("c1");
    expect(out.hits.map((h) => h.entry.id)).not.toContain("c2");
  });

  it("已确认规则跨项目生效 (project 过滤不会把它挡掉)", () => {
    store.add(
      entry({
        id: "rule-global",
        kind: "rule",
        scope: "global",
        project: undefined,
        content: "涉及容器/并发时先检查并发策略",
        confirmedBy: "hx",
        confirmedAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    store.add(entry({ id: "other", project: "web", content: "前端样式调整" }));
    const out = new HybridRetriever(store).retrieveSync({
      text: "容器并发",
      scope: { project: "api" },
    });
    expect(out.hits.map((h) => h.entry.id)).toContain("rule-global");
    expect(out.hits.map((h) => h.entry.id)).not.toContain("other");
  });

  it("项目隔离: 别的项目的本地经验不会被召回", () => {
    store.add(entry({ id: "api-1", project: "api", content: "容器并发上限设为 10" }));
    store.add(entry({ id: "web-1", project: "web", content: "容器并发上限设为 20" }));
    const out = new HybridRetriever(store).retrieveSync({
      text: "容器并发上限",
      scope: { project: "api" },
    });
    expect(out.hits.map((h) => h.entry.id)).toEqual(["api-1"]);
  });

  it("真实演化链: 命中旧条目时返回最新 active 版本", () => {
    store.add(entry({ id: "v1", content: "容器并发上限 10" }));
    store.add(
      entry({
        id: "v2",
        content: "容器并发上限 50",
        relations: [{ type: "supersedes", toId: "v1" }],
      }),
    );
    store.update("v1", {
      status: "superseded",
      relations: [{ type: "supersededBy", toId: "v2" }],
    });
    const out = new HybridRetriever(store).retrieveSync({ text: "容器并发上限" });
    expect(out.hits.map((h) => h.entry.id)).toContain("v2");
    expect(out.hits.map((h) => h.entry.id)).not.toContain("v1");
  });
});

describe("Binder: 传入 retriever 后走混合检索", () => {
  const configs: BindingConfig[] = [
    {
      project: "api",
      bindings: [
        { id: "rules", query: { kind: "rule", scope: "global" }, max: 3 },
        {
          id: "concurrency",
          query: { scope: "project", project: "api" },
          max: 3,
          signalWords: ["容器", "并发"],
        },
      ],
    },
  ];

  it("绑定注入命中 2 字中文查询 (signalWords 门控 + 检索排序)", () => {
    store.add(entry({ id: "c1", content: "所有容器实际上都有并发策略问题" }));
    store.add(
      entry({
        id: "rule-1",
        kind: "rule",
        scope: "global",
        project: undefined,
        content: "涉及容器时先检查并发策略",
        confirmedBy: "hx",
        confirmedAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    const binder = new Binder(
      (q) => store.query(q),
      () => configs,
      new HybridRetriever(store),
    );
    const injected = binder.injectFor("api", "帮我看看容器并发的问题");
    expect(injected).toContain("c1");
    expect(injected).toContain("rule-1");
  });

  it("信号词不命中 → 不注入 (轻量门控, 避免无关噪声)", () => {
    store.add(entry({ id: "c1", content: "容器并发上限" }));
    const binder = new Binder(
      (q) => store.query(q),
      () => configs,
      new HybridRetriever(store),
    );
    expect(binder.injectFor("api", "今天天气不错")).toBe("");
  });
});
