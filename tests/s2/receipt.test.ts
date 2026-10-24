// tests/s2/receipt.test.ts — 对话内回执的契约 (用户实测要求的"它真的在生效"的现场证据)。
//
// 为什么有它 (2026-10-05, 用户原话): "在跟 ai 对话的那个日志里面, 它能显示一条消息, 说沉淀了多少条,
// 或者说触发了沉淀, 而不是让我觉得这个插件根本就没生效。……你作为老板, 你去骂了下司, 下司做错了事
// 以后, 下司还没有任何的悔改, 你觉得你不会把他给炒鱿鱼吗?"
//
// 也就是: **沉默是致命的**。本文件钉住三件事:
//   ① 形态是宿主的 notice 约定 (form:"notice" + summary), 不是自造的普通消息;
//   ② 幂等 (同一 summary 在同会话只发一次);
//   ③ 文案是"它干了什么", 不是内部枚举名。
import { describe, expect, it } from "vitest";
import {
  RECEIPT_FORM,
  RECEIPT_SOURCE_KIND,
  injectReceipt,
  makeReceipt,
  scanPriorReceipts,
} from "../../src/adapters/dsh/receipt.ts";
import { receiptSummary, receiptText } from "../../src/adapters/dsh/capture-ledger.ts";
import type { CaptureResult } from "../../src/capture/engine.ts";

/** 造一个只收集 inject 的假 agent。 */
function fakeAgent() {
  const injected: unknown[] = [];
  const events: unknown[] = [];
  return {
    injected,
    inject(m: unknown) {
      injected.push(m);
      events.push({ type: "user/message", data: { source: (m as { source?: unknown }).source } });
    },
    // scanPriorReceipts 走 sessionEvents(agent.session)  用最小形状承载已注入的 source。
    session: {
      surface: { nodes: events.map((_, i) => i) },
      eventAt: (seq: number) => events[seq],
    },
  };
}

describe("回执形态: 复用宿主的 notice 约定", () => {
  it("source 是 form=notice + summary (宿主 UI 据此折叠展示)", () => {
    const m = makeReceipt({ summary: "HX-Memory: 已沉淀 1 条 (lesson)" }) as {
      source: { kind: string; form: string; summary: string };
    };
    expect(m.source.kind).toBe(RECEIPT_SOURCE_KIND);
    expect(m.source.form).toBe(RECEIPT_FORM);
    expect(m.source.summary).toContain("已沉淀 1 条");
  });

  it("summary 超长会被截断而不是抛错 (宿主有长度上限)", () => {
    const m = makeReceipt({ summary: "x".repeat(5000) }) as {
      source: { summary: string };
    };
    expect(m.source.summary.length).toBeLessThan(1000);
  });
});

describe("幂等: 同一回执在同会话只发一次", () => {
  it("重复 injectReceipt 第二次返回 false", () => {
    const a = fakeAgent();
    expect(injectReceipt(a, { summary: "HX-Memory: 已沉淀 1 条" })).toBe(true);
    expect(injectReceipt(a, { summary: "HX-Memory: 已沉淀 1 条" })).toBe(false);
    expect(a.injected.length).toBe(1);
  });

  it("不同 summary 各发一次", () => {
    const a = fakeAgent();
    injectReceipt(a, { summary: "A" });
    injectReceipt(a, { summary: "B" });
    expect(a.injected.length).toBe(2);
  });

  it("拿不到 inject 时静默返回 false (**不许抛**  回执是增强不是故障点)", () => {
    expect(injectReceipt(undefined, { summary: "x" })).toBe(false);
    expect(injectReceipt({}, { summary: "x" })).toBe(false);
    expect(injectReceipt({ inject: () => { throw new Error("host rejected"); } }, { summary: "x" })).toBe(false);
  });

  it("空 summary 不发", () => {
    const a = fakeAgent();
    expect(injectReceipt(a, { summary: "   " })).toBe(false);
  });
});

describe("文案: 说清'它干了什么', 而不是复述内部枚举名", () => {
  const ctx = { session: "session-abcdef123456", project: "P", turn: 3, question: "q", answer: "a" };

  it("沉淀成功 → 条数 + kind (不出现 no-signal 这类枚举)", () => {
    const res = { entries: [{ kind: "lesson", content: "禁止X。改为Y。" }], deduped: 0, signal: "lesson:x" } as unknown as CaptureResult;
    const s = receiptSummary(res, 1);
    expect(s).toContain("已沉淀 1 条");
    expect(s).toContain("lesson");
    expect(s).not.toContain("no-signal");
  });

  it("未沉淀 → 给出**人话原因**, 且不是枚举名", () => {
    const res = { entries: [], deduped: 0, signal: "no-signal:context" } as unknown as CaptureResult;
    const s = receiptSummary(res, 0);
    expect(s).toContain("未沉淀");
    expect(s).not.toContain("no-signal");
  });

  it("读不出结论 → 说明是结构化器的问题 (可归因)", () => {
    const res = { entries: [], deduped: 0, signal: "no-conclusion:question", noConclusion: 1 } as unknown as CaptureResult;
    expect(receiptSummary(res, 0)).toContain("结论");
  });

  it("正文正文含来源 (哪个会话/第几轮), 便于人对上账本", () => {
    const res = { entries: [{ kind: "fact", content: "hello" }], deduped: 0, signal: "fact:x" } as unknown as CaptureResult;
    const t = receiptText(ctx, res, 1);
    expect(t).toContain("turn 3");
    expect(t).toContain("session-abcdef123456");
  });

  it("沉淀多条时列出前 3 条 + 余数 (不展开成日志流)", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ kind: "fact", content: "第" + i }));
    const res = { entries, deduped: 0, signal: "fact:x" } as unknown as CaptureResult;
    const t = receiptText(ctx, res, 5);
    expect(t).toContain("另有 2 条");
  });
});

describe("scanPriorReceipts: 只认本插件的 notice (不误认注入块)", () => {
  it("注入块 (form=instructions) 不算回执", () => {
    const fake = {
      session: {
        surface: { nodes: [0] },
        eventAt: () => ({
          type: "user/message",
          data: { source: { kind: RECEIPT_SOURCE_KIND, form: "instructions" } },
        }),
      },
    };
    expect(scanPriorReceipts(fake).size).toBe(0);
  });
});
