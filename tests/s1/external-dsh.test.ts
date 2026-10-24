import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachExternalHost } from "../../src/adapters/dsh/external-bridge.ts";
import { messageTextOf } from "../../src/adapters/dsh/injection-dedupe.ts";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import { workspaceBankId } from "../../src/external/canonical.ts";
import { openEngines } from "../../src/external/open.ts";
import type { Binder } from "../../src/kernel/binder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("DSH 调用外置宿主", () => {
  it("没配地址时仍是宿主调用, 引擎落到词面投影", () => {
    const opened = openEngines({});
    expect(opened.wantedMemory).toBe("hindsight");
    expect(opened.wantedKnowledge).toBe("ragflow");
    expect(opened.memoryId).toBe("lexical");
    expect(opened.knowledgeId).toBe("lexical");
    expect(opened.memoryFallback).toMatch(/hindsight/);
    const remote = openEngines({
      HX_HINDSIGHT_BASE_URL: "http://127.0.0.1:9",
      HX_RAGFLOW_BASE_URL: "http://127.0.0.1:9",
      HX_RAGFLOW_API_KEY: "k",
    });
    expect(remote.memory.id).toBe("hindsight");
    expect(remote.knowledge.id).toBe("ragflow");
    expect(remote.memoryFallback).toBeUndefined();
  });

  it("辱骂当轮注入对齐, 原话不进 canonical", async () => {
    const mounted = mount("alpha");
    const result = await step(mounted.preface, "s1", "你这个傻逼还在改错文件");
    const text = messageTextOf(result.messages.at(-1));
    expect(text).toMatch(/对齐/);
    expect(text).not.toMatch(/傻逼/);
    const host = await mounted.host();
    const rows = host.store.listMemories(workspaceBankId("alpha"));
    expect(rows.some((row) => row.text.includes("傻逼"))).toBe(false);
  });

  it("轮末把结论写进当前工作区, 别的工作区读不到", async () => {
    const mounted = mount("alpha");
    const session = { id: "s1" };
    await mounted.onSessionEvent(session, { type: "turn/start" });
    await mounted.onSessionEvent(session, user("把缓存改成 60 秒"));
    await mounted.onSessionEvent(session, {
      type: "assistant/message",
      data: { content: [{ type: "text", text: "已把 TTL 改成 60 秒, 避免旧值复活" }] },
    });
    await mounted.onSessionEvent(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
    const host = await mounted.host();
    const mine = host.store.listMemories(workspaceBankId("alpha"));
    expect(mine.some((row) => row.text.includes("60"))).toBe(true);
    expect(host.store.listMemories(workspaceBankId("beta"))).toEqual([]);
  });

  it("开场卡片只在该会话第一次预步出现", async () => {
    const mounted = mount("alpha");
    const host = await mounted.host();
    await host.retain({ bankId: workspaceBankId("alpha"), kind: "decision", text: "队列上限必须显式写出来" });
    const first = await step(mounted.preface, "s1", "今天写点别的");
    const second = await step(mounted.preface, "s1", "hello");
    expect(messageTextOf(first.messages.at(-1))).toMatch(/队列上限/);
    expect(messageTextOf(second.messages.at(-1) ?? {})).not.toMatch(/队列上限/);
  });
});

function mount(project: string) {
  const root = mkdtempSync(join(tmpdir(), "hx-dsh-ext-"));
  roots.push(root);
  const tools: string[] = [];
  return attachExternalHost({
    root,
    projectKey: () => project,
    ctx: {
      tools: {
        register(tool) {
          tools.push(tool.name);
          return () => undefined;
        },
      },
    },
  });
}

function user(text: string) {
  return { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text }] } };
}

async function step(
  preface: (input: { sessionId: string; project: string; text: string }) => Promise<string>,
  sessionId: string,
  text: string,
) {
  const handler = makePreStepHandler(stubBinder(), {
    rootAgentsOnly: () => false,
    enabled: () => true,
    externalPreface: preface,
  });
  const messages = [{ role: "user", source: { kind: "user" }, content: text }];
  const decision = await handler(
    { agent: { session: { id: sessionId } }, messages, step: 1 },
    async () => ({ kind: "enter", messages: [...messages] }),
  );
  if (decision.kind !== "enter") throw new Error("pre-step rejected");
  return decision;
}

function stubBinder(): Binder {
  return {
    warm: async () => undefined,
    injectFor: () => "",
    lastTriggerDecision: () => ({ mode: "skip-no-signal", intent: null, confidence: 0, topicDrift: 0, reason: "" }),
    lastInjectionChannel: () => "none" as const,
    lastSelectedIds: () => [],
    lastInjectedIds: () => [],
    lastInjectedTokens: () => 0,
  } as unknown as Binder;
}
