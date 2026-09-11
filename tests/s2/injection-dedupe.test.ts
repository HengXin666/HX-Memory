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
import { formatEntryLine, parseInjectedIds } from "../../src/kernel/injection-format.ts";

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

describe("注入行的稳定 id 标记", () => {
  it("格式化后可被解析回原 id (标记是人类可忽略的行尾注释)", () => {
    const line = formatEntryLine("r123", "规则内容");
    expect(line.startsWith("- [r123] 规则内容")).toBe(true);
    expect(parseInjectedIds(line)).toEqual(["r123"]);
  });

  it("解析整块注入文本时按出现顺序去重", () => {
    const block = [formatEntryLine("a", "x"), formatEntryLine("b", "y"), formatEntryLine("a", "x")]
      .join("\n");
    expect(parseInjectedIds(block)).toEqual(["a", "b"]);
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
    const ids = parseInjectedIds(first);
    const again = binder.injectFor("api", "容器并发上限设多少合适", ids);
    expect(again).toBe("");
    stack.close();
  });
});
