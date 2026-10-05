// tests/s2/graph-incoming.test.ts — 图遍历必须支持**入边**方向 (且与出边的不对称是设计)。
//
// 为什么需要它 (2026-09-18): `traverseIncoming` 是为修一个实测缺口而加的 ——
// 语义边只有「抽象 → 实例」一个方向, 而**用户的提问方向常是反的**
// ("这个具体的坑, 对应哪条通用规则?")。同库 A/B 实测: 只走出边 gold 命中 0/4, 加入边后 2/4。
//
// 三件必须钉住的事:
//   ① **可见性对称**: 入边与出边用同一判据 (两端都非 shadow)。少判一端就会让撤回的节点复活;
//   ② **不对称是设计, 不是 bug**: 同一条边, out(抽象) 能拿到实例, out(实例) 拿不到抽象 ——
//      正因如此才需要 incoming。若有人"顺手"把它改成对称, 本文件应当变红;
//   ③ **可选能力缺失时不崩**: 引擎没有反向索引时, 出边扩展必须照常工作 (与 byEntities 同一设计)。
import { describe, expect, it } from "vitest";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const mk = (
  id: string,
  content: string,
  opts: { status?: string; relations?: Array<{ type: string; toId: string; weight: number }> } = {},
): MemoryEntry =>
  ({
    id,
    kind: "lesson",
    content,
    source: "t",
    scope: "agent",
    status: opts.status ?? "active",
    ts: T,
    ...(opts.relations ? { relations: opts.relations } : {}),
  }) as unknown as MemoryEntry;

/** 抽象 A --generalizes--> 实例 B; C 指向已撤回的 A (用于可见性测试)。 */
function seed() {
  const s = new MemoryBackend();
  s.add(mk("abst", "抽象规则: 禁止静默降级", { relations: [{ type: "generalizes", toId: "inst", weight: 1 }] }));
  s.add(mk("inst", "实例: 某轮实测发现静默吞错了"));
  s.add(mk("dead", "已撤回的抽象", { status: "shadow", relations: [{ type: "generalizes", toId: "inst2", weight: 1 }] }));
  s.add(mk("inst2", "另一个实例"));
  s.add(mk("orphan", "没有任何入边的条目"));
  return s;
}

describe("图遍历: 出边与入边", () => {
  it("**出边**: 从抽象拿到实例 (既有行为不许回归)", () => {
    const s = seed();
    expect(s.traverse("abst", "generalizes").map((e) => e.id)).toEqual(["inst"]);
  });

  it("**入边**: 从实例拿到抽象 —— 这正是缺口所在", () => {
    const s = seed();
    expect(s.traverseIncoming("inst", "generalizes").map((e) => e.id)).toEqual(["abst"]);
  });

  it("**不对称是设计**: 从实例走出边拿不到抽象 (若变红说明有人把它改对称了)", () => {
    const s = seed();
    expect(s.traverse("inst", "generalizes")).toEqual([]);
    // 而反向能拿到 —— 两者合起来才是本文件要守的性质
    expect(s.traverseIncoming("inst", "generalizes")).toHaveLength(1);
  });

  it("**可见性对称**: 已撤回的源不进结果 (与出边同判据)", () => {
    const s = seed();
    // dead 已撤回, 它指向 inst2 的边不该被 walked
    expect(s.traverseIncoming("inst2", "generalizes")).toEqual([]);
    expect(s.traverse("dead", "generalizes")).toEqual([]);
  });

  it("**已撤回的目标也不进结果** (入边的另一端同样要判)", () => {
    const s = new MemoryBackend();
    s.add(mk("live", "存活抽象", { relations: [{ type: "generalizes", toId: "gone", weight: 1 }] }));
    s.add(mk("gone", "已撤回实例", { status: "shadow" }));
    expect(s.traverseIncoming("gone", "generalizes")).toEqual([]);
    expect(s.traverse("live", "generalizes")).toEqual([]);
  });

  it("无入边的条目返回空 (不是抛错)", () => {
    const s = seed();
    expect(s.traverseIncoming("orphan", "generalizes")).toEqual([]);
  });

  it("边类型不匹配时返回空", () => {
    const s = seed();
    expect(s.traverseIncoming("inst", "supersedes")).toEqual([]);
  });
});
