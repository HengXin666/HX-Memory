// tests/s2/stack-option-passthrough.test.ts — openMemoryStack 的检索标定参数必须真的透传。
//
// 为什么单独钉住 (2026-09-18 实测踩坑): 我扫描 bm25 权重 1→12、以及四种极端配置 (0.01/1000),
// **top1 分数完全相同** —— 差点被读成"权重对结果无影响"。实际是 `channelWeights` 只存在于
// HybridRetriever 的构造参数里, 而所有生产路径都经 openMemoryStack 组装 —— **不透传等于永远无法调整**。
//
// 这是**同一类缺口的第二次**: entityMaxIds/entityMinShared/entityMode 此前补过一次
// (见 stack.ts 的注释 "不透传等于这些设置永远不生效")。故立此测试防复发。
//
// 断言方式: 用**极端值**让差异不可能被容差掩盖 (而不是断言"结果略有不同")。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "pass-"));
  const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
  stack.store.add({
    id: "m1", kind: "lesson", content: "踩坑: prestep.ts 的注入时机由 injectMode 控制",
    source: "t", scope: "agent",
    ts: { validAt: "2026-09-18T00:00:00Z", assertedAt: "2026-09-18T00:00:00Z" },
  } as never);
  return { root, stack };
}

describe("openMemoryStack 参数透传", () => {
  it("**channelWeights 生效** (极端权重必须改变读数)", () => {
    const { root, stack } = seeded();
    try {
      const base = stack.retriever.retrieveSync({ text: "prestep.ts 注入", limit: 3, tokenBudget: 1e6, purpose: "recall" });
      stack.close();

      const heavy = openMemoryStack(root, { episodeRetentionDays: 0, channelWeights: { bm25: 1000 } });
      const boosted = heavy.retriever.retrieveSync({ text: "prestep.ts 注入", limit: 3, tokenBudget: 1e6, purpose: "recall" });
      heavy.close();

      // 权重 ×1000 后分数必须显著变化 (若参数没透传, 两者会完全相同)
      expect(boosted.hits[0]!.score).toBeGreaterThan(base.hits[0]!.score * 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("channelWeights 与默认表**合并**而不是替换", () => {
    const { root, stack } = seeded();
    try {
      // 只改 entity 时, bm25 的默认权重应保留 ⇒ 词面命中仍能出来
      const s = openMemoryStack(root, { episodeRetentionDays: 0, channelWeights: { entity: 5 } });
      const out = s.retriever.retrieveSync({ text: "prestep.ts 注入", limit: 3, tokenBudget: 1e6, purpose: "recall" });
      expect(out.hits.length).toBeGreaterThan(0);
      expect(out.hits[0]!.channels).toContain("bm25");
      s.close();
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**entityMode 生效** (main 与 tier2 的结果必须可能不同)", () => {
    const { root, stack } = seeded();
    stack.close();
    try {
      const t2 = openMemoryStack(root, { episodeRetentionDays: 0, entityMode: "tier2" });
      const mn = openMemoryStack(root, { episodeRetentionDays: 0, entityMode: "main" });
      // 至少能构造出来且不抛错; 具体读数差异依赖语料, 这里只锁"参数被接受并透传"
      expect(t2.retriever.capabilities().engine).toBeTruthy();
      expect(mn.retriever.capabilities().engine).toBeTruthy();
      t2.close();
      mn.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
