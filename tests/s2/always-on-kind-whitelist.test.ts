// tests/s2/always-on-kind-whitelist.test.ts — 保底通道的 kind 白名单**在传 lineage 时也必须生效**。
//
// 为什么需要它 (2026-09-27, 真实缺陷): `selectAlwaysOn` 的 project 分支此前写的是
//   `if (opts.lineage?.length) return lineageVisible(e.project, opts.lineage);`
// —— **提前 return 把后面的 kind 白名单整个绕过了**。kind 判据与 scope 判据本是正交的两件事,
// 却被写成了"scope 命中即放行"。
//
// 实测 (真实库 702 条, lineage=["HX-Memory","HXLoLis"]): 候选里混进 lesson 348 条 +
// context 50 条 + pattern 8 条。对照实验证明**唯一变量就是 lineage**:
//   不传 lineage → 候选为空 (白名单生效); 传了 → 被短路。
//
// ⚠ **为什么既有的 "不收 lesson" 测试没抓到它**: 那条测试 (tests/s1/trigger-policy.test.ts)
// 调用时**不传 lineage** ⇒ 走的是没缺陷的分支。缺陷恰好在"生产路径唯一会走的那条分支"上 ——
// 而生产路径 (adapters/dsh/trigger-cache.ts) **总是**传 lineage。
// 所以本文件的每一条断言都**必须传 lineage**, 否则等于没测。
//
// 平时的掩盖机制: 400 token 的保底预算通常只装得下规则, 于是被短路的 lesson/context
// 只是"排在候选里但进不来"。一旦预算放宽 (或规则变少) 它们就会**真的进入注入块** ——
// 实测把预算放到 20000: 注入块里出现 9 条 lesson、47 条 context。
import { describe, expect, it } from "vitest";
import { isAlwaysOnKind, selectAlwaysOnDetailed } from "../../src/trigger/policy.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" };

function entry(over: Partial<MemoryEntry> & { id: string; kind: string }): MemoryEntry {
  return {
    content: "内容 " + over.id,
    source: "test",
    scope: "project",
    project: "HXLoLis",
    ts: T,
    ...over,
  } as MemoryEntry;
}

/** 刻意给足预算: 缺陷形态是"被预算掩盖", 所以预算必须大到遮不住。 */
const ROOMY = { project: "HX-Memory", lineage: ["HX-Memory", "HXLoLis"], budgetTokens: 100000, estimate: (t: string) => t.length };

const ids = (sel: ReturnType<typeof selectAlwaysOnDetailed>) => [
  ...sel.entries.map((e) => e.id),
  ...sel.blocked.map((b) => b.id),
];

describe("always-on kind 白名单: **传 lineage 时也必须生效**", () => {
  it("### 负例: 项目内 lesson 不进候选 (即使 lineage 命中该项目)", () => {
    // 这正是缺陷的形态: lineage 命中 ⇒ 修复前直接放行, lesson 混入候选。
    const sel = selectAlwaysOnDetailed([entry({ id: "l1", kind: "lesson" })], ROOMY);
    expect(ids(sel), "lesson 必须被 kind 白名单挡住, 不能因为 lineage 命中就放行").not.toContain("l1");
  });

  it("### 负例: context / pattern 同样不进候选 (它们是'按需召回'的)", () => {
    const sel = selectAlwaysOnDetailed(
      [entry({ id: "c1", kind: "context" }), entry({ id: "p1", kind: "pattern" })],
      ROOMY,
    );
    expect(ids(sel)).not.toContain("c1");
    expect(ids(sel)).not.toContain("p1");
  });

  it("### 负例: doc 仍被排除 (知识库切片不进常驻, 与传不传 lineage 无关)", () => {
    const sel = selectAlwaysOnDetailed([entry({ id: "d1", kind: "doc" })], ROOMY);
    expect(ids(sel)).not.toContain("d1");
  });

  it("正例: decision 在 lineage 命中时仍然进入 (白名单放行的那一类)", () => {
    const sel = selectAlwaysOnDetailed([entry({ id: "de1", kind: "decision" })], ROOMY);
    expect(sel.entries.map((e) => e.id)).toContain("de1");
  });

  it("### 负例: **被取代 (superseded) 的条目不进常驻** —— 旧版本不该继续当指令", () => {
    // 这条钉的是"演化链的下游保证": 一旦旧条目被置 superseded (decision 被取代的**写入期**行为,
    // 见 tests/s2/adjudication-wiring.test.ts), 保底通道必须不再注入它。
    // ⚠ 为什么单独钉 (2026-09-27 实测的**真实事故形态**): 真实库里 c82a7b72b20019609
    // ("改用 kb-index.ts 按 H2 切片") 已被同日的 c06a0decde30c4a88 ("废弃按 ## 切片…否掉
    // kb-index.ts 方案") 在**语义上**推翻, 但两条都是 active、且只有无向 relates 边 ⇒
    // 被推翻的那条**每轮都在注入**。选取层对此无能为力 (它只能看 status), 所以:
    //   · 本条测试守住"选了 status 这条路就有效";
    //   · 真正的缺口在**写入期** (跨 kind 的推翻关系被判成 add, 实测 coverage 0.079) ——
    //     那里没有判据, 不能靠改选取层弥补。
    const sel = selectAlwaysOnDetailed(
      [
        entry({ id: "live", kind: "decision" }),
        entry({ id: "dead", kind: "decision", status: "superseded" as never }),
      ],
      ROOMY,
    );
    expect(sel.entries.map((e) => e.id)).toContain("live");
    expect(ids(sel)).not.toContain("dead");
  });

  it("正例: lineage 不匹配的项目内条目**仍然被挡** (白名单放行 ≠ 跨项目泄漏)", () => {
    const sel = selectAlwaysOnDetailed([entry({ id: "x1", kind: "decision", project: "别的项目" })], ROOMY);
    expect(ids(sel)).not.toContain("x1");
  });

  it("全局 fact 保留原有行为 (不传 lineage 时也在, 见 kb-index 的对照测试)", () => {
    const sel = selectAlwaysOnDetailed(
      [entry({ id: "gf", kind: "fact", scope: "global", project: undefined })],
      { budgetTokens: 100000, estimate: (t: string) => t.length },
    );
    expect(sel.entries.map((e) => e.id)).toContain("gf");
  });

  it("白名单函数本身: 只认 rule/fact/preference/decision", () => {
    // 用 MemoryKind 的**全部合法值**做穷举, 而不是随手列几个 —— 将来加了新 kind,
    // 这条会立刻提醒"它该不该常驻", 而不是静默漏判。
    const allowed = new Set(["rule", "fact", "preference", "decision"]);
    const allKinds = ["fact", "preference", "event", "decision", "lesson", "rule", "pattern", "context", "doc"] as const;
    for (const k of allKinds) expect(isAlwaysOnKind(k), k).toBe(allowed.has(k));
  });
});

describe("always-on 选择必须**确定性**: 结果不得依赖输入数组顺序", () => {
  // 为什么必须钉 (2026-09-27 实测): 分数相同时 (同 kind + 同 importance, 规则几乎总是如此)
  // `Array.sort` 继承输入顺序, 而两个入口给的顺序不同:
  //   · store.all()          → 真相文件的块顺序;
  //   · store.entrySummaries() → SQL 行序 (无 ORDER BY)。
  // 实测同 project/lineage/预算下两条路径选出**不同集合** (8 条 vs 9 条, 差 4 条);
  // 把输入**反转**后又选出另一组。注入内容于是取决于"哪个投影被命中" —— 且**无任何报错**。
  it("反转输入数组 → 选出同一集合 (id tiebreak 的作用)", () => {
    // 条目**同分**是关键前提 (同 kind + 同 importance) —— 只有同分时排序才会退化成
    // "看输入顺序"。每条成本 = estimate(content) + 8, 这里 estimate 用字符数, 故内容取等长。
    const many: MemoryEntry[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(entry({
        id: "r" + String(i).padStart(2, "0"),
        kind: "rule",
        scope: "global",
        project: undefined,
        content: "等长规则内容占位A",     // 等长 ⇒ 同 score、同 cost
        confirmedBy: "u",
        confirmedAt: T.assertedAt,
      }));
    }
    // 只留 3 条的空间: 必然截断, 且截掉谁**只能**由 tiebreak 决定。
    const opts = { ...ROOMY, budgetTokens: 3 * ("等长规则内容占位A".length + 8) + 4 };
    const forward = selectAlwaysOnDetailed(many, opts);
    const backward = selectAlwaysOnDetailed([...many].reverse(), opts);
    expect(forward.entries.length, "预算确实造成截断 (否则本测试无意义)").toBeLessThan(many.length);
    expect(forward.entries.length, "且确实装了多条, 不是只剩 1 条").toBeGreaterThan(1);
    expect(
      backward.entries.map((e) => e.id),
      "同一逻辑查询必须给出同一结果 —— 不能取决于输入数组顺序",
    ).toEqual(forward.entries.map((e) => e.id));
  });

  it("同一份输入的两次调用 → 完全一致 (无隐藏状态)", () => {
    const many = ["a", "b", "c", "d"].map((x) => entry({ id: x, kind: "decision" }));
    const one = selectAlwaysOnDetailed(many, ROOMY);
    const two = selectAlwaysOnDetailed(many, ROOMY);
    expect(two.entries.map((e) => e.id)).toEqual(one.entries.map((e) => e.id));
  });
});
