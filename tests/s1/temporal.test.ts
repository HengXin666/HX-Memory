// kernel/temporal.ts: "昨天定的压过去年定的" 必须在数值上成立, 且不依赖 id / 输入顺序 / 命中次数。
import { describe, expect, it } from "vitest";
import { DECAY, decayCurve, effectiveConfidence, retention, supersedeByRecency, SUPERSEDED_FACTOR } from "../../src/kernel/temporal.ts";
import { compositeScore } from "../../src/kernel/ranking.ts";
import { selectAlwaysOnDetailed } from "../../src/trigger/always-on.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const NOW = "2026-11-01T12:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
function rule(id: string, content: string, age: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const at = daysAgo(age);
  return { id, kind: "rule", scope: "global", content, source: "review", ts: { validAt: at, assertedAt: at }, confirmedBy: "hx", confirmedAt: at, status: "active", ...extra } as MemoryEntry;
}

describe("retention 曲线", () => {
  it("rule: 0 天 1.0, 半衰期处 = floor + (1-floor)/2, 一年后贴近地板, 十年仍是地板 (不消失)", () => {
    const p = DECAY.rule;
    expect(retention(0, p)).toBe(1);
    expect(retention(p.halfLifeDays, p)).toBeCloseTo(p.floor + (1 - p.floor) / 2, 6);
    expect(retention(365, p)).toBeLessThan(p.floor + 0.01);
    expect(retention(3650, p)).toBeCloseTo(p.floor, 6);
  });
  it("单调不增, doc 恒 1", () => {
    for (const { kind, points } of decayCurve()) {
      for (let i = 1; i < points.length; i++) expect(points[i]![1]).toBeLessThanOrEqual(points[i - 1]![1]);
      if (kind === "doc") expect(points.every(([, r]) => r === 1)).toBe(true);
    }
  });
});

describe("昨天定的压过去年定的", () => {
  it("无冲突时: 同 importance 的两条规则, 1 天前的排在 365 天前的前面 (比值 > 4 倍)", () => {
    const fresh = rule("z-new", "提交前必须跑 lint", 1);
    const old = rule("a-old", "接口返回统一用 snake_case", 365);
    const s = (e: MemoryEntry) => compositeScore({ base: 1, entry: e, now: NOW });
    expect(s(fresh) / s(old)).toBeGreaterThan(4);
  });

  it("老规则被注入 500 次也翻不了盘 (命中不再让规范性条目变年轻)", () => {
    const fresh = rule("z-new", "提交前必须跑 lint", 1);
    const old = rule("a-old", "接口返回统一用 snake_case", 365, { reinforcement: 500, lastHitAt: daysAgo(0) });
    expect(compositeScore({ base: 1, entry: fresh, now: NOW })).toBeGreaterThan(compositeScore({ base: 1, entry: old, now: NOW }));
  });

  it("同话题且新的一条带改写信号: 旧的被压 (×0.1), 哪怕只差一天", () => {
    const older = rule("a", "测试只在 GitHub 上跑, 本地禁止跑测试", 2);
    const newer = rule("b", "改为: 测试只在全部任务完成后、提交前在本地跑一次", 1);
    const sup = supersedeByRecency([newer, older]);
    expect(sup.get("a")?.by).toBe("b");
    expect(sup.has("b")).toBe(false);
    expect(effectiveConfidence(older, NOW, true) / effectiveConfidence(older, NOW, false)).toBeCloseTo(SUPERSEDED_FACTOR, 6);
  });

  it("同领域但互相补充 (无改写信号、重合不够强): 不压, 只按时间排", () => {
    const a = rule("a", "RRF 的 k 从 60 改到 20 之后 R@3 明显上升", 30);
    const b = rule("b", "bm25 权重的最优点随 RRF k 右移到 1.4", 29);
    expect(supersedeByRecency([a, b]).size).toBe(0);
  });

  it("always-on: 被压的旧规则不注入, 进 blocked (成因 superseded); 剩下的按新旧排, 与 id 和输入顺序无关", () => {
    const older = rule("a-old", "测试只在 GitHub 上跑, 本地禁止跑测试", 400);
    const newer = rule("z-new", "改为: 测试只在全部任务完成后、提交前在本地跑一次", 1);
    const other = rule("m-mid", "日志统一写到 logs 目录", 200);
    for (const input of [[older, newer, other], [other, newer, older]]) {
      const sel = selectAlwaysOnDetailed(input, { budgetTokens: 4000, estimate: (t) => t.length, now: NOW });
      expect(sel.entries.map((e) => e.id)).toEqual(["z-new", "m-mid"]);
      expect(sel.blocked).toEqual([expect.objectContaining({ id: "a-old", reason: "superseded", supersededBy: "z-new" })]);
    }
  });

  it("always-on 不给 now 时行为不变 (老调用点)", () => {
    const older = rule("a-old", "测试只在 GitHub 上跑, 本地禁止跑测试", 400);
    const newer = rule("z-new", "改为: 测试只在全部任务完成后、提交前在本地跑一次", 1);
    const sel = selectAlwaysOnDetailed([older, newer], { budgetTokens: 4000, estimate: (t) => t.length });
    expect(sel.entries.map((e) => e.id)).toEqual(["a-old", "z-new"]);
  });
});
