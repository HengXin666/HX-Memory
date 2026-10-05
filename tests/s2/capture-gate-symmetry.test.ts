// tests/s2/capture-gate-symmetry.test.ts — 结论闸门的**对称性**契约。
//
// 为什么单独一个文件: 这是"跨分支对照"才能发现的一类缺陷 —— 单看任一分支都合理,
// 只有把两种输入并排比才看出处置矛盾。实测 (2026-09-18): 同一句只差一个问号,
//   疑问句无结论 → **直接丢弃**; 陈述句无结论 → 进待审队列。
// 后者才符合"不丢, 交给人裁决"的价值观, 因此统一到待审。
//
// 本文件的作用是防止这类不对称**再次出现** —— 断言方式是"两种输入处置相同"，
// 而不是各写一条孤立断言 (后者无法发现不对称)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { readCaptureReview } from "../../src/capture/review-queue.ts";
import type { TurnStructurer } from "../../src/capture/structurer.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-sym-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 有提炼能力但读不出结论 (模拟 LLM 读了却说不出结论)。 */
const cannotConclude: TurnStructurer = {
  canConclude: true,
  async structure() {
    return { summary: "s", tags: [], points: [] };
  },
};

/** 无提炼能力 (启发式兜底): 本就没有结论可言。 */
const noAbility: TurnStructurer = {
  canConclude: false,
  async structure() {
    return { summary: "s", tags: [], points: [] };
  },
};

async function runOne(text: string, structurer: TurnStructurer) {
  const store = new FileBackend({ root });
  const pipe = new CapturePipeline(store, { reviewRoot: root, structurer });
  const res = await pipe.run({ session: "s", turn: 1, text, answer: "回答内容。" } as never);
  // ⚠ stored 用**本轮落盘数** (res.entries), 不用 store.all().length ——
  // 后者在同一 root 上跑两轮时会累加 (第二轮看到第一轮的文件), 于是"对称性"断言
  // 变成在比"跑了几轮"。这是 2026-10-05 把 stored 从恒 0 改成真实落盘后才暴露的。
  const out = { stored: res.entries.length, queued: readCaptureReview(root).length, res };
  store.close();
  return out;
}

describe("闸门对称性: 处置不应取决于问号", () => {
  it("**有提炼能力但无结论** → 疑问句与陈述句处置一律相同 (都不丢)", async () => {
    // 两句都能通过 captureTurn, 差别只在问号
    const question = await runOne("决定采用哪个方案? 缓存过期要设多少才合理", cannotConclude);
    rmSync(join(root, "review-capture"), { recursive: true, force: true });
    const statement = await runOne("决定采用方案 A, 缓存过期设 60 秒", cannotConclude);

    // 断言"处置相同"而不是各写一条 —— 后者发现不了不对称
    expect(question.stored).toBe(statement.stored);
    expect(question.queued).toBe(statement.queued);
    expect(question.queued).toBeGreaterThan(0); // 两者都被标记进队列
    // ⚠ 2026-10-05 反转: 旧契约断言 stored=0 (审核拦住落盘)。
    // 新契约是**两者都落盘** —— "不丢"由"入库 + 可剔除"实现, 而不是由"进队列但不入库"。
    expect(question.stored).toBeGreaterThan(0);
  });

  it("待审原因相同 (都是 no-conclusion)", async () => {
    await runOne("决定采用哪个方案? 缓存过期要设多少才合理", cannotConclude);
    const q = readCaptureReview(root);
    expect(q.length).toBeGreaterThan(0);
    expect(q[0]!.reasons.some((r) => r.startsWith("no-conclusion"))).toBe(true);
  });

  it("**无提炼能力**时保持原行为 (不因对称化把所有轮次推进队列)", async () => {
    // 启发式兜底从不出结论, 若也进待审则无 LLM 环境自动沉淀全停摆
    const r1 = await runOne("决定采用方案 A, 缓存过期设 60 秒", noAbility);
    expect(r1.stored).toBeGreaterThan(0); // 直接落盘
    expect(r1.queued).toBe(0); // 不进队列
  });

  it("有结论时不进待审 (直接落盘) —— 判据不能误拦", async () => {
    const good: TurnStructurer = {
      canConclude: true,
      async structure() {
        return { summary: "s", tags: [], points: [], conclusion: "缓存过期统一设为 60 秒" };
      },
    };
    const r = await runOne("决定采用方案 A, 缓存过期设 60 秒", good);
    expect(r.stored).toBeGreaterThan(0);
    expect(r.queued).toBe(0);
  });
});
