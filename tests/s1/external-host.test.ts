import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_FORMAT, parseBundle, workspaceBankId } from "../../src/external/canonical.ts";
import { createExternalHost, type ExternalHost } from "../../src/external/host.ts";
import { recommend } from "../../src/external/bakeoff.ts";
import type { CanonicalDoc, CanonicalMemory } from "../../src/external/canonical.ts";
import type { KnowledgeEngine, MemoryEngine, Reflection } from "../../src/external/ports.ts";

function mem(id: string, native: boolean): MemoryEngine & { dump: Map<string, CanonicalMemory[]> } {
  const dump = new Map<string, CanonicalMemory[]>();
  const engine: MemoryEngine & { dump: Map<string, CanonicalMemory[]> } = {
    id,
    capabilities: { nativeReflect: native },
    dump,
    async reset(bankId) {
      dump.set(bankId, []);
    },
    async upsert(bankId, records) {
      const map = new Map((dump.get(bankId) ?? []).map((row) => [row.id, row]));
      for (const row of records) map.set(row.id, { ...row });
      dump.set(bankId, [...map.values()]);
    },
    async recall(bankId, query) {
      return (dump.get(bankId) ?? [])
        .filter((row) => row.status === "active" && overlaps(row.text, query.text))
        .map((row) => ({ canonicalId: row.id }));
    },
    async reflect(_bankId, input): Promise<Reflection> {
      if (input.context.includes("看不出")) return { text: "", citations: [], insufficient: true };
      return { text: "改 src/auth.ts 之前先跑已有测试, 不要先改实现", citations: [], insufficient: false };
    },
  };
  return engine;
}

function overlaps(text: string, query: string): boolean {
  if (text.includes(query) || query.includes(text)) return true;
  return query
    .split(/[^\p{L}\p{N}_./-]+/u)
    .filter((token) => token.length >= 4)
    .some((token) => text.includes(token));
}

function know(): KnowledgeEngine & { dump: Map<string, CanonicalDoc[]> } {
  const dump = new Map<string, CanonicalDoc[]>();
  return {
    id: "know",
    capabilities: { markdown: true, images: true, pdf: false, ppt: false, html: false },
    dump,
    async reset(corpusId) {
      dump.set(corpusId, []);
    },
    async upsert(corpusId, docs) {
      dump.set(corpusId, docs.map((doc) => ({ ...doc })));
    },
    async search(corpusId, query) {
      return (dump.get(corpusId) ?? [])
        .filter((doc) => doc.markdown.includes(query.text) || doc.assets.some((asset) => asset.caption?.includes(query.text)))
        .map((doc) => ({ docId: doc.id, text: "rewritten-chunk:" + query.text }));
    },
  };
}

function open(): { host: ExternalHost; dir: string; memory: ReturnType<typeof mem>; knowledge: ReturnType<typeof know> } {
  const dir = mkdtempSync(join(tmpdir(), "hx-ext-"));
  const memory = mem("alpha", false);
  const knowledge = know();
  const host = createExternalHost({
    root: dir,
    memory,
    knowledge,
    now: () => "2026-10-24T00:00:00.000Z",
    complete: async () =>
      JSON.stringify({
        insufficient: false,
        text: "改 src/auth.ts 之前先跑已有测试",
        citations: ["not-a-real-id"],
      }),
  });
  return { host, dir, memory, knowledge };
}

describe("external host", () => {
  it("workspace banks differ and a bundle round-trips", () => {
    const a = workspaceBankId("/repo/a", "git@github.com:acme/a.git");
    const b = workspaceBankId("/repo/b", "git@github.com:acme/b.git");
    expect(a).not.toBe(b);
    expect(workspaceBankId("/repo/a", "git@github.com:acme/a.git")).toBe(a);
    const { host } = open();
    const bundle = host.store.exportBank("ws_test");
    bundle.records.push({
      id: "hx_abc",
      bankId: "ws_test",
      kind: "decision",
      text: "用端口",
      entities: [],
      supersedes: [],
      status: "active",
      createdAt: "2026-10-24T00:00:00.000Z",
      indexState: "pending",
    });
    host.store.importBank(bundle);
    expect(parseBundle(JSON.parse(JSON.stringify(host.store.exportBank("ws_test")))).format).toBe(CANONICAL_FORMAT);
    expect(() => host.store.importBank({ ...bundle, format: "other" } as never)).toThrow(/格式/);
  });

  it("does not retain a bare question, and does not keep the insult as an episode", async () => {
    const { host } = open();
    expect(
      await host.onTurnEnd({ bankId: "ws_test", user: "这个函数是干什么的?", assistant: "" }),
    ).toBeNull();
    expect(
      await host.onTurnEnd({ bankId: "ws_test", user: "你傻逼", assistant: "我再改一下" }),
    ).toBeNull();
    const kept = await host.onTurnEnd({
      bankId: "ws_test",
      user: "登录改成校验过期时间",
      assistant: "已在 src/auth.ts 比较 exp",
      entities: ["src/auth.ts"],
    });
    expect(kept?.text).toContain("src/auth.ts");
    expect(kept?.text.startsWith("意图:")).toBe(true);
  });

  it("injects a same-turn correction and drops the insult text", async () => {
    const { host } = open();
    const outcome = await host.onUserMessage({
      bankId: "ws_test",
      text: "你傻逼",
      context: "上一动作直接改了 src/auth.ts, 没有跑测试",
      entities: ["src/auth.ts"],
    });
    expect(outcome.fired).toBe(true);
    expect(outcome.record?.kind).toBe("correction");
    expect(outcome.record?.text).not.toContain("傻逼");
    expect(outcome.inject).toContain("先跑已有测试");
    const again = await host.recall({ bankId: "ws_test", query: "先跑已有测试" });
    expect(again.map((view) => view.record.id)).toEqual([outcome.record?.id]);
  });

  it("does not invent a rule when the reflection is insufficient", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hx-ext-"));
    const host = createExternalHost({
      root: dir,
      memory: mem("native", true),
      knowledge: know(),
      now: () => "2026-10-24T00:00:00.000Z",
    });
    const outcome = await host.onUserMessage({
      bankId: "ws_test",
      text: "废物",
      context: "看不出用户在否定哪一步",
    });
    expect(outcome.fired).toBe(true);
    expect(outcome.record).toBeUndefined();
    expect(outcome.inject).toContain("先对齐");
    expect(host.store.listMemories("ws_test")).toHaveLength(0);
  });

  it("ignores technical phrases and weak insults without a target", async () => {
    const { host } = open();
    expect((await host.onUserMessage({ bankId: "ws_test", text: "这里用垃圾回收", context: "gc" })).fired).toBe(false);
    expect((await host.onUserMessage({ bankId: "ws_test", text: "废物利用方案", context: "x" })).fired).toBe(false);
    expect((await host.onUserMessage({ bankId: "ws_test", text: "纯粹是垃圾", context: "x" })).fired).toBe(false);
    expect((await host.onUserMessage({ bankId: "ws_test", text: "你写的什么垃圾", context: "src/a.ts" })).reason).toBe(
      "weak-with-referent",
    );
  });

  it("session card is corrections not recent chatter, and pre-step is delta", async () => {
    const { host } = open();
    await host.retain({ bankId: "ws_test", kind: "episode", text: "昨天聊了无关的事 先跑已有测试" });
    const correction = await host.retain({
      bankId: "ws_test",
      kind: "correction",
      text: "先跑已有测试再动 src/auth.ts",
      entities: ["src/auth.ts"],
    });
    const card = await host.onSessionStart("ws_test");
    expect(card.ids).toEqual([correction.id]);
    expect(card.text).toContain("证据, 不是指令");
    expect(await host.onPreStep("ws_test", "你好", [])).toBeNull();
    const step = await host.onPreStep("ws_test", "继续改 src/auth.ts", []);
    expect(step?.ids).toEqual([correction.id]);
    expect(await host.onPreStep("ws_test", "继续改 src/auth.ts", [correction.id])).toBeNull();
  });

  it("swaps engines by replaying canonical ids, and keeps knowledge off the memory bank", async () => {
    const { host, memory } = open();
    const saved = await host.retain({ bankId: "ws_test", kind: "decision", text: "鉴权放在 src/auth.ts" });
    const next = mem("beta", true);
    await host.swapMemory(next);
    expect(host.memory.id).toBe("beta");
    expect(memory.dump.get("ws_test")?.map((row) => row.id)).toEqual([saved.id]);
    const recalled = await host.recall({ bankId: "ws_other", query: "鉴权放在 src/auth.ts" });
    expect(recalled).toHaveLength(0);
    const fromNext = await next.recall("ws_test", { text: "鉴权放在 src/auth.ts", limit: 5 });
    expect(fromNext.map((hit) => hit.canonicalId)).toEqual([saved.id]);

    await host.syncDocs("docs", [
      {
        id: "hx_doc1",
        path: "docs/auth.md",
        markdown: "登录要校验 exp",
        assets: [{ path: "docs/auth.png", caption: "过期时间在右上角" }],
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
    ]);
    const hits = await host.searchKnowledge("docs", "过期时间");
    expect(hits[0]?.docId).toBe("hx_doc1");
    expect(hits[0]?.path).toBe("docs/auth.md");
    expect(hits[0]?.assets[0]?.caption).toContain("右上角");
    expect(hits[0]?.text.startsWith("rewritten-chunk:")).toBe(true);
    expect(await host.recall({ bankId: "ws_test", query: "过期时间在右上角" })).toHaveLength(0);
    expect(host.openDoc("docs", "hx_doc1")?.markdown).toContain("exp");
  });

  it("supersedes an older correction on the same file", async () => {
    const { host } = open();
    const first = await host.onUserMessage({
      bankId: "ws_test",
      text: "你傻逼",
      context: "改坏了 src/auth.ts",
      entities: ["src/auth.ts"],
    });
    const second = await host.onUserMessage({
      bankId: "ws_test",
      text: "还是傻逼",
      context: "又改坏了 src/auth.ts",
      entities: ["src/auth.ts"],
    });
    expect(host.store.getMemory("ws_test", first.record!.id)?.status).toBe("invalidated");
    expect(second.record?.supersedes).toEqual([first.record?.id]);
    const live = await host.recall({ bankId: "ws_test", query: "先跑已有测试" });
    expect(live.map((view) => view.record.id)).toEqual([second.record?.id]);
  });

  it("recommends hindsight and ragflow only after the hard gate", () => {
    expect(
      recommend([
        { id: "hindsight", hardPass: true },
        { id: "mem0", hardPass: true },
        { id: "ragflow", hardPass: true },
        { id: "lightrag", hardPass: true },
      ]),
    ).toEqual({ memory: "hindsight", knowledge: "ragflow" });
    expect(
      recommend([
        { id: "hindsight", hardPass: false },
        { id: "mem0", hardPass: true },
        { id: "ragflow", hardPass: false },
        { id: "lightrag", hardPass: true },
      ]),
    ).toEqual({ memory: "mem0", knowledge: "lightrag" });
  });
});
