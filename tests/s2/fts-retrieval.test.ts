// tests/s2/fts-retrieval.test.ts — 全文索引 (FTS5) 的真实行为: 中文可召回、重建不丢、降级可见。
//
// 背景 (实测): FTS5 unicode61 对连续汉字不分词, trigram 又无法匹配 2 字查询。
// 因此索引侧与查询侧都走 kernel/cjk.ts 的"词 + bigram"双列方案 —— 这个测试就是它的端到端证据。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    kind: "lesson",
    content: "容器并发要显式设上限",
    source: "session:s1",
    scope: "agent",
    ts: T,
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-fts-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("全文检索: 中文 2 字查询可召回 (v1 的 includes() 做不到稳定排序)", () => {
  it("FTS5 可用时状态自述为 available", () => {
    const s = store.ftsStatus();
    expect(s.available).toBe(true);
    expect(s.degraded).toBeNull();
  });

  it("2 字中文查询命中 (索引侧 bigram 兜底)", () => {
    store.add(entry({ id: "c1", content: "所有容器实际上都有并发策略问题" }));
    store.add(entry({ id: "c2", content: "数据库连接池超时设置" }));
    const hits = store.searchText("并发", 10);
    expect(hits.map((h) => h.id)).toContain("c1");
    expect(hits.map((h) => h.id)).not.toContain("c2");
  });

  it("相关度排序: 命中越多词的排前面", () => {
    store.add(entry({ id: "weak", content: "并发相关的泛泛而谈" }));
    store.add(entry({ id: "strong", content: "并发 容器 上限 策略 并发 容器" }));
    const hits = store.searchText("容器 并发", 10);
    expect(hits[0]?.id).toBe("strong");
  });

  it("英文/数字查询正常", () => {
    store.add(entry({ id: "en", content: "Prefer pnpm over npm in monorepos" }));
    expect(store.searchText("pnpm", 5).map((h) => h.id)).toEqual(["en"]);
  });

  it("摘要/要点/标签也进检索面 (不只搜正文)", () => {
    store.add(
      entry({
        id: "s1",
        content: "正文不含关键词",
        tags: ["concurrency"],
        structured: { summary: "并发策略需要显式上限", points: ["池大小固定"] },
      }),
    );
    expect(store.searchText("并发策略", 5).map((h) => h.id)).toEqual(["s1"]);
    expect(store.searchText("concurrency", 5).map((h) => h.id)).toEqual(["s1"]);
  });

  it("无关查询返回空 (而不是全量返回)", () => {
    store.add(entry({ id: "c1", content: "容器并发要显式设上限" }));
    expect(store.searchText("量子纠缠退相干", 5)).toEqual([]);
  });
});

describe("全文索引是派生物: 重建/更新/撤回都不留幽灵", () => {
  it("更新正文后旧文本搜不到, 新文本搜得到 (FTS 先删后插)", () => {
    // 用互不共享 bigram 的两个词, 才是在测"索引被替换"而不是 bigram 的宽召回。
    store.add(entry({ id: "u1", content: "旧的踩坑记录甲种" }));
    store.update("u1", { content: "新的踩坑记录乙类" });
    expect(store.searchText("甲种", 5)).toEqual([]);
    expect(store.searchText("乙类", 5).map((h) => h.id)).toEqual(["u1"]);
  });

  it("bigram 是宽召回: 共享 2 字就会命中 (精度由检索层的覆盖率过滤负责)", () => {
    store.add(entry({ id: "wide", content: "新的踩坑记录乙类" }));
    // "旧记录" 的 bigram 里含 "记录", 与上面共享 → 仍会命中, 但排序靠后; 这是设计取舍 (召回优先)。
    expect(store.searchText("旧记录", 5).map((h) => h.id)).toContain("wide");
  });

  it("撤回后不再被召回 (shadow 不可见), 但真相文件里仍在", () => {
    store.add(entry({ id: "r1", content: "可撤回的记忆内容" }));
    store.remove("r1");
    expect(store.searchText("可撤回", 5)).toEqual([]);
    expect(store.get("r1")?.status).toBe("shadow");
    expect(store.searchText("可撤回", 5, { includeHidden: true }).map((h) => h.id)).toEqual(["r1"]);
  });

  it("删库重建 (rebuildFromFiles) 后全文索引仍可用且计数一致", () => {
    store.add(entry({ id: "a1", content: "容器并发策略" }));
    store.add(entry({ id: "a2", content: "数据库连接池" }));
    store.rebuildFromFiles();
    expect(store.ftsStatus().indexed).toBe(store.ftsStatus().expected);
    expect(store.searchText("连接池", 5).map((h) => h.id)).toEqual(["a2"]);
    expect(store.searchText("并发", 5).map((h) => h.id)).toEqual(["a1"]);
  });

  it("分词版本变化 → 打开时自动重建 (混用两套分词 = 静默召回失真)", () => {
    store.add(entry({ id: "v1", content: "分词版本变化要重建索引" }));
    // 伪造"旧版本索引"
    store.close();
    const probe = new FileBackend({ root });
    const db = (
      probe as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }
    ).db;
    db.prepare("UPDATE index_meta SET value = '0' WHERE key = 'tokenizer_version'").run();
    probe.close();
    store = new FileBackend({ root });
    expect(store.ftsStatus().indexed).toBe(1);
    expect(store.searchText("分词", 5).map((h) => h.id)).toEqual(["v1"]);
  });

  it("FTS 行与 memories 行一一对应 (新增/更新/撤回后都不漂移)", () => {
    store.add(entry({ id: "n1", content: "第一条" }));
    store.add(entry({ id: "n2", content: "第二条" }));
    store.update("n1", { content: "第一条改" });
    store.remove("n2");
    const s = store.ftsStatus();
    expect(s.indexed).toBe(s.expected);
  });
});
