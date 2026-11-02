// tests/frustration/pipeline.test.ts — P1 挫折链路 (PLAN J1.4 / J3.1-J3.5)。
// 多 step 回放一律走 makePreStepHandler (EVAL.md F7: 必须经过 DSH 的 pre-step 入口, 不能直接调库函数)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makePreStepHandler } from "../../src/adapters/dsh/prestep.ts";
import type { Binder } from "../../src/kernel/binder.ts";
import {
  buildReviewInput,
  createDetector,
  FrustrationPipeline,
  LessonStore,
  parseLesson,
  type Lesson,
} from "../../src/frustration/index.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});
function tmp(): string {
  const r = mkdtempSync(join(tmpdir(), "hx-frus-"));
  roots.push(r);
  return r;
}

const REPO = "/work/repo";
const user = (text: string, id?: string) => ({ role: "user", source: { kind: "user" }, content: text, ...(id ? { id } : {}) });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** 一段真实形态的对话: 助手改错了文件, 用户骂并纠正。 */
function conversation() {
  return [
    user("把 src/storage/file-lock.ts 的超时改成 5 秒"),
    assistant("好的, 我修改了 src/external/store.ts 里的超时为 5000。"),
    user("你他妈改错文件了, 我说的是 src/storage/file-lock.ts 的 timeoutMs, 不是 store.ts"),
  ];
}

const GOOD_REVIEW = JSON.stringify({
  where: "改了 src/external/store.ts, 应改 src/storage/file-lock.ts 的 timeoutMs",
  wanted: "动手前先核对用户点名的文件路径, 只改 src/storage/file-lock.ts 的 timeoutMs 默认值",
  scope: { repo: REPO, dir: "src/storage", taskType: "编码" },
  evidence: [{ turn: 2, quote: "我说的是 src/storage/file-lock.ts 的 timeoutMs, 不是 store.ts" }],
});

function stubBinder(): Binder {
  return {
    warm: async () => undefined,
    injectFor: () => "",
    lastTriggerDecision: () => ({ mode: "skip-no-signal", intent: null, confidence: 0, topicDrift: 0, reason: "" }),
    lastInjectionChannel: () => "none" as const,
    lastSelectedIds: () => [],
    lastInjectedIds: () => [],
    lastInjectedTokens: () => 0,
  } as unknown as Binder;
}

function rig(reviewOutput: string | (() => Promise<string>), root = tmp()) {
  let reviewCalls = 0;
  const store = new LessonStore(root);
  const pipeline = new FrustrationPipeline({
    detector: createDetector(),
    store,
    locate: (cwd) => ({ repo: REPO, cwd: cwd || REPO }),
    diff: () => "diff --git a/src/external/store.ts b/src/external/store.ts\n-  timeout 10000\n+  timeout 5000",
    review: async () => {
      reviewCalls++;
      return typeof reviewOutput === "string" ? reviewOutput : await reviewOutput();
    },
    sameTurnWaitMs: 2000,
  });
  const handler = makePreStepHandler(stubBinder(), {
    rootAgentsOnly: () => false,
    enabled: () => true,
    frustration: (input) => pipeline.onStep(input),
  });
  /** 回放一个 step: 返回本 step 注入块的文本 (没有注入时为空串)。 */
  const step = async (sessionId: string, messages: unknown[], n: number, cwd = REPO): Promise<string> => {
    const decision = await handler(
      { agent: { session: { id: sessionId, header: { cwd } } }, messages, step: n },
      async () => ({ kind: "enter", messages: [...messages] }),
    );
    if (decision.kind !== "enter") throw new Error("rejected");
    const added = decision.messages.slice(messages.length);
    return added.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n");
  };
  return { pipeline, store, step, reviewCalls: () => reviewCalls };
}

describe("检测: 词表 + 技术词豁免", () => {
  const d = createDetector();
  it.each(["你他妈改错文件了", "傻逼, 又错了", "不对, 我说的是 A 不是 B", "说过多少次了别再加注释"])("命中: %s", (t) => {
    expect(d.detect(t).hit).toBe(true);
  });
  it.each([
    "Node 的垃圾回收什么时候触发?",
    "滚动条样式太粗了, 看看 css",
    "kill 掉 3000 端口的进程",
    "这个错误码 ENOENT 是什么意思",
    "给这个函数起个别名",
    "回滚到上一个版本",
    "文本不对齐, 帮我看看 css",
  ])("技术词不误报: %s", (t) => {
    expect(d.detect(t).hit).toBe(false);
  });
  it("判官只做旁路: 不改判定, 只通过 onShadow 记录是否一致", async () => {
    const shadows: Array<{ model: boolean; judge: boolean | null; agree: boolean | null }> = [];
    const judged = createDetector({ shadowJudge: async () => true, onShadow: (r) => shadows.push(r) });
    const a = await judged.detectWithJudge("你他妈的");
    expect(a.hit).toBe(true);
    expect(a.via).toBe("model");
    const b = await judged.detectWithJudge("这样做完全没有达到我要的效果");
    expect(b.hit).toBe(judged.detect("这样做完全没有达到我要的效果").hit);
    await new Promise((ok) => setTimeout(ok, 10));
    expect(shadows.map((s) => s.judge)).toEqual([true, true]);
    expect(shadows[0]!.agree).toBe(true);
    const broken = createDetector({ shadowJudge: async () => { throw new Error("down"); }, onShadow: (r) => shadows.push(r) });
    expect((await broken.detectWithJudge("这样做完全没有达到我要的效果")).hit).toBe(b.hit);
  });
  it("每次判定都给出得分、阈值和贡献特征 (可观测)", () => {
    const s = d.detect("傻逼, 又错了");
    expect(typeof s.score).toBe("number");
    expect(s.score!).toBeGreaterThanOrEqual(s.threshold!);
    expect(s.contributions!.length).toBeGreaterThan(0);
    expect(s.model).toMatch(/^linear-1\//);
  });
  it("同一输入两次判定逐字段相同 (可复现)", () => {
    expect(JSON.stringify(d.detect("不对, 我说的是 A 不是 B"))).toBe(JSON.stringify(d.detect("不对, 我说的是 A 不是 B")));
  });
});

describe("同轮评审 (多 step 回放, 经 pre-step 入口)", () => {
  it("一轮 10 个 step: 检测 1 次, 评审 1 次, 结论只在第 2 个 step 注入 1 次 (A3 = 1)", async () => {
    const { pipeline, store, step, reviewCalls } = rig(GOOD_REVIEW);
    const msgs = conversation();
    const injected: string[] = [];
    for (let n = 1; n <= 10; n++) {
      injected.push(await step("s1", n === 1 ? msgs : [...msgs, assistant("继续处理第 " + n + " 步")], n));
    }
    expect(reviewCalls()).toBe(1);
    expect(injected[0]).toContain("用户这条消息是在纠正你");
    expect(injected[1]).toContain("评审结论");
    expect(injected[1]).toContain("src/storage/file-lock.ts");
    expect(injected.slice(2).every((t) => !t.includes("评审结论"))).toBe(true);
    const s = pipeline.stats();
    expect(s.maxDetectPerMessage).toBe(1);
    expect(s.maxReviewPerMessage).toBe(1);
    expect(s.conclusionsInjected).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it("评审要等一会儿时, 下一个 step 会等到结论再继续 (同一轮内交付)", async () => {
    const { step } = rig(() => new Promise((r) => setTimeout(() => r(GOOD_REVIEW), 300)));
    const msgs = conversation();
    await step("s1", msgs, 1);
    expect(await step("s1", msgs, 2)).toContain("评审结论");
  });

  it("同一句话在后面的轮次再说一遍, 算新的一次纠正", async () => {
    const { step, reviewCalls } = rig(GOOD_REVIEW);
    const msgs = conversation();
    await step("s1", msgs, 1);
    await step("s1", msgs, 2);
    const later = [...msgs, assistant("改好了"), user("你他妈改错文件了, 我说的是 src/storage/file-lock.ts 的 timeoutMs, 不是 store.ts")];
    await step("s1", later, 3);
    expect(reviewCalls()).toBe(2);
  });

  it("没有证据不入库, 也不注入模板句", async () => {
    const noEvidence = JSON.stringify({ where: "store.ts", wanted: "注意细节", scope: { repo: REPO, dir: "", taskType: "编码" }, evidence: [] });
    const { store, step, pipeline } = rig(noEvidence);
    const msgs = conversation();
    await step("s1", msgs, 1);
    const second = await step("s1", msgs, 2);
    expect(second).not.toContain("评审结论");
    expect(store.list()).toHaveLength(0);
    expect(pipeline.stats().rejected["no-evidence"]).toBe(1);
  });

  it("评审超时或报错: 不入库, 主流程不受影响", async () => {
    const { store, step } = rig(async () => { throw new Error("timeout"); });
    const msgs = conversation();
    await step("s1", msgs, 1);
    await step("s1", msgs, 2);
    expect(store.list()).toHaveLength(0);
  });
});

describe("规则按适用范围自动注入 (J3.5)", () => {
  it("新会话首个 step 注入同仓库同目录的规则; 其它仓库不注入", async () => {
    const root = tmp();
    const first = rig(GOOD_REVIEW, root);
    const msgs = conversation();
    await first.step("s1", msgs, 1);
    await first.step("s1", msgs, 2);
    expect(first.store.list()).toHaveLength(1);

    // 新进程、新会话: 不调任何工具, 第一个 step 就带上规则。
    const second = rig(GOOD_REVIEW, root);
    const inRepo = await second.step("s2", [user("继续调 file-lock 的参数")], 1, REPO + "/src/storage");
    expect(inRepo).toContain("【HX-Memory 规则】");
    expect(inRepo).toContain("timeoutMs");
    const again = await second.step("s2", [user("继续调 file-lock 的参数"), assistant("好"), user("再看看")], 2, REPO + "/src/storage");
    expect(again).not.toContain("【HX-Memory 规则】");

    const other = new LessonStore(root).match({ repo: "/work/other", cwd: "/work/other" });
    expect(other).toHaveLength(0);
    const sibling = new LessonStore(root).match({ repo: REPO, cwd: REPO + "/docs" });
    expect(sibling).toHaveLength(0);
  });
});

describe("评审输出的入库闸门 (J3.3)", () => {
  const input = buildReviewInput({ messages: conversation(), triggerIndex: 2, turns: 6, diff: "", repo: REPO, cwdDir: "" });
  it("材料按轮号标注, 含助手消息", () => {
    expect(input.firstTurn).toBe(1);
    expect(input.triggerTurn).toBe(2);
    expect(input.transcript).toContain("=== 第 1 轮 ===");
    expect(input.transcript).toContain("助手: 好的, 我修改了 src/external/store.ts");
  });
  it("合格输出通过, 且标记为点名了文件", () => {
    const r = parseLesson(GOOD_REVIEW, input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lesson.concrete).toBe(true);
  });
  it("编造的原话、越界轮号、模板句、非 JSON 都拒收", () => {
    const base = JSON.parse(GOOD_REVIEW) as Lesson & Record<string, unknown>;
    expect(parseLesson(JSON.stringify({ ...base, evidence: [{ turn: 2, quote: "用户说要改 store.ts" }] }), input)).toEqual({ ok: false, reason: "no-evidence" });
    expect(parseLesson(JSON.stringify({ ...base, evidence: [{ turn: 9, quote: base.evidence[0]!.quote }] }), input)).toEqual({ ok: false, reason: "no-evidence" });
    expect(parseLesson(JSON.stringify({ ...base, wanted: "下次注意" }), input).ok).toBe(false);
    expect(parseLesson("我认为助手错了", input)).toEqual({ ok: false, reason: "no-json" });
  });
  it("模型编造的仓库路径改回材料给的仓库根", () => {
    const r = parseLesson(JSON.stringify({ ...JSON.parse(GOOD_REVIEW), scope: { repo: "/etc", dir: "../x", taskType: "乱写" } }), input);
    expect(r.ok && r.lesson.scope).toEqual({ repo: REPO, dir: "", taskType: "任意" });
  });
});
