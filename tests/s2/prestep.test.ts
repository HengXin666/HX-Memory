// tests/s2/prestep.test.ts — S2: agent/pre-step 确定性注入处理器 (纯逻辑)。
// 验证: 有绑定项目 + 最新用户文本命中 → 注入规则到 decision.messages;
//       内容去重; rootAgentsOnly 过滤; 无绑定零注入。
import { describe, expect, it } from "vitest";
import { latestUserText, makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import { Binder, type BindingConfig } from "../../src/kernel/binder.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

const rule: MemoryEntry = {
  id: "rA",
  kind: "rule",
  content: "所有容器都要显式设计并发上限",
  source: "t",
  scope: "global",
  ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
  confirmedBy: "u",
  confirmedAt: "t",
};

function mem(entries: MemoryEntry[]) {
  return (q: Query) =>
    entries.filter(
      (e) => (q.kind ? e.kind === q.kind : true) && (q.scope ? e.scope === q.scope : true),
    );
}

const configs: BindingConfig[] = [
  {
    project: "proj-web",
    bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
  },
];
const binder = new Binder(mem([rule]), () => configs);

function msg(role: string, text: string) {
  return { role, content: [{ type: "text", text }] };
}

describe("latestUserText", () => {
  it("取最新一条 user 消息文本", () => {
    const msgs = [msg("user", "你好"), msg("assistant", "在的"), msg("user", "容器并发怎么设?")];
    expect(latestUserText(msgs)).toBe("容器并发怎么设?");
  });
  it("无 user 消息 → 空串", () => {
    expect(latestUserText([msg("assistant", "嗨")])).toBe("");
  });
});

describe("makePreStepHandler", () => {
  const handler = makePreStepHandler(binder, {
    rootAgentsOnly: () => false,
    enabled: () => true,
  });

  it("有绑定 + 最新文本命中 → 注入规则进 decision.messages", async () => {
    const claimed = [msg("user", "帮我部署一个容器, 注意并发")];
    const decision = await handler(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 1 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    const d = decision as { kind: "enter"; messages: unknown[] };
    expect(d.kind).toBe("enter");
    const texts = d.messages.map((m) => JSON.stringify(m));
    expect(texts.some((t) => t.includes("并发上限"))).toBe(true);
  });

  it("已注入过的相同内容不重复注入 (内容去重)", async () => {
    const claimed = [msg("user", "部署容器")];
    const first = await handler(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 1 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    const d1 = first as { kind: "enter"; messages: unknown[] };
    // 第二次: decision.messages 已含注入块 → 不再追加
    const second = await handler(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 2 } as never,
      async () => ({ kind: "enter", messages: [...d1.messages] }),
    );
    const d2 = second as { kind: "enter"; messages: unknown[] };
    const injected = d2.messages.filter((m) => JSON.stringify(m).includes("HX-Memory"));
    expect(injected.length).toBe(1); // 只有一条注入块
  });

  it("rootAgentsOnly + subagent → 不注入", async () => {
    const subHandler = makePreStepHandler(binder, {
      rootAgentsOnly: () => true,
      enabled: () => true,
    });
    const claimed = [msg("user", "部署容器")];
    const decision = await subHandler(
      {
        agent: { session: { id: "proj-web", header: { origin: "subagent" } } },
        messages: claimed,
        step: 1,
      } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    const d = decision as { kind: "enter"; messages: unknown[] };
    expect(d.messages.length).toBe(1); // 没追加
  });

  it("reject decision → 原样返回 (不注入)", async () => {
    const claimed = [msg("user", "部署容器")];
    const decision = await handler(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 1 } as never,
      async () => ({ kind: "reject" }) as never,
    );
    expect((decision as { kind: string }).kind).toBe("reject");
  });
});
