// tests/s3/user-journey.test.ts — 用户旅程: 「问了库里有的事」与「问了库里没有的事」。
//
// 为什么需要它 (2026-09-18, §620): `tests/s3/full-chain.test.ts` 覆盖了**写入侧**的四段
// (捕获 → 注入 → 溯源 → 跨会话), 而**检索决策**那一段在 s3 里是空白 ——
// `grep -l 'shouldAbandon|意图|budgetTokens' tests/s3/` 零命中 (只有 s2 的单元级覆盖)。
//
// 于是补这条**用户可感的旅程**: 同一个真实装配下, 一条**库内**问题应当命中,
// 一条**库外**问题应当**返回空** —— 后者是产品自己的承诺:
// `memory_search` 的工具描述写着「没返回东西说明确实没有记录」, 而那句话
// 只在弃权闸门生效时才成立。
//
// ⚠ 用**真实装配件** (与 full-chain 同一原则): `openMemoryStack` + `CapturePipeline`
// + `flushTurn`, 不用替身 —— full-chain 的头注记录了"替身签名不一致导致假象"的教训。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";

/** 建一个只装了**一条**真实记忆的库, 走真实捕获路径。 */
async function seedOne(root: string) {
  const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
  const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
  await flushTurn(
    { episodes: () => stack.episodes, log: () => null, pipe, surface: "dsh" },
    {
      session: "journey",
      turn: 1,
      project: "p",
      question: "记住: 生产库禁止直连, 必须走只读副本",
      answer: "已记录该硬约束。",
    } as never,
  );
  return stack;
}

describe("用户旅程: 库内问题命中 / 库外问题弃权", () => {
  it("**库内**问题命中 (用户问的正是库里记过的)", async () => {
    const root = mkdtempSync(join(tmpdir(), "journey-"));
    const stack = await seedOne(root);
    try {
      expect(stack.store.all().length).toBeGreaterThan(0);
      const out = stack.facade.recall({
        text: "生产库能直连吗",
        purpose: "recall",
        limit: 5,
        tokenBudget: 4000,
      });
      expect((out.hits ?? []).length, "库内问题应当命中").toBeGreaterThan(0);
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**库外**问题返回空 (「没返回东西说明确实没有记录」这句话必须成立)", async () => {
    const root = mkdtempSync(join(tmpdir(), "journey-"));
    const stack = await seedOne(root);
    try {
      // 一个明确的库外技术主题 —— 库里只有一条"生产库禁止直连"。
      const out = stack.facade.recall({
        text: "PostgreSQL 的 autovacuum 什么时候触发",
        purpose: "recall",
        limit: 5,
        tokenBudget: 4000,
      });
      expect(
        (out.hits ?? []).length,
        "库外问题必须返回空 —— 否则「没返回东西说明确实没有记录」是假话",
      ).toBe(0);
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**注入路径**不返回那条无关记忆 (⚠ 它与弃权闸门无关 —— 见下)", async () => {
    const root = mkdtempSync(join(tmpdir(), "journey-"));
    const stack = await seedOne(root);
    try {
      const out = stack.facade.recall({
        text: "PostgreSQL 的 autovacuum 什么时候触发",
        purpose: "inject",
        limit: 5,
        tokenBudget: 4000,
      });
      // ⚠ 注入路径**有 always-on 保底通道** (规则无条件注入) ⇒ 这里可能非空。
      // 判据不是"必须为空", 而是"**不能包含那条无关记忆**" —— 那才是编造。
      const leaked = (out.hits ?? []).filter((h) => h.entry.content.includes("生产库禁止直连"));
      expect(leaked.length, "库外问题不该召回到那条无关的库内记忆").toBe(0);

      // ⚠ **本测试测的是"整条链路不漏无关内容", 不是某一个闸门** (§620 三次反驳发现)。
      //
      // 我起初以为它测的是弃权闸门, 于是**连做三次反驳**, 每次都把某个环节关掉:
      //
      // | 关掉什么 | 本测试 | 说明 |
      // | --- | --- | --- |
      // | hybrid.ts 的 shouldAbstain(...) | **仍全过** | 从没走到它 |
      // | hybrid.ts 的 qualifiesCandidate(...) | **仍全过** | 收尾阶段的二次过滤 |
      // | channels.ts 的 deps.qualifies(e) | **仍全过** | 通道层资格 |
      //
      // **⇒ 过滤发生在**更早**的地方: SQL/FTS 层** (searchText)。"生产库"与
      // "PostgreSQL autovacuum" 没有词面交集 ⇒ FTS 压根不返回它, 后面三道闸门无事可做。
      //
      // ⇒ 所以本测试的价值是**端到端不漏无关内容** (一个集成断言), 而不是"某闸门正确"。
      // 那三道闸门各自的正确性由 s2 的单元测试覆盖 (那里能直接造 hits/candidates)。
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
