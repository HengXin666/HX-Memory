// tests/s2/always-on-blocked-content.test.ts — "被挡"条目必须**带上正文**。
//
// 为什么需要它 (2026-09-18, §565): 面板的注入预览渲染 `{b.content}` (review-page.tsx),
// 而 `projectAlwaysOnPreview` **硬编码 `content: ""`** ⇒ 用户只看到徽标与条数,
// **看不出被挡的是什么** —— 而"哪些被挡了"正是那个出口存在的理由
// (规则是用户确认过的不变量, 保底通道承诺无条件注入; 挡了什么必须可查)。
//
// ⚠ 类型上 `content` 是 `string`, 所以 `content: ""` **不报错** —— 这类缺陷只能靠测试锁。
// 本文件同时钉住"整条链的每一环都带 content"(§565 是一次**跨 4 个类型声明**的修复)。
import { describe, expect, it } from "vitest";
import { selectAlwaysOnDetailed } from "../../src/trigger/policy.ts";
import { projectAlwaysOnPreview } from "../../src/adapters/dsh/gateway-injection.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const rule = (id: string, content: string, at = "2026-01-01T00:00:00.000Z"): MemoryEntry =>
  ({
    id,
    kind: "rule",
    content,
    source: "test",
    scope: "global",
    confirmedBy: "human",
    confirmedAt: at,
    ts: { validAt: at, assertedAt: at },
  }) as MemoryEntry;

describe("always-on 预览: 被挡条目要带正文", () => {
  it("**选不下时, blocked 里带的是真正文** (而不是空串)", () => {
    // 预算极小 ⇒ 至少一条被挡
    const entries = [rule("r1", "第一条必须遵守的硬约束: 索引与查询共用同一分词函数"), rule("r2", "第二条必须遵守的硬约束: 提交前先查该仓库的提交历史")];
    const sel = selectAlwaysOnDetailed(entries, { budgetTokens: 40, estimate: (t) => t.length });
    expect(sel.blocked.length).toBeGreaterThan(0);
    for (const b of sel.blocked) {
      expect(typeof b.content).toBe("string");
      expect(b.content.length, "被挡条目必须带正文 (空串 = 面板看不出被挡的是什么)").toBeGreaterThan(0);
    }
  });

  it("**投影到面板视图后 content 仍在** (整条链不能丢)", async () => {
    const entries = [rule("r1", "第一条必须遵守的硬约束: 索引与查询共用同一分词函数"), rule("r2", "第二条必须遵守的硬约束: 提交前先查该仓库的提交历史")];
    const sel = selectAlwaysOnDetailed(entries, { budgetTokens: 40, estimate: (t) => t.length });
    const view = await projectAlwaysOnPreview(
      async () => ({
        entries: sel.entries.map((e) => ({ id: e.id, kind: e.kind, scope: e.scope, content: e.content })),
        blocked: sel.blocked.map((b) => ({ id: b.id, kind: b.kind, content: b.content, tokens: b.tokens, reason: b.reason })),
        budgetTokens: 40,
      }),
      { estimate: (t) => t.length },
    );
    expect(view.blocked.length).toBeGreaterThan(0);
    for (const b of view.blocked) {
      expect(b.content.length, "投影层不能把 content 抹成空串").toBeGreaterThan(0);
    }
  });

  it("被挡条目的 content 会被截断到 400 (与 picked 一致 —— 这是预览出口不是全文出口)", async () => {
    const long = "很长的约束".repeat(200);   // > 400
    const entries = [rule("r1", long), rule("r2", "短约束")];
    const sel = selectAlwaysOnDetailed(entries, { budgetTokens: 30, estimate: (t) => t.length });
    const view = await projectAlwaysOnPreview(
      async () => ({
        entries: sel.entries.map((e) => ({ id: e.id, kind: e.kind, scope: e.scope, content: e.content })),
        blocked: sel.blocked.map((b) => ({ id: b.id, kind: b.kind, content: b.content, tokens: b.tokens, reason: b.reason })),
        budgetTokens: 30,
      }),
      { estimate: (t) => t.length },
    );
    for (const b of view.blocked) expect(b.content.length).toBeLessThanOrEqual(400);
  });
});
