// tests/s2/structurer-scoring-fields.test.ts — 抽取层产出的 `importance`/`confidence` 必须**走到条目上**。
//
// 为什么需要它 (2026-09-18, §765): 这两个字段自 ADR 起就声明在 `MemoryEntry` 上, 而**从未有
// 任何一层产出过它们** —— 真库实测 **475/475 全为 null**。两个具体后果:
//
// | 字段 | 未被产出时的后果 |
// | --- | --- |
// | `importance` | `compositeScore` 的 `importanceFactor` 恒为 **0.778** ⇒ **对所有条目相同, 排序上不区分任何东西** |
// | `confidence` | `adjudicator` 里 "候选置信度不低于目标才允许取代" 两边都取缺省 0.7 ⇒ 差恒为 0 ⇒ **那条判据从不生效** |
//
// **⇒ 后者更值得修**: "一个设计好的判据恒不触发" 比 "字段空着" 严重。
// (`entities` 有同样的历史: 它加载取层后填充率从 0% 起来 —— 见 structurer.ts 的注释。)
//
// 本测试走**真实路径** (`CapturePipeline.run`), 而不是直接调内部方法 ——
// 因为要守的正是"抽取层的产出**确实透传到了落盘的条目上**"这条链。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import type { StructuredTurn, TurnStructurer } from "../../src/capture/structurer.ts";

/** 一个"给出评分字段"的结构化器 (模拟 LLM 实现)。 */
function structurerWith(extra: Partial<StructuredTurn>): TurnStructurer {
  return {
    canConclude: true,
    async structure() {
      return { summary: "摘要", tags: ["t"], points: [], conclusion: "一条明确的结论", ...extra };
    },
  } as TurnStructurer;
}

async function run(extra: Partial<StructuredTurn>): Promise<Array<Record<string, unknown>>> {
  const root = mkdtempSync(join(tmpdir(), "scoring-"));
  const store = new FileBackend({ root });
  try {
    const p = new CapturePipeline(store, { structurer: structurerWith(extra) } as never);
    await p.run({ text: "记一下: 结论 X", answer: "结论 X 已确认", session: "s1" } as never);
    return store.all().map((e) => e as unknown as Record<string, unknown>);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("抽取层 → 落盘条目: 评分字段的透传", () => {
  it("**给了 importance/confidence ⇒ 落盘条目上有**", async () => {
    const all = await run({ importance: 9, confidence: 0.42 });
    const hit = all.find((e) => e.content === "一条明确的结论");
    expect(hit, "结论应已落盘").toBeTruthy();
    expect(hit!.importance).toBe(9);
    expect(hit!.confidence).toBe(0.42);
  });

  it("### 负例: **没给 ⇒ 两个字段都不出现** (不写 undefined 上线, 缺省仍走中性常量)", async () => {
    const all = await run({});
    const hit = all.find((e) => e.content === "一条明确的结论");
    expect(hit).toBeTruthy();
    expect("importance" in hit!).toBe(false);
    expect("confidence" in hit!).toBe(false);
  });

  it("### 边界: **importance=1 与 confidence=0 也要透传** (不能按真假值判断)", async () => {
    const all = await run({ importance: 1, confidence: 0 });
    const hit = all.find((e) => e.content === "一条明确的结论");
    // ⚠ 用 `if (s.confidence)` 会漏掉 0 —— 而 0 是一个**合法**的低置信值。
    expect(hit!.importance).toBe(1);
    expect(hit!.confidence).toBe(0);
  });
});
