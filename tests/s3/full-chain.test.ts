// tests/s3/full-chain.test.ts — 全链路端到端: 真实对话 → 捕获 → 注入 → 溯源 → 跨会话。
//
// 为什么需要它 (2026-09-18): 这条链上每一环都**单独**测过 (捕获有 s2、注入有 s3、
// 溯源有 s2), 但**没有一次走通过完整路径**。本次实测证明了这个必要性 ——
// 我最初用自造的 triggerSource 替身, 因签名与真实实现不一致, 得到"注入为空"的假象,
// 花了几轮才定位到真正原因 (替身错, 不是产品错)。
//
// 因此本测试的原则是: **用真实装配件** (createTriggerCache + Binder + makePreStepHandler),
// 而不是自制替身 —— 替身不一致会制造假缺陷, 也会掩盖真缺陷。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import { Binder } from "../../src/kernel/binder.ts";
import { createTriggerCache } from "../../src/adapters/dsh/trigger-cache.ts";

/** 按真实装配 (index.ts 的形状) 造 binder + triggerCache —— 不用替身。 */
function assemble(stack: ReturnType<typeof openMemoryStack>) {
  const triggerCache = createTriggerCache({
    facade: stack.facade,
    revision: () => stack.store.revision?.() ?? 0,
  });
  const binder = new Binder(
    (q) => stack.store.query(q),
    () => [],
    stack.retriever,
    {
      alwaysOn: (scope) => triggerCache.ids(scope),
      recallFor: (text, decision, scope) => triggerCache.recallFor(text, decision, scope),
      now: () => new Date().toISOString(),
    },
  );
  return { binder, triggerCache };
}

/** 真实的 pre-step payload 形状 (role 必填 —— 缺它 latestUserText 会返回空)。 */
function payload(cwd: string) {
  return {
    agent: { session: { id: "session-full", header: { origin: "root", cwd } } },
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "生产库能直连吗?" }] },
    ],
    step: 1,
  } as never;
}

async function seed(stack: ReturnType<typeof openMemoryStack>, root: string) {
  const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
  await flushTurn(
    { episodes: () => stack.episodes, log: () => null, pipe, surface: "dsh" },
    {
      session: "session-full",
      turn: 1,
      project: "p",
      question: "记住: 生产库禁止直连, 必须走只读副本",
      answer: "已记录该硬约束。",
    } as never,
  );
}

describe("全链路: 捕获 → 注入 → 溯源", () => {
  it("**四段全通**: 对话被捕获、下轮被注入、可追原话、跨会话仍在", async () => {
    const root = mkdtempSync(join(tmpdir(), "full-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      // 阶段 1: 捕获
      await seed(stack, root);
      const entries = stack.store.all();
      expect(entries.length).toBeGreaterThan(0);

      // 阶段 2: 注入 (真实装配)
      const { binder, triggerCache } = assemble(stack);
      const handler = makePreStepHandler(binder, {
        rootAgentsOnly: () => true,
        enabled: () => true,
        scopeOf: () => "p",
      });
      await triggerCache.refresh("p");
      const d = await handler(payload(root), async () => ({ kind: "enter", messages: [] }) as never);
      const msgs = (d as { messages?: unknown[] }).messages ?? [];
      expect(msgs.length).toBeGreaterThan(0); // ← 此前"注入为空"正是这里失败

      // 阶段 3: 溯源
      const chain = await stack.facade.evidenceChain(entries[0]!.id);
      expect(chain!.traceable).toBe(true);
      expect(chain!.episodes.some((e) => e.text.includes("生产库禁止直连"))).toBe(true);

      // 阶段 4: 跨会话 (重开栈 = 真相在文件的验证)
      stack.close();
      const s2 = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
      try {
        expect(s2.store.all().length).toBeGreaterThan(0);
        const a2 = assemble(s2);
        await a2.triggerCache.refresh("p");
        const h2 = makePreStepHandler(a2.binder, {
          rootAgentsOnly: () => true,
          enabled: () => true,
          scopeOf: () => "p",
        });
        const d2 = await h2(payload(root), async () => ({ kind: "enter", messages: [] }) as never);
        expect(((d2 as { messages?: unknown[] }).messages ?? []).length).toBeGreaterThan(0);
      } finally {
        s2.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无内容时不注入 (空库不该产生空块)", async () => {
    const root = mkdtempSync(join(tmpdir(), "full-empty-"));
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const { binder, triggerCache } = assemble(stack);
      await triggerCache.refresh("p");
      const handler = makePreStepHandler(binder, {
        rootAgentsOnly: () => true,
        enabled: () => true,
        scopeOf: () => "p",
      });
      const d = await handler(payload(root), async () => ({ kind: "enter", messages: [] }) as never);
      expect(((d as { messages?: unknown[] }).messages ?? []).length).toBe(0);
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
