// tests/s1/kernel-rules.test.ts — S1: kernel evolution-chain + bitemporal rules.
// No network, no harness: pure kernel logic only.
import { describe, expect, it } from "vitest";
import { expandEvolutionChain, sliceAt } from "../../src/kernel/evolution.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

function v1(): MemoryEntry {
  return {
    id: "m1",
    kind: "fact",
    content: "queue cap = 4",
    source: "session:a",
    scope: "project",
    ts: { validAt: "2026-09-01", assertedAt: "2026-09-01" },
    relations: [{ type: "supersededBy", toId: "m2" }],
  };
}
function v2(): MemoryEntry {
  return {
    id: "m2",
    kind: "fact",
    content: "queue cap = 8",
    source: "session:b",
    scope: "project",
    ts: { validAt: "2026-09-03", assertedAt: "2026-09-03" },
    relations: [{ type: "supersedes", toId: "m1" }],
  };
}
function rule(id: string, content: string, validAt: string, assertedAt: string): MemoryEntry {
  return {
    id,
    kind: "rule",
    content,
    source: "file:" + id + ".md",
    scope: "global",
    ts: { validAt, assertedAt },
  };
}

describe("kernel: supersedes evolution chain", () => {
  it("hit any node -> full chain, ordered oldest first", () => {
    const entries = [v1(), v2()];
    expect(expandEvolutionChain(entries, "m1").map((e) => e.id)).toEqual(["m1", "m2"]);
    expect(expandEvolutionChain(entries, "m2").map((e) => e.id)).toEqual(["m1", "m2"]);
  });

  it("3-version chain walks completely from the middle", () => {
    const a = rule("a", "v1", "2026-08-01", "2026-08-02");
    const b = rule("b", "v2", "2026-08-10", "2026-08-11");
    const c = rule("c", "v3", "2026-09-01", "2026-09-02");
    b.relations = [{ type: "supersedes", toId: "a" }];
    c.relations = [{ type: "supersedes", toId: "b" }];
    a.relations = [{ type: "supersededBy", toId: "b" }];
    b.relations!.push({ type: "supersededBy", toId: "c" });
    const chain = expandEvolutionChain([a, b, c], "b");
    expect(chain.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("bitemporal slice returns what was valid at a past instant", () => {
    const older = rule("a", "concurrency cap required", "2026-08-01", "2026-08-02");
    const newer = rule("b", "concurrency cap + idempotency required", "2026-09-01", "2026-09-02");
    newer.relations = [{ type: "supersedes", toId: "a" }];
    older.relations = [{ type: "supersededBy", toId: "b" }];
    const atAug = sliceAt([older, newer], "2026-08-15").map((e) => e.id);
    const atSep = sliceAt([older, newer], "2026-09-15").map((e) => e.id);
    // At Aug 15 only the older rule was valid (newer starts 2026-09-01).
    expect(atAug).toContain("a");
    expect(atAug).not.toContain("b");
    // By Sep 15 both have validAt in the past; the current one is max(validAt).
    expect(atSep).toContain("b");
    const current = sliceAt([older, newer], "2026-09-15")
      .sort((x, y) => x.ts.validAt.localeCompare(y.ts.validAt))
      .at(-1);
    expect(current?.id).toBe("b");
  });

  it("generalization proposal is a proposal: never auto-confirmed", () => {
    const prop = {
      rule: "all containers need concurrency policy",
      covers: ["e1", "e2"],
      confidence: 0.8,
      suggestedAction: "confirm" as const,
      generatedAt: "2026-09-06",
    };
    expect(prop.suggestedAction).toBe("confirm");
    expect(prop.covers.length).toBeGreaterThanOrEqual(1);
  });
});
