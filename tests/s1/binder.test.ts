// tests/s1/binder.test.ts — S1: 声明式绑定 + 确定性注入 (VCP 理念落点)。
// 双线对照的"新线"单元测试: 有绑定 → 注入是确定性的, 与模型自觉无关。
import { describe, expect, it } from "vitest";
import {
  Binder,
  bindingShouldInject,
  resolveBinding,
  type BindingConfig,
  type MemoryBinding,
} from "../../src/kernel/binder.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

function entry(partial: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    kind: "lesson",
    content: "",
    source: "t",
    scope: "project",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    ...partial,
  };
}

const ruleA = entry({
  id: "rA",
  kind: "rule",
  scope: "global",
  content: "所有容器都要显式设计并发上限",
});
const ruleB = entry({
  id: "rB",
  kind: "rule",
  scope: "global",
  content: "生产发布必须走灰度, 禁止直推主干",
});

function mem(entries: MemoryEntry[]) {
  return (q: Query) =>
    entries.filter(
      (e) => (q.kind ? e.kind === q.kind : true) && (q.scope ? e.scope === q.scope : true),
    );
}

describe("bindingShouldInject", () => {
  it("无 signalWords → 总是注入 (有绑定即每轮)", () => {
    const b: MemoryBinding = { id: "x", query: { scope: "global" } };
    expect(bindingShouldInject(b, "随便聊聊")).toBe(true);
  });
  it("命中信号词才注入", () => {
    const b: MemoryBinding = { id: "x", query: {}, signalWords: ["并发", "容器"] };
    expect(bindingShouldInject(b, "今天天气不错")).toBe(false);
    expect(bindingShouldInject(b, "这个容器并发上限设多少")).toBe(true);
  });
});

describe("resolveBinding", () => {
  it("按文本相关性排序 + 截断 max", () => {
    const b: MemoryBinding = { id: "rules", query: { kind: "rule", scope: "global" }, max: 1 };
    const out = resolveBinding(b, [ruleA, ruleB], "容器 并发 上限");
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("rA"); // 命中"容器/并发/上限"得分更高
  });
  it("信号词未命中 → 空注入", () => {
    const b: MemoryBinding = { id: "rules", query: { scope: "global" }, signalWords: ["并发"] };
    expect(resolveBinding(b, [ruleA], "聊聊部署")).toEqual([]);
  });
});

describe("Binder (确定性注入)", () => {
  const entries = [ruleA, ruleB];
  const configs: BindingConfig[] = [
    {
      project: "proj-web",
      bindings: [{ id: "rules", query: { kind: "rule", scope: "global" } }],
    },
  ];
  const binder = new Binder(mem(entries), () => configs);

  it("声明了绑定的项目 → 每轮确定性注入规则, 无需模型调工具", () => {
    const injected = binder.injectFor("proj-web", "帮我看看这个容器怎么部署");
    expect(injected).toContain("并发上限");
  });

  it("未声明绑定的项目 → 零注入 (零开销快速路径)", () => {
    expect(binder.injectFor("proj-other", "帮我看看这个容器")).toBe("");
  });

  it("注入含绑定名分节, 与 recall 同风格", () => {
    const injected = binder.injectFor("proj-web", "容器");
    expect(injected).toContain("【rules】");
    // 2026-09: 行首的 `[id] ` 句柄已去掉 (实测几乎从未被模型用过, 却占条目正文 46% 的字符)。
    // 2026-09-27: 行首改为 **kind 标记** `[rule]` —— 与 `[id]` 不同性质:
    // 它给的是"这条例子的效力等级"(框架句承诺"标记为 rule 的是已确认跨项目约束"),
    // 而不是给机器的句柄。二者形态也不同 (kind 名 vs 16 进制 id), 不会互相误认。
    // 2026-09-29: 行尾的 `<!--hx-memory:id=…-->` 也移出了正文 (9 条约省 88 token) ——
    // id 现在随**消息 source** 走 (prestep 写入, 见 kernel/injection-format 头注)。
    // 因此这里的正文只剩 kind + 内容; 去重判据改由 source.entryIds 承载, 行为不变。
    expect(injected).toContain("- [rule] 所有容器都要显式设计并发上限");
    expect(injected, "正文里不该再有 id 标记").not.toContain("hx-memory:id=");
  });
});
