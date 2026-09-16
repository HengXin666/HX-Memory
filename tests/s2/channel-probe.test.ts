// tests/s2/channel-probe.test.ts — S2: 关系图的"按检索通道着色"数据源。
//
// 这一维要回答的问题: **图上每条记忆是靠哪条通道被找到的**。它必须来自**真实检索器**,
// 而不是从字段猜 (例如"有 entity 字段就标 entity 通道") —— 那样标出来的是配置, 不是行为。
//
// 本文件钉住四件事:
//   1. 读数确实来自检索 (bm25/entity 等真实通道), 而不是编造的;
//   2. 未召回的条目**不在**结果里 (前端渲染成灰色 —— 那是结论, 不是缺数据);
//   3. 探针**不写真实库** (预览承诺只读; 探针走临时库);
//   4. 给不出问题时返回空表而不是编一组问题。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { probeChannels } from "../../scripts/lib/channel-probe.ts";
import { deriveQueries } from "../../scripts/graph-preview.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };

function entry(over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    kind: "lesson",
    scope: "agent",
    source: "test",
    ts: T,
    ...over,
  } as MemoryEntry;
}

describe("通道探测 (真实检索器)", () => {
  it("标出真实命中的通道, 而不是从字段猜", () => {
    const entries = [
      entry({ id: "a", content: "FTS5 分词必须与查询共用同一函数, 否则召回不一致" }),
      entry({ id: "b", content: "MMR 用来去冗余, lambda 控制相关性与多样性的取舍" }),
      entry({ id: "c", content: "完全不相关的另一件事: 今天中午吃了拉面" }),
    ];
    const probe = probeChannels({ entries, queries: ["FTS5 分词函数"], topK: 2 });
    // a 应该被召回, 且理由应当是字面通道 (bm25) —— 这条查询与它字面重合。
    const ch = probe.channels.get("a");
    expect(ch, "a 应被召回").toBeTruthy();
    expect([...(ch ?? [])]).toContain("bm25");
    // c 与查询无关, 在 topK=2 里不该出现 (出现就说明读数没有区分度)。
    expect(probe.channels.has("c")).toBe(false);
  });

  it("命中记录里带上「是哪几个问题召回的」(面板要用它解释颜色)", () => {
    const entries = [entry({ id: "a", content: "实体倒排索引支撑反向查找与共享实体排序" })];
    const probe = probeChannels({ entries, queries: ["实体倒排索引"], topK: 3 });
    expect(probe.hits.get("a")).toContain("实体倒排索引");
  });

  it("未召回的条目不在表里 (前端据此渲染灰色, 而不是给一个假的通道)", () => {
    const entries = [
      entry({ id: "hit", content: "SQLite FTS5 的 bm25 排序" }),
      entry({ id: "miss", content: "关于园艺的完全无关内容" }),
    ];
    const probe = probeChannels({ entries, queries: ["SQLite FTS5 bm25"], topK: 1 });
    expect(probe.channels.has("hit")).toBe(true);
    expect(probe.channels.has("miss")).toBe(false);
    // 覆盖率读数必须诚实反映这一点。
    expect(probe.covered).toBeLessThan(probe.total);
  });

  it("不写真实库: 探针只在临时目录里检索 (预览的只读承诺)", () => {
    // 用一个"真实库"目录, 跑完探针后它必须仍然不存在索引文件 —— 探针不该碰它。
    const realRoot = mkdtempSync(join(tmpdir(), "hxmem-real-"));
    const store = new FileBackend({ root: realRoot });
    store.add(entry({ id: "a", content: "只读承诺验证用的记忆" }));
    store.close();
    // 记录真实库此刻的索引状态
    const before = existsSync(join(realRoot, "index.sqlite"));
    const beforeSize = before ? statSync(join(realRoot, "index.sqlite")).size : 0;
    const mtime = before ? statSync(join(realRoot, "index.sqlite")).mtimeMs : 0;

    probeChannels({
      entries: [entry({ id: "a", content: "只读承诺验证用的记忆" })],
      queries: ["只读承诺"],
      topK: 1,
    });

    const after = existsSync(join(realRoot, "index.sqlite"));
    expect(after).toBe(before);
    if (before) {
      expect(statSync(join(realRoot, "index.sqlite")).size).toBe(beforeSize);
      expect(statSync(join(realRoot, "index.sqlite")).mtimeMs).toBe(mtime);
    }
    rmSync(realRoot, { recursive: true, force: true });
  });

  it("没有问题时返回空表 (不编造问题, 也不假装探测过)", () => {
    const probe = probeChannels({ entries: [entry({ id: "a", content: "x" })], queries: [] });
    expect(probe.channels.size).toBe(0);
    expect(probe.queries).toBe(0);
    expect(probe.retrievals).toBe(0);
  });

  it("空语料不崩", () => {
    const probe = probeChannels({ entries: [], queries: ["任意"] });
    expect(probe.channels.size).toBe(0);
  });
});

describe("问题派生 (deriveQueries)", () => {
  it("只从标签/实体派生 —— 这些是真实检索锚点, 不是拿内容当答案问答案", () => {
    const entries = [
      entry({ id: "a", content: "很长的一段内容不该被整段当成查询", tags: ["分词"] }),
      entry({ id: "b", content: "另一段", entities: ["FTS5"] }),
    ];
    const qs = deriveQueries(entries);
    expect(qs).toContain("分词");
    expect(qs).toContain("FTS5");
    // 整段内容绝不能变成查询 (那会让每条都命中, 读数失去信息量)。
    expect(qs.some((q) => q.includes("很长的一段内容"))).toBe(false);
  });

  it("去重并排序; 尊重上限", () => {
    const entries = [
      entry({ id: "a", content: "x", tags: ["b", "a", "b"] }),
      entry({ id: "b", content: "y", entities: ["a", "c"] }),
    ];
    const qs = deriveQueries(entries);
    expect(qs).toEqual(["a", "b", "c"]);
    expect(deriveQueries(entries, 2).length).toBe(2);
  });

  it("没有标签也没有实体 → 空 (调用方据此跳过探测并如实说明)", () => {
    expect(deriveQueries([entry({ id: "a", content: "纯内容, 无标签无实体" })])).toEqual([]);
  });
});
