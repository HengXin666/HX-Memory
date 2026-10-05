// tests/s2/injection-dedupe.test.ts — 同一会话内的注入去重与差量注入 (s2)。
//
// 回归的真实缺陷 (2026-09, 用户实测): 一次会话里同一批记忆出现两三遍 ——
//   ①会话开始时注入的块 (无标题/无框架句) 与预步的块 (有标题+框架句) 永不相等 → 首次预步必然重复;
//   ②预步每步重新拼块, 只要条目集合变一条, 整块文本就变 → 已注入过的条目被整份重发;
//   ③14 轮的一条真实会话注入 7 次 (约 256 token/次, 逐轮在历史里累积)。
//
// 修法: 注入行带**稳定 id 标记** (kernel/injection-format.ts), 调用方把"已注入过的条目 id"
// 交给 Binder 排除 —— 常驻记忆只进一次, 之后只补真正的新条目。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { Binder, splitTriggerGroups, type TriggerSource } from "../../src/kernel/binder.ts";
import { formatEntryLine, parseInjectedIds, entryIdsOfSource } from "../../src/kernel/injection-format.ts";
import { createPendingGuidance, makeSessionStartHandler } from "../../src/adapters/dsh/session-start.ts";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

let root: string;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-inj-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一个"库里有常驻规则 + 一条项目 lesson"的无绑定 binder (与 DSH 适配器同构)。 */
async function makeBinder() {
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
  const triggerSource: TriggerSource = {
    alwaysOn: () => alwaysOn.map((e) => e.id),
    recallFor: (text, decision) => {
      const merged = new Map(alwaysOn.map((e) => [e.id, e] as const));
      const cost = alwaysOn.reduce((n, e) => n + e.content.length + 8, 0);
      const budget = Math.max(0, decision.budgetTokens - cost);
      if (budget > 0) {
        for (const hit of stack.facade.recall({ text, limit: 6, tokenBudget: budget }).hits) {
          merged.set(hit.entry.id, hit.entry);
        }
      }
      return [...merged.values()];
    },
    now: () => "2026-06-01T00:00:00.000Z",
  };
  const binder = new Binder((q) => stack.store.query(q), () => [], stack.retriever, triggerSource);
  return { stack, binder };
}

describe("注入行的 id 承载方式 (2026-09-29 改: 正文不再带 id)", () => {
  it("注入行只有 kind + 内容, 正文里没有任何机器标记", () => {
    const line = formatEntryLine("r123", "规则内容");
    // 行首没有 [id] (句柄对模型无用), 行尾也没有 `<!--hx-memory:id=…-->` ——
    // 后者曾占 88 token/块 (9 条), 已移到消息 source.entryIds (见 injection-format 头注)。
    expect(line).toBe("- 规则内容");
    expect(line.startsWith("- [r123]")).toBe(false);
    expect(parseInjectedIds(line)).toEqual([]);
  });

  it("id 改走 source.entryIds —— 顺序与去重语义与旧标记一致", () => {
    // 旧形态靠正文标记解析; 新形态直接读 source。这里钉住"读得到、且去重"。
    expect(entryIdsOfSource({ entryIds: ["a", "b", "a"] })).toEqual(["a", "b", "a"]);
    // 去重是调用方 (Set) 的职责; 本函数只管原样取出。
    expect([...new Set(entryIdsOfSource({ entryIds: ["a", "b", "a"] }))]).toEqual(["a", "b"]);
  });

  it("历史形态仍可解析 (旧会话日志里的行尾标记不能被放弃)", () => {
    const legacy = "- 规则内容 <!--hx-memory:id=r123-->";
    expect(parseInjectedIds(legacy)).toEqual(["r123"]);
  });

  it("无标记的文本 → 空 (非注入内容不会被当成已注入)", () => {
    expect(parseInjectedIds("- [a] 普通 markdown 列表")).toEqual([]);
  });
});

describe("splitTriggerGroups: 常驻组与新召回组", () => {
  it("按 id 是否属于 always-on 切分", () => {
    const a = { id: "a", content: "" } as never;
    const b = { id: "b", content: "" } as never;
    const groups = splitTriggerGroups([a, b], ["a"]);
    expect(groups.alwaysOn.map((e) => e.id)).toEqual(["a"]);
    expect(groups.fresh.map((e) => e.id)).toEqual(["b"]);
  });
});

describe("差量注入 (同会话不再重发同一批常驻记忆)", () => {
  it("已注入过的条目在后续轮次不再出现, 新条目仍会补进来", async () => {
    const { stack, binder } = await makeBinder();
    // 第 1 轮: 没有基线 → 常驻规则进来
    const first = binder.injectFor("api", "容器并发上限怎么设");
    expect(first).toContain("并发策略");
    expect(binder.lastInjectedIds()).toContain("rule-1");

    // 第 2 轮: 把第 1 轮注入过的 id 作为基线 (与 pre-step 从会话日志解析等价)
    const second = binder.injectFor("api", "换话题: 前端按钮圆角改成 8px", ["rule-1"]);
    expect(second).not.toContain("并发策略");

    // 第 3 轮: 命中 lesson 的本地召回 (此前没注入过) → 仍然补进来
    const third = binder.injectFor("api", "上次我们并发问题是怎么解决的？", ["rule-1"]);
    expect(third).toContain("连接池上限");
    expect(third).not.toContain("并发策略");
    stack.close();
  });

  it("整轮内容都已注入过 → 返回空串 (不产生任何新块)", async () => {
    const { stack, binder } = await makeBinder();
    const first = binder.injectFor("api", "容器并发上限怎么设");
    // ⚠ 基线必须取 `lastInjectedIds()` 而不是解析正文 —— 2026-09-29 起正文里**没有** id,
    // 解析它会得到空数组 (那条路径现在只在读历史会话时有用)。这正是真实调用方的用法:
    // prestep 用 `binder.lastInjectedIds()` 写进消息 source, 后续轮次从 source 读回。
    const ids = [...binder.lastInjectedIds()];
    expect(ids.length, "先确认基线非空, 否则下面的断言是空转").toBeGreaterThan(0);
    expect(parseInjectedIds(first), "正文已不含 id 标记").toEqual([]);
    const again = binder.injectFor("api", "容器并发上限设多少合适", ids);
    expect(again).toBe("");
    stack.close();
  });
});

describe("单一注入点 (一次会话只注入一个块)", () => {
  // 用户实测原话: "别注入2次, 就只能注入一次"。此前 session-start 发指引、pre-step 发条目,
  // 一次会话里模型读到两块 HX-Memory 内容 (session-b000974f: seq 10 + seq 13)。
  // 修法: 会话开始**不再注入** (只登记待发指引), 指引与条目组装进**同一个块** 由 pre-step 发出。
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
  const startBlock = "【相关记忆 (always-on)】";

  function entryMsg(text: string) {
    return { role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
  }

  function sessionWith(events: unknown[] = []) {
    return { id: "s1", header: { cwd: "/code/api" }, events };
  }

  it("会话开始只登记: agent.inject 一次都不调, 且首轮只产生一个块", async () => {
    const { stack } = await makeBinder();
    const pending = createPendingGuidance();
    const startInjected: string[] = [];
    makeSessionStartHandler({
      settings: () => ({ rootAgentsOnly: true, injectGuidance: true, language: "zh" }),
      pending,
    })({
      agent: { session: sessionWith(), inject: (m: unknown) => startInjected.push(JSON.stringify(m)) },
    });
    expect(startInjected).toHaveLength(0); // 会话开始不再是注入点

    const binder = new Binder((q) => stack.store.query(q), () => []);
    const handler = makePreStepHandler(binder, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      projectOf: () => "api",
      pendingGuidance: pending,
    });
    const decision = (await handler(
      { agent: { session: sessionWith() }, messages: [entryMsg("容器并发上限怎么设")], step: 1 },
      async () => ({ kind: "enter", messages: [entryMsg("容器并发上限怎么设")] }),
    )) as { messages: unknown[] };
    const blocks = decision.messages
      .map((m) => JSON.stringify(m))
      .filter((t) => t.includes("hx-memory"));
    // 一个块, 且指引与条目都在里面 (此前是两块: 指引一块、条目一块)
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("memory_search");
    stack.close();
  });

  it("指引只发一次: 第二轮及之后不再带指引 (但新条目仍补)", async () => {
    const { stack } = await makeBinder();
    const pending = createPendingGuidance();
    makeSessionStartHandler({
      settings: () => ({ rootAgentsOnly: true, injectGuidance: true, language: "zh" }),
      pending,
    })({ agent: { session: sessionWith(), inject: () => {} } });

    const binder = new Binder((q) => stack.store.query(q), () => []);
    const handler = makePreStepHandler(binder, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      projectOf: () => "api",
      pendingGuidance: pending,
    });
    const first = (await handler(
      { agent: { session: sessionWith() }, messages: [entryMsg("容器并发上限怎么设")], step: 1 },
      async () => ({ kind: "enter", messages: [entryMsg("容器并发上限怎么设")] }),
    )) as { messages: unknown[] };
    const firstBlock = JSON.stringify(first.messages.at(-1));
    expect(firstBlock).toContain("memory_search");

    // 第二轮: 上一轮的块已在会话日志里 (含 id 标记) → 它既是判重基线, 也是"指引已给过"的证据
    const events = [
      {
        type: "user/message",
        data: {
          source: { kind: "plugin", plugin: "hx-memory", form: "instructions" },
          content: [{ type: "text", text: firstBlock.includes("hx-memory") ? JSON.parse(firstBlock).content[0].text : "" }],
        },
      },
    ];
    const second = (await handler(
      { agent: { session: sessionWith(events) }, messages: [entryMsg("继续")], step: 2 },
      async () => ({ kind: "enter", messages: [entryMsg("继续")] }),
    )) as { messages: unknown[] };
    const added = second.messages.map((m) => JSON.stringify(m)).filter((t) => t.includes("hx-memory"));
    for (const b of added) expect(b).not.toContain("memory_search");
    stack.close();
  });

  it("库里没有条目时仍发一个块 (指引不得被'这块没内容'吃掉)", async () => {
    const { stack } = await makeBinder();
    const pending = createPendingGuidance();
    makeSessionStartHandler({
      settings: () => ({ rootAgentsOnly: true, injectGuidance: true, language: "zh" }),
      pending,
    })({ agent: { session: sessionWith(), inject: () => {} } });
    // 空库 + 无绑定 → 没有任何条目
    const empty = new Binder(() => [], () => []);
    const handler = makePreStepHandler(empty, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      projectOf: () => "nothing-here",
      pendingGuidance: pending,
    });
    const decision = (await handler(
      { agent: { session: sessionWith() }, messages: [entryMsg("随便问一句")], step: 1 },
      async () => ({ kind: "enter", messages: [entryMsg("随便问一句")] }),
    )) as { messages: unknown[] };
    const blocks = decision.messages.map((m) => JSON.stringify(m)).filter((t) => t.includes("hx-memory"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("memory_search");
    stack.close();
  });
});
