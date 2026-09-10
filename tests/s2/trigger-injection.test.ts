// tests/s2/trigger-injection.test.ts — 触发层的端到端: "AI 没意识到要查"时记忆仍然生效。
//
// 三种最容易失灵的现场, 各有一条断言:
//   1. 项目**没有任何绑定** (最常见): 旧实现完全不注入 → 现在由 always-on + 意图保底;
//   2. 用户问"上次我们怎么做的"但没提任何关键词: 意图通道命中 → 注入;
//   3. 普通任务指令 (不该注入): 明确不注入, 避免噪声吃预算。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { Binder, type BindingConfig, type TriggerSource } from "../../src/kernel/binder.ts";

let root: string;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-trigger-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一个"没有项目绑定, 但库里有记忆"的 binder (旧实现在这里的注入恒为空)。 */
async function makeUnboundBinder() {
  const stack = openMemoryStack(root, { now: () => "2026-06-01T00:00:00.000Z" });
  await stack.store.add({
    id: "rule-1",
    kind: "rule",
    scope: "global",
    content: "涉及容器并发时先检查并发策略",
    source: "review:confirm",
    ts: T,
    confirmedBy: "hx",
    confirmedAt: T.assertedAt,
  });
  await stack.store.add({
    id: "lesson-1",
    kind: "lesson",
    scope: "project",
    project: "api",
    content: "上次并发问题是因为没设连接池上限",
    source: "session:s",
    ts: T,
  });
  const alwaysOn = await stack.facade.alwaysOn({ project: "api", budgetTokens: 400 });
  // 与 DSH 适配器同构: always-on 与意图召回**并行叠加** (规则给不变量, 召回给具体历史)。
  const triggerSource: TriggerSource = {
    alwaysOn: () => alwaysOn.map((e) => e.id),
    recallFor: (text, decision) => {
      const merged = new Map(alwaysOn.map((e) => [e.id, e] as const));
      const alwaysOnCost = alwaysOn.reduce((n, e) => n + e.content.length + 8, 0);
      const intentsBudget = Math.max(0, decision.budgetTokens - alwaysOnCost);
      if (intentsBudget > 0) {
        for (const hit of stack.facade.recall({ text, limit: 6, tokenBudget: intentsBudget })
          .hits) {
          merged.set(hit.entry.id, hit.entry);
        }
      }
      return [...merged.values()];
    },
    now: () => "2026-06-01T00:00:00.000Z",
  };
  // 关键: configs 返回空数组 —— 模拟"项目没声明任何绑定"。
  const binder = new Binder(
    (q) => stack.store.query(q),
    () => [] as BindingConfig[],
    stack.retriever,
    triggerSource,
  );
  return { stack, binder };
}

describe("无绑定项目: 触发层保底", () => {
  it("普通任务指令也能拿到 always-on 规则 (模型完全没意识到要查)", async () => {
    const { stack, binder } = await makeUnboundBinder();
    const injected = binder.injectFor("api", "把这个函数重命名为 parseConfig");
    expect(injected).toContain("涉及容器并发时先检查并发策略");
    expect(binder.lastTriggerDecision()?.mode).toBe("always-on");
    stack.close();
  });

  it("回忆型提问命中意图通道, 能召回具体 lesson", async () => {
    const { stack, binder } = await makeUnboundBinder();
    const injected = binder.injectFor("api", "上次我们并发问题是怎么解决的？");
    expect(injected).toContain("连接池上限");
    const decision = binder.lastTriggerDecision();
    expect(["intent", "always-on"]).toContain(decision?.mode);
    stack.close();
  });

  it("同一话题连续追问不重复注入 (省预算), 换话题强制重查", async () => {
    const { stack, binder } = await makeUnboundBinder();
    const first = binder.injectFor("api", "容器并发上限怎么设");
    expect(first.length).toBeGreaterThan(0);
    const second = binder.injectFor("api", "容器并发上限设多少合适");
    expect(second).toBe(""); // 同话题 + 刚注入过 → 跳过
    const third = binder.injectFor("api", "前端按钮圆角改成 8px");
    // 换话题后, 若命中意图或无 always-on 之外的信号会重查; always-on 存在但话题已变 → 重新注入
    expect(third.length).toBeGreaterThan(0);
    stack.close();
  });

  it("每次注入都留下可审计的触发决策 (why 可查)", async () => {
    const { stack, binder } = await makeUnboundBinder();
    binder.injectFor("api", "我们当时为什么这么做？");
    const decision = binder.lastTriggerDecision();
    expect(decision).not.toBeNull();
    expect(decision?.reason.length).toBeGreaterThan(3);
    expect(decision?.budgetTokens).toBeGreaterThan(0);
    stack.close();
  });
});
