// tests/s2/prestep-dedupe.test.ts — pre-step 注入的去重与来源过滤回归。
// 坑: 只看 decision.messages 去重 → 注入消息进入会话日志后, 下一个 step 会重复注入。
// 必须扫 agent.session.events 里本插件的历史注入。
import { describe, expect, it } from "vitest";
import {
  latestUserText,
  makePreStepHandler,
  priorInjections,
  type PreStepPayload,
} from "../../src/adapters/dsh/prestep.ts";
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
    project: "api",
    bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
  },
];
const binder = new Binder(mem([rule]), () => configs);

function userMsg(text: string, source?: { kind: string; plugin?: string; form?: string }) {
  return { role: "user", content: [{ type: "text", text }], ...(source ? { source } : {}) };
}

function payload(events: unknown[] = []): PreStepPayload {
  return {
    agent: { session: { id: "s1", header: { cwd: "/code/api" }, events } },
    messages: [userMsg("帮我部署一个容器, 注意并发")],
    step: 1,
  };
}

const handler = makePreStepHandler(binder, {
  rootAgentsOnly: () => false,
  enabled: () => true,
  projectOf: (p) => (p.agent.session.header?.cwd ?? "").split("/").pop() ?? p.agent.session.id,
});

function texts(decision: unknown): string[] {
  const d = decision as { kind: string; messages: unknown[] };
  return d.messages.map((m) => JSON.stringify(m));
}

describe("latestUserText 来源过滤", () => {
  it("只认直接用户输入, 跳过插件注入的上下文", () => {
    const msgs = [
      userMsg("AGENTS.md 内容", { kind: "plugin", plugin: "agent-instructions" }),
      userMsg("真正的问题", { kind: "user" }),
    ];
    expect(latestUserText(msgs)).toBe("真正的问题");
  });

  it("全是插件上下文时返回空串 (不拿噪声当检索词)", () => {
    expect(
      latestUserText([userMsg("time-context", { kind: "plugin", plugin: "time-context" })]),
    ).toBe("");
  });
});

describe("跨 step 去重", () => {
  it("会话日志里已有同一注入块 → 不再重复注入", async () => {
    const first = await handler(payload(), async () => ({
      kind: "enter",
      messages: [userMsg("帮我部署一个容器, 注意并发")],
    }));
    const injected = (first as { messages: unknown[] }).messages.find((m) =>
      JSON.stringify(m).includes("HX-Memory"),
    )!;
    // 下一个 step: 上一步的注入已进入会话日志, claimed batch 里没有它
    const second = await handler(
      payload([{ type: "user/message", seq: 3, data: injected }]),
      async () => ({
        kind: "enter",
        messages: [userMsg("继续")],
      }),
    );
    expect(texts(second).some((t) => t.includes("HX-Memory"))).toBe(false);
  });

  it("无历史注入时正常注入 (对照)", async () => {
    const decision = await handler(payload(), async () => ({
      kind: "enter",
      messages: [userMsg("帮我部署一个容器, 注意并发")],
    }));
    expect(texts(decision).some((t) => t.includes("并发上限"))).toBe(true);
  });

  it("0.1.2 形状的 session (只有 eventAt + surface.nodes) 也能去重", async () => {
    const first = await handler(payload(), async () => ({
      kind: "enter",
      messages: [userMsg("帮我部署一个容器, 注意并发")],
    }));
    const injected = (first as { messages: unknown[] }).messages.find((m) =>
      JSON.stringify(m).includes("HX-Memory"),
    )!;
    // 目标版本没有 session.events: 只能 eventAt(seq) + surface.nodes
    const all = new Map([[3, { type: "user/message", seq: 3, data: injected }]]);
    const session = {
      id: "s1",
      header: { cwd: "/code/api" },
      surface: { nodes: [3] },
      eventAt: (seq: number) => all.get(seq),
    };
    const decision = await handler(
      { agent: { session }, messages: [userMsg("继续")], step: 2 },
      async () => ({ kind: "enter", messages: [userMsg("继续")] }),
    );
    expect(texts(decision).some((t) => t.includes("HX-Memory"))).toBe(false);
  });

  it("priorInjections 只认本插件的注入", () => {
    const events = [
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "time-context", form: "context" },
          content: [{ type: "text", text: "时间" }],
        },
      },
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
          content: [{ type: "text", text: "记忆块" }],
        },
      },
    ];
    expect([...priorInjections({ session: { events } })]).toEqual(["记忆块"]);
  });

  it("接受 Session 或 Agent (调用方手上常只有其中一个)", () => {
    const events = [
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
          content: [{ type: "text", text: "记忆块 <!--hx-memory:id=r1-->" }],
        },
      },
    ];
    const session = { id: "s1", events };
    expect([...priorInjections({ session })]).toEqual(["记忆块 <!--hx-memory:id=r1-->"]);
    expect([...priorInjections(session)]).toEqual(["记忆块 <!--hx-memory:id=r1-->"]);
  });
});

describe("首轮就得去重 (session-start 的块还没进会话日志)", () => {
  // 真实缺陷 (session-54bf3f3b): session-start 走 agent.inject() → 进 inbox, 它的
  // user/message 事件要等这一步的 claim 批次写进日志才出现, 而 pre-step 在**那之前**
  // 就跑了。于是首轮必然再发一份同样的常驻记忆 (seq 10 与 seq 12, 8 个 id 里 6 个重复)。
  const firstTurnPayload = (messages: unknown[]): PreStepPayload => ({
    agent: { session: { id: "s1", header: { cwd: "/code/api" }, events: [] } },
    messages,
    step: 1,
  });

  const startBlock =
    "【相关记忆 (always-on)】\n- [rA] 所有容器都要显式设计并发上限 <!--hx-memory:id=rA-->";

  it("claimed 批次里已有 session-start 的块 → 首轮不再重复注入同一条目", async () => {
    const decided = await handler(
      firstTurnPayload([
        userMsg("帮我部署一个容器, 注意并发"),
        userMsg(startBlock, { kind: "plugin", plugin: "hx-memory", form: "instructions" }),
      ]),
      async () => ({
        kind: "enter",
        messages: [
          userMsg(startBlock, { kind: "plugin", plugin: "hx-memory", form: "instructions" }),
          userMsg("帮我部署一个容器, 注意并发"),
        ],
      }),
    );
    expect(texts(decided).filter((t) => t.includes("并发上限"))).toHaveLength(1);
  });

  it("对照: 没有那个块时首轮照常注入 (不误伤保底通道)", async () => {
    const decided = await handler(firstTurnPayload([userMsg("帮我部署一个容器, 注意并发")]), async () => ({
      kind: "enter",
      messages: [userMsg("帮我部署一个容器, 注意并发")],
    }));
    expect(texts(decided).some((t) => t.includes("并发上限"))).toBe(true);
  });
});

describe("injectMode: first (只在首轮注入一次)", () => {
  const firstOnly = makePreStepHandler(binder, {
    rootAgentsOnly: () => false,
    enabled: () => true,
    injectMode: () => "first",
    projectOf: (p) => (p.agent.session.header?.cwd ?? "").split("/").pop() ?? p.agent.session.id,
  });

  it("会话里已有带 id 的记忆块 → 后续轮次不注入 (连检索都不做)", async () => {
    const events = [
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
          content: [{ type: "text", text: "- [rA] 规则 <!--hx-memory:id=rA-->" }],
        },
      },
    ];
    const decision = await firstOnly(
      {
        agent: { session: { id: "s1", header: { cwd: "/code/api" }, events } },
        messages: [userMsg("继续: 容器并发")],
        step: 3,
      },
      async () => ({ kind: "enter", messages: [userMsg("继续: 容器并发")] }),
    );
    expect(texts(decision).some((t) => t.includes("并发上限"))).toBe(false);
  });

  it("只有指引 (无 id 标记) 时首轮仍然注入 —— 判据是条目块, 不是'注入过任何东西'", async () => {
    const events = [
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
          content: [{ type: "text", text: "你有一套长期记忆 (HX-Memory), 可以调 memory_search。" }],
        },
      },
    ];
    const decision = await firstOnly(
      {
        agent: { session: { id: "s1", header: { cwd: "/code/api" }, events } },
        messages: [userMsg("帮我部署一个容器, 注意并发")],
        step: 1,
      },
      async () => ({ kind: "enter", messages: [userMsg("帮我部署一个容器, 注意并发")] }),
    );
    expect(texts(decision).some((t) => t.includes("并发上限"))).toBe(true);
  });

  it("首轮把 claimed 批次里的会话开始块算进去后也不再重复", async () => {
    const decision = await firstOnly(
      {
        agent: { session: { id: "s1", header: { cwd: "/code/api" }, events: [] } },
        messages: [
          userMsg("- [rA] 规则 <!--hx-memory:id=rA-->", {
            kind: "plugin",
            plugin: "hx-memory",
            form: "instructions",
          }),
          userMsg("帮我部署一个容器, 注意并发"),
        ],
        step: 1,
      },
      async () => ({
        kind: "enter",
        messages: [
          userMsg("- [rA] 规则 <!--hx-memory:id=rA-->", {
            kind: "plugin",
            plugin: "hx-memory",
            form: "instructions",
          }),
          userMsg("帮我部署一个容器, 注意并发"),
        ],
      }),
    );
    expect(texts(decision).filter((t) => t.includes("并发上限"))).toHaveLength(0);
  });
});
