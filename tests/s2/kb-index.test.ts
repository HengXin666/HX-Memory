// tests/s2/kb-index.test.ts — 本地知识库 (kind: "doc") 的接线契约。
//
// 为什么需要它 (2026-09-20, §795): 知识库条目与记忆条目**共用引擎但不共用语义** ——
// 它是"外部文档的镜像", 只可查、不进保底注入、不衰减。三条都必须是**断言**, 而不是注释:
//
// | 契约 | 若失去它 |
// | --- | --- |
// | `doc` 不进 `alwaysOn` | 267 条切片会**冒充**"跨项目关键事实"吃光 400 token 保底预算 |
// | `doc` 不衰减 (`HALF_LIFE = Infinity`) | 没人问过的文档会被衰减到不可见 (与"随时可查"矛盾) |
// | `source` 以 `kb:` 开头 | "记忆 vs 知识库"不可区分 ⇒ 面板/统计无法分流 |
//
// 切片与索引的**端到端**验证在 `tests/s2/kb-slice.test.ts` (走真的文件系统)。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { HALF_LIFE_DAYS } from "../../src/kernel/ranking.ts";
import { KINDS } from "../../src/storage/entry-normalize.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };

describe("知识库 kind=doc 的契约", () => {
  it("**doc 是合法 kind** (否则 kb-index 的写入会被入库边界拒绝)", () => {
    expect(KINDS).toContain("doc");
  });

  it("**doc 不衰减** (它是外部文档的镜像, 该不该在由源文件决定)", () => {
    expect(HALF_LIFE_DAYS.doc).toBe(Number.POSITIVE_INFINITY);
  });

  it("### 负例: **doc 不进 alwaysOn** —— 而同等条件下的 fact 会进", async () => {
    const root = mkdtempSync(join(tmpdir(), "kbdoc-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      // 两条内容相同、scope 相同, **只有 kind 不同** —— 那是唯一的变量。
      const body = "同一段正文, 用于隔离 kind 这一个变量";
      stack.store.add({ id: "d1", kind: "doc", scope: "global", source: "kb:x.md", content: body, ts: T } as never);
      stack.store.add({ id: "f1", kind: "fact", scope: "global", source: "session:tool", content: body, ts: T } as never);
      const ao = await stack.facade.alwaysOn({ budgetTokens: 700 });
      const ids = ao.map((e) => e.id);
      expect(ids, "fact 应进保底通道 (对照组)").toContain("f1");
      expect(ids, "doc 不该进保底通道 (被测项)").not.toContain("d1");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("### 负例: **doc 仍可被按需检索到** (不进常驻 ≠ 查不到)", () => {
    const root = mkdtempSync(join(tmpdir(), "kbdoc2-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      stack.store.add({
        id: "d1", kind: "doc", scope: "global", source: "kb:a.md",
        content: "RTK 是 Rust Token Killer, 用来压缩终端输出", ts: T,
      } as never);
      const r = stack.retriever.retrieveSync({ text: "RTK 是什么", limit: 5, purpose: "recall" } as never);
      expect(r.hits.map((h) => h.entry.id)).toContain("d1");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
