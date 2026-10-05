// tests/s2/capture-review-resolve.test.ts — 待审裁决的端到端契约 (接受/丢弃真的生效)。
//
// 为什么有它: 队列只有"看"没有"处置"是半成品 —— 人看懂了原因却无法动作,
// 待审就只是把"事后清理"换成了"事后围观"。本文件钉住两个动作的**真实效果**。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import {
  enqueueCaptureReview,
  readCaptureReview,
  setCaptureReviewStatus,
} from "../../src/capture/review-queue.ts";
import { resolveCaptureReview } from "../../src/adapters/dsh/gateway-memory.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "resolve-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一个 EpisodeStore (待审溯源测试用)。 */
function stack_episodes() {
  return new EpisodeStore({ root, retentionDays: 0 });
}

function seedQueue() {
  enqueueCaptureReview(root, {
    id: "c1", at: "2026-09-18T00:00:00Z", reasons: ["no-conclusion: x"],
    question: "记住: 缓存过期统一设为 60 秒", conclusion: "", answerExcerpt: "a", session: "s",
    project: "p",
  });
}

describe("队列状态更新", () => {
  it("setCaptureReviewStatus 改状态而不是删行 (裁决可审计)", () => {
    seedQueue();
    expect(setCaptureReviewStatus(root, "c1", "rejected")).toBe(true);
    const items = readCaptureReview(root);
    expect(items).toHaveLength(1); // 行仍在
    expect(items[0]!.status).toBe("rejected");
  });

  it("未裁决的项 status 缺省视为 pending (旧数据兼容)", () => {
    seedQueue();
    expect(readCaptureReview(root)[0]!.status).toBeUndefined();
  });

  it("找不到 id 时返回 false", () => {
    seedQueue();
    expect(setCaptureReviewStatus(root, "nope", "accepted")).toBe(false);
  });
});

describe("resolveCaptureReview: 两个动作", () => {
  function queueBridge() {
    return {
      setStatus: (id: string, status: "accepted" | "rejected") =>
        setCaptureReviewStatus(root, id, status),
      item: (id: string) => readCaptureReview(root).find((x) => x.id === id) ?? null,
    };
  }

  it("**keep 只是确认 (条目本来就在库里)**, 不重复写入", async () => {
    seedQueue();
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    // 新语义下条目在捕获时**已经落盘**; 这里显式造出那个状态 (旧契约里是 accept 才写)。
    await stack.store.add({
      id: "c1", kind: "fact", content: "缓存过期统一设为 60 秒",
      source: "session:s", scope: "project", project: "p",
      ts: { validAt: "2026-09-18T00:00:00Z", assertedAt: "2026-09-18T00:00:00Z" },
    } as never);
    const before = stack.store.all().length;
    const res = await resolveCaptureReview(stack.facade, queueBridge(), "c1", "keep");
    expect(res.ok).toBe(true);
    expect(stack.store.all().length).toBe(before); // ★ 不重复写 (旧契约会 +1)
    expect(readCaptureReview(root)[0]!.status).toBe("accepted");
    stack.close();
  });

  it("**drop 真的把它从可用记忆里剔除** (写 shadow, 不是只出队)", async () => {
    // ⚠ 2026-10-05 语义反转的核心: 旧 `reject` 只改队列状态, 而条目**本来就没入库**;
    // 新契约下条目已入库, 因此"剔除"必须真的发生 —— 否则这个动作是一句空话。
    const ep = stack_episodes();
    const e1 = ep.append({ session: "s", turn: 1, role: "user", text: "记住: 缓存过期统一设为 60 秒" });
    enqueueCaptureReview(root, {
      id: "c2", at: "2026-09-18T00:00:00Z", reasons: ["uncited: x"],
      question: "记住: 缓存过期统一设为 60 秒", conclusion: "", answerExcerpt: "", session: "s",
      episodeIds: [e1.id],
    });
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    await stack.store.add({
      id: "c2", kind: "fact", content: "缓存过期统一设为 60 秒",
      source: "session:s", scope: "project", project: "p",
      // derivedFrom 是真实捕获路径会写上的 (见 capture/engine.ts); 少了它证据链断在这里。
      derivedFrom: [e1.id],
      ts: { validAt: "2026-09-18T00:00:00Z", assertedAt: "2026-09-18T00:00:00Z" },
    } as never);
    const bridge = {
      setStatus: (id: string, st: "accepted" | "rejected") => setCaptureReviewStatus(root, id, st),
      item: (id: string) => readCaptureReview(root).find((x) => x.id === id) ?? null,
    };
    const res = await resolveCaptureReview(stack.facade, bridge, "c2", "drop");
    expect(res.ok).toBe(true);
    // ① 队列状态变 rejected (裁决可审计)
    expect(readCaptureReview(root)[0]!.status).toBe("rejected");
    // ② ★ 条目真的不可见了 (shadow) —— 检索与 all() 都不再给
    const live = stack.store.all().filter((e: { id: string }) => e.id === "c2");
    expect(live.length).toBe(0);
    // ③ 但**行还在** (truth-in-files: 撤回是 shadow 而不是物理删除)
    const raw = await stack.store.get("c2");
    expect(raw!.status).toBe("shadow");
    // ④ 溯源也还在: 剔除决定仍能追到原话
    const chain = await stack.facade.evidenceChain("c2");
    expect(chain!.episodes.some((x) => x.text.includes("缓存过期统一设为 60 秒"))).toBe(true);
    stack.close();
  });

  it("旧动作名 accept/reject 仍可用, 且映射到**新语义**", async () => {
    // 为什么必须兼容: 面板与既有调用点按旧名调 —— 让它们**做正确的新动作**,
    // 比改名后留下一批静默失效的调用点安全 (见 gateway-memory.ts 的说明)。
    seedQueue();
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const res = await resolveCaptureReview(stack.facade, queueBridge(), "c1", "accept");
    expect(res.ok).toBe(true); // accept = keep (确认, 不写库)
    expect(stack.store.all().length).toBe(0);
    stack.close();
  });

  it("非法 action / 空 id / 不存在的 id 都返回错误对象 (不抛异常打爆面板)", async () => {
    seedQueue();
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const q = queueBridge();
    expect((await resolveCaptureReview(stack.facade, q, "c1", "bogus")).ok).toBe(false);
    expect((await resolveCaptureReview(stack.facade, q, "  ", "keep")).ok).toBe(false);
    expect((await resolveCaptureReview(stack.facade, q, "nope", "keep")).ok).toBe(false);
    stack.close();
  });

  it("队列未挂载时如实报错", async () => {
    const res = await resolveCaptureReview(undefined, undefined, "c1", "keep");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not mounted");
  });

  // §650 的旧断言 ("无内容时拒绝 accept") 在新语义下**不再适用**:
  // keep 只确认、不写库, 因此"内容为空"不再是它需要守的门; 真正需要内容的是**旧**路径。
  it("keep 对空内容项仍可确认 (它不写库, 无需内容闸门)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    try {
      const empty = {
        setStatus: () => true,
        item: () => ({ id: "c-empty", question: "   ", conclusion: "", session: "s1" }),
      };
      expect((await resolveCaptureReview(stack.facade, empty, "c-empty", "keep")).ok).toBe(true);
      // drop 同样不需要内容 —— 剔除一条空待审项是合法的。
      expect((await resolveCaptureReview(stack.facade, empty, "c-empty", "drop")).ok).toBe(true);
    } finally {
      stack.close();
    }
  });
});
