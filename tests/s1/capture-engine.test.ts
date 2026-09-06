// tests/s1/capture-engine.test.ts — S1: capture engine pure logic. No network, no harness.
import { describe, expect, it } from "vitest";
import { captureTurn } from "../../src/capture/engine.ts";

const base = { session: "s1" };

describe("captureTurn: explicit capture", () => {
  it('"记住 X" becomes a fact entry with content X', () => {
    const r = captureTurn({ ...base, text: "记住: 队列并发上限是 4" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("fact");
    expect(r.entries[0]!.content).toBe("队列并发上限是 4");
    expect(r.entries[0]!.source).toBe("session:s1");
  });

  it("explicit capture gets bitemporal timestamps", () => {
    const r = captureTurn({ ...base, text: "记一下: 生产库禁止直连" });
    expect(r.entries[0]!.ts.validAt).toBeTruthy();
    expect(r.entries[0]!.ts.assertedAt).toBeTruthy();
  });
});

describe("captureTurn: kind inference", () => {
  it("detects lesson signal (踩坑/concurrency)", () => {
    const r = captureTurn({ ...base, text: "后端队列并发踩坑了, 下次要注意幂等" });
    expect(r.entries[0]!.kind).toBe("lesson");
  });

  it("detects decision signal", () => {
    const r = captureTurn({ ...base, text: "决定采用 pnpm 作为包管理器" });
    expect(r.entries[0]!.kind).toBe("decision");
  });

  it("detects rule/pattern signal (所有容器)", () => {
    const r = captureTurn({ ...base, text: "规则: 所有容器都要显式设计并发上限" });
    expect(r.entries[0]!.kind).toBe("pattern");
  });

  it("detects preference signal", () => {
    const r = captureTurn({ ...base, text: "我更喜欢用英文标点写文档" });
    expect(r.entries[0]!.kind).toBe("preference");
  });

  it("plain chit-chat yields no capture (context filtered)", () => {
    const r = captureTurn({ ...base, text: "你好, 今天天气不错" });
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toContain("no-signal");
  });
});

describe("captureTurn: scoping + dedupe", () => {
  it("project present → scope:project; absent → scope:agent", () => {
    const withProj = captureTurn({ ...base, text: "记住: X", project: "hx-memory" });
    expect(withProj.entries[0]!.scope).toBe("project");
    const noProj = captureTurn({ ...base, text: "记住: Y" });
    expect(noProj.entries[0]!.scope).toBe("agent");
  });

  it("identical content dedupes via hash", () => {
    const first = captureTurn({ ...base, text: "记住: 幂等键用 UUID" });
    // entry id = "c" + contentHash; the dedupe set holds the raw hash
    const hash = first.entries[0]!.id.slice(1);
    const hashes = new Set([hash]);
    const second = captureTurn({ ...base, text: "记住: 幂等键用 UUID" }, {}, hashes);
    expect(second.entries).toHaveLength(0);
    expect(second.deduped).toBe(1);
  });

  it("off mode captures nothing", () => {
    const r = captureTurn({ ...base, text: "记住: 这个不重要" }, { mode: "off" });
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toBe("off");
  });

  it("forceKind overrides inference", () => {
    const r = captureTurn({ ...base, text: "生产库禁止直连" }, { forceKind: "fact" });
    expect(r.entries[0]!.kind).toBe("fact");
  });
});
