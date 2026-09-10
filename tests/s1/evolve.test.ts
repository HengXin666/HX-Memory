// tests/s1/evolve.test.ts — 演化裁决: 取代 / 冲突 / 规则豁免 (纯逻辑)。
import { describe, expect, it } from "vitest";
import {
  decideEvolution,
  hasNegation,
  hasUpdateSignal,
  hardConflict,
  numbersIn,
} from "../../src/evolution/evolve.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
const e = (id: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  kind: "lesson",
  content,
  source: "t",
  scope: "agent",
  ts: T,
  status: "active",
  ...over,
});

describe("信号与冲突判定", () => {
  it("更新信号: 改为/不再/废弃 等命中; 普通表述不命中", () => {
    for (const text of ["并发上限改为 50", "这条不再适用", "旧方案已废弃", "renamed to x"]) {
      expect(hasUpdateSignal(text)).toBe(true);
    }
    expect(hasUpdateSignal("容器并发要显式设上限")).toBe(false);
    expect(hasUpdateSignal("并且要加超时熔断")).toBe(false);
  });

  it("数字集合与极性", () => {
    expect([...numbersIn("上限 10 与 3.5%")].sort()).toEqual(["10", "3.5%"]);
    expect(hasNegation("不要开启过期")).toBe(true);
    expect(hasNegation("要开启过期")).toBe(false);
  });

  it("硬冲突: 数字不一致 或 极性相反", () => {
    expect(hardConflict("并发上限 10", "并发上限 50")).toBe(true);
    expect(hardConflict("缓存要开启过期", "缓存不要开启过期")).toBe(true);
    expect(hardConflict("并发上限 10", "并发上限 10 并且要加锁")).toBe(false);
  });
});

describe("演化裁决", () => {
  it("显式更新信号 + 同话题 + 同种类 → supersede", () => {
    const d = decideEvolution(
      {
        kind: "lesson",
        content: "容器并发上限改为 50",
        ts: { validAt: "2026-06-02T00:00:00.000Z", assertedAt: "2026-06-02T00:00:00.000Z" },
      },
      [e("old", "容器并发上限设为 10")],
    );
    expect(d.action).toBe("supersede");
    expect(d.targetId).toBe("old");
    expect(d.reason).toBe("explicit-update-signal");
  });

  it("无更新信号但数字矛盾 → contradict (两条都留, 不猜哪个对)", () => {
    const d = decideEvolution({ kind: "lesson", content: "容器并发上限是 50" }, [
      e("old", "容器并发上限是 10"),
    ]);
    expect(d.action).toBe("contradict");
    expect(d.targetId).toBe("old");
  });

  it("时间倒退 (候选 validAt 更早) 不允许取代", () => {
    const d = decideEvolution(
      {
        kind: "lesson",
        content: "容器并发上限改为 50",
        ts: { validAt: "2026-05-01T00:00:00.000Z", assertedAt: T.assertedAt },
      },
      [e("old", "容器并发上限设为 10")],
    );
    expect(d.action).not.toBe("supersede");
  });

  it("种类不同不允许取代 (不能被 lesson 推翻 decision)", () => {
    const d = decideEvolution({ kind: "decision", content: "容器并发上限改为 50" }, [
      e("old", "容器并发上限设为 10", { kind: "lesson" }),
    ]);
    expect(d.action).not.toBe("supersede");
  });

  it("候选是 rule → 永不自动演化 (只 add, 人工闸门)", () => {
    const d = decideEvolution({ kind: "rule", content: "容器并发上限改为 50" }, [
      e("old", "容器并发上限设为 10"),
    ]);
    expect(d.action).toBe("add");
    expect(d.reason).toBe("rule-never-auto-evolves");
  });

  it("目标是 rule → 只标记冲突, 绝不改规则状态", () => {
    const ruleEntry = e("rule-1", "容器并发上限设为 10", {
      kind: "rule",
      scope: "global",
      confirmedBy: "hx",
      confirmedAt: T.assertedAt,
    });
    const d = decideEvolution({ kind: "lesson", content: "容器并发上限改为 50" }, [ruleEntry]);
    expect(d.action).toBe("contradict");
    expect(d.reason).toContain("rule");
  });

  it("语义兜底: 向量很接近但字面不重合 → duplicate (只强化, 不落盘)", () => {
    const d = decideEvolution(
      { kind: "lesson", content: "每次部署前要跑一次全量回归" },
      [e("old", "上线之前必须做一次完整回归测试")],
      { semanticSimilarity: () => 0.99, semanticDuplicateFloor: 0.95 },
    );
    expect(d.action).toBe("duplicate");
    expect(d.targetId).toBe("old");
    expect(d.reason).toBe("semantic-duplicate");
  });

  it("语义相似度不足 / 候选太短 → 不吞并", () => {
    const low = decideEvolution(
      { kind: "lesson", content: "每次部署前要跑一次全量回归" },
      [e("old", "上线之前必须做一次完整回归测试")],
      { semanticSimilarity: () => 0.5 },
    );
    expect(low.action).not.toBe("duplicate");
    const short = decideEvolution({ kind: "lesson", content: "上限 10" }, [e("old", "上限 50")], {
      semanticSimilarity: () => 0.99,
    });
    expect(short.action).not.toBe("duplicate");
  });

  it("无关内容 → add; 相关但不等价 → link (基线的去重/建边行为不变)", () => {
    const unrelated = decideEvolution({ kind: "lesson", content: "前端圆角改成 8px" }, [
      e("old", "容器并发上限设为 10"),
    ]);
    expect(unrelated.action).toBe("add");
    const related = decideEvolution(
      { kind: "lesson", content: "数据库连接池要设置最大连接数与超时" },
      [e("old", "数据库连接池超时设置")],
    );
    expect(related.action).toBe("link");
  });
});
