// tests/s2/capture-review-queue.test.ts — 捕获待审队列的契约。
//
// 为什么有它 (2026-09-18): 捕获路径此前**没有撤回前置机制** —— 结构化器读出什么就直接 active
// 落盘。代价可量化: 真库里自动通道 55 条被人工撤回 **28 条 (51%)**, 工具通道仅 2% ——
// 即自动通道精确率约 60%, 而那 51% 是人事后一条条清出来的。待审把"事后清理"前移为"事前裁决"。
//
// 本文件同时钉住两条**边界**, 它们都是实测踩出来的:
//   ① 无提炼能力 (heuristic) 时不得启用待审 —— 否则所有候选都进队列, 自动沉淀全停摆 (实测 42 个测试失败);
//   ② 待审 ≠ 丢弃 —— 条目必须还在队列里等人裁决, 而不是消失。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { enqueueCaptureReview, readCaptureReview, reviewReasons } from "../../src/capture/review-queue.ts";
import type { TurnStructurer } from "../../src/capture/structurer.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cq-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 具备提炼能力的结构化器替身 (产出 conclusion)。 */
function withConclusion(conclusion: string): TurnStructurer {
  return {
    // 必须显式声明能力: 待审闸门按此判据决定"无结论"是能力缺失还是候选可疑
    // (不声明时按 false 处理, 测试会观察到"未进队列"——这正是判据生效的证据)。
    canConclude: true,
    async structure() {
      return { summary: "s", tags: [], points: [], conclusion };
    },
  };
}

describe("reviewReasons: 三条可信度判据", () => {
  it("无结论 → 进待审 (那是'用户原话被当记忆'的直接成因)", () => {
    const r = reviewReasons({ conclusion: "", question: "记住: X", answer: "" });
    expect(r.some((x) => x.startsWith("no-conclusion"))).toBe(true);
  });

  it("结论与原文重合 >90% → 进待审 (无提炼)", () => {
    const q = "缓存过期统一设为 60 秒";
    const r = reviewReasons({ conclusion: q, question: q, answer: "" });
    expect(r.some((x) => x.startsWith("high-overlap"))).toBe(true);
  });

  it("**同字乱序不算'与原文重合'** (用 LCS 而非字符集合)", () => {
    // 自查发现的缺陷 (2026-09-18): 原实现用"逐字符看是否出现在较长串里"算重合,
    // 忽略顺序与重数 ⇒ "abcde" vs "edcba" 与 "aaaaaa" vs "a" 都被判 100% 重合,
    // 于是**乱序复述**或**单字重复**的结论会被误判成"无提炼"而进待审。
    const r1 = reviewReasons({ conclusion: "edcba", question: "abcde", answer: "", expectConclusion: true });
    expect(r1.some((x) => x.startsWith("high-overlap"))).toBe(false);
    const r2 = reviewReasons({ conclusion: "a", question: "aaaaaa", answer: "", expectConclusion: true });
    expect(r2.some((x) => x.startsWith("high-overlap"))).toBe(false);
  });

  it("**完全相同仍判重合** (修复不能把真该拦的漏掉)", () => {
    const q = "缓存过期统一设为 60 秒";
    const r = reviewReasons({ conclusion: q, question: q, answer: "", expectConclusion: true });
    expect(r.some((x) => x.startsWith("high-overlap"))).toBe(true);
  });

  it("**结论明显更短时不算重合** (那是提炼, 不是照搬)", () => {
    // 长度比 < 0.5 时不判重合 —— "把 60 秒改成 90 秒"这种提炼正是我们要的。
    const r = reviewReasons({
      conclusion: "缓存 90 秒",
      question: "缓存过期统一设为 60 秒, 这是硬约束",
      answer: "",
      expectConclusion: true,
    });
    expect(r.some((x) => x.startsWith("high-overlap"))).toBe(false);
  });

  it("结论未引用回答里的具体标识符 → 进待审", () => {
    const answer = "根因在 cache.ts:42, 端口 41067。" + "补充。".repeat(100);
    const r = reviewReasons({ conclusion: "缓存需要设置过期时间", question: "缓存怎么配?", answer });
    expect(r.some((x) => x.startsWith("uncited"))).toBe(true);
  });

  it("**有产出但无结论** → 入库 + 进审核队列 (2026-10-05 语义反转)", async () => {
    // ⚠ **这条断言在 2026-10-05 反转了** (用户要求: "审核机制是用于剔除你的记忆,
    // 而不是说阻止你的记忆加入到记忆中")。旧行为是"进队列 = 不落盘", 代价实测可量化:
    // 真库 139 条待审**全部 pending** (0 条被裁决), 其中 133 条是判据误杀 ——
    // 那些内容既不在库里、也不在人眼里, 等于**静默丢弃**。
    //
    // 现在的契约 (两件事都要成立):
    //   · 条目**落盘** (审核拦不住任何东西);
    //   · 同时进队列并记下理由 (人能看到"这条被标记过", 并可剔除)。
    const dir = mkdtempSync(join(tmpdir(), "nc-"));
    try {
      const stack = openMemoryStack(dir, { episodeRetentionDays: 0, embedder: null });
      const store = stack.store;
      const lenient: TurnStructurer = {
        canConclude: true,
        async structure() {
          return { summary: "s", tags: [], points: [] }; // 无 conclusion
        },
      };
      const pipe = new CapturePipeline(store, { reviewRoot: dir, structurer: lenient });
      const res = await pipe.run({
        session: "s", turn: 1, project: "p",
        text: "next all",
        answer: "x".repeat(400) + " 根因是 cache.ts:42 的过期判断, 已改为 60 秒。",
      } as never);
      expect(res.entries.length).toBe(1); // ★ 落盘 (旧契约在这里断言 0)
      expect((await store.all()).length).toBe(1); // 真的写进了库
      expect(readCaptureReview(dir).length).toBe(1); // 同时进队列 (可被剔除)
      expect(readCaptureReview(dir)[0]!.reasons.some((r) => r.startsWith("no-conclusion"))).toBe(true);
      stack.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("**能力缺失时三条判据全部不触发** (否则队列被灌满)", () => {
    // 实测 (真实库重放 424 轮): 无 LLM 环境下有 83 条被误推进队列而落盘仅 11 条 ——
    // 根因是 expectConclusion 只守住了"无结论"这一条, 另两条不受它管, 而启发式兜底
    // 让 content 退回原文, 于是"与原文重合 >90%"对每一条都成立。
    const q = "决定采用方案 A, 缓存过期设 60 秒";
    const answer = "cache.ts:42 里有问题。" + "x".repeat(400);
    // 这三组输入在"有能力"时分别触发不同判据
    expect(reviewReasons({ conclusion: "", question: q, answer, expectConclusion: true }).length).toBeGreaterThan(0);
    expect(
      reviewReasons({ conclusion: q, question: q, answer, expectConclusion: true }).length,
    ).toBeGreaterThan(0);
    // 能力缺失时全部不触发
    expect(reviewReasons({ conclusion: "", question: q, answer, expectConclusion: false })).toEqual([]);
    expect(reviewReasons({ conclusion: q, question: q, answer, expectConclusion: false })).toEqual([]);
  });

  it("结论引用了回答里的标识符 → 不拦 (可直接落盘)", () => {
    const answer = "根因在 cache.ts:42。" + "补充。".repeat(100);
    const r = reviewReasons({
      conclusion: "缓存过期问题根因在 cache.ts:42, 已修复",
      question: "缓存怎么配?",
      answer,
    });
    expect(r).toEqual([]);
  });
});

describe("队列读写", () => {
  it("追加并读回 (坏行不影响整份队列)", () => {
    enqueueCaptureReview(root, {
      id: "m1", at: "2026-09-18T00:00:00Z", reasons: ["no-conclusion: x"],
      question: "q", conclusion: "", answerExcerpt: "a", session: "s",
    });
    const got = readCaptureReview(root);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe("m1");
  });

  it("无队列文件时返回空数组 (不是抛错)", () => {
    expect(readCaptureReview(join(root, "nope"))).toEqual([]);
  });
});

describe("gate 的适用条件 (实测边界)", () => {
  it("**无提炼能力时不得启用待审** (否则自动沉淀全停摆)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    // 不传 structurer → heuristic 兜底 (canConclude:false)
    const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
    const res = await pipe.run({
      session: "s", turn: 1, text: "踩坑: 容器并发要显式设上限", answer: "",
    } as never);
    expect(res.entries.length).toBeGreaterThan(0); // 正常落盘
    expect(readCaptureReview(root)).toHaveLength(0); // 不进队列
    stack.close();
  });

  it("**有提炼能力但结论可疑时: 照常落盘 + 进队列** (2026-10-05 语义反转)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    // 结构化器产出空 conclusion → 可疑
    const pipe = new CapturePipeline(stack.store, {
      reviewRoot: root,
      structurer: withConclusion(""),
    });
    const res = await pipe.run({
      session: "s", turn: 1, text: "踩坑: 容器并发要显式设上限", answer: "",
    } as never);
    // ★ 旧契约在这里断言 entries=0 (审核拦住了落盘); 新契约是**照常落盘**且同时入队。
    expect(res.entries).toHaveLength(1);
    expect((await stack.store.all()).length).toBe(1);
    expect(res.reviewQueued).toBeGreaterThan(0);
    const q = readCaptureReview(root);
    expect(q.length).toBeGreaterThan(0);
    expect(q[0]!.reasons.length).toBeGreaterThan(0);
    stack.close();
  });

  it("**结论达标时直接落盘, 不进队列**", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const pipe = new CapturePipeline(stack.store, {
      reviewRoot: root,
      structurer: withConclusion("容器并发必须显式设上限, 否则会拖垮下游"),
    });
    const res = await pipe.run({
      session: "s", turn: 1, text: "踩坑: 容器并发", answer: "",
    } as never);
    expect(res.entries.length).toBeGreaterThan(0);
    expect(readCaptureReview(root)).toHaveLength(0);
    stack.close();
  });
});
