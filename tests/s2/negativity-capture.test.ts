// tests/s2/negativity-capture.test.ts — 负面/纠正信号接入**捕获链**的端到端契约。
//
// 为什么单独一个文件 (与 s1/negativity.test.ts 分开): 那个测的是判定内核;
// 这里测的是"接入之后用户实际得到什么" —— 而这正是用户实测抱怨的地方:
//   · 骂人 → 旧行为落 27 条**原话**; 新行为落**教训草稿**且 allow 无回答;
//   · 纠正 → 旧行为 10 条丢 8 条; 新行为全部落 lesson;
//   · 纯闲聊/纯指令 → 仍然不许放进库 (放宽入口不能变成"什么都记")。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { compileNegativity, detectNegative, lessonDraftOf } from "../../src/kernel/negativity.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "neg-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const c = compileNegativity();
const negativity = {
  detect: (t: string) => detectNegative(t, c),
  lessonDraft: (s: Parameters<typeof lessonDraftOf>[0], t: string) => lessonDraftOf(s, t, c),
};

/** 走完整 pipeline (含审核闸门与落盘)。 */
async function run(text: string, answer?: string) {
  const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
  const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
  const res = await pipe.run(
    { session: "s", turn: 1, project: "P", text, ...(answer ? { answer } : {}) } as never,
    { negativity } as never,
  );
  const saved = await stack.store.all();
  stack.close();
  return { res, saved };
}

describe("骂人: 落教训草稿, 不落原话", () => {
  it("'你傻逼' **无回答也落盘** (旧代码在这里一条都不留)", async () => {
    const { res, saved } = await run("你傻逼");
    expect(res.entries.length).toBe(1);
    expect(saved.length).toBe(1);
    expect(res.negative, "本轮命中负面信号要回报给账本").toBeDefined();
  });

  it("落的是 lesson 且正文里**没有脏话**", async () => {
    for (const t of ["你傻逼", "操你妈", "你他妈又搞错了, 这已经是第三次了"]) {
      // 每条用**独立 root**: 同一 root 下 store.all() 会累加, 断言会退化成"跑了几轮"的计数。
      const dir = mkdtempSync(join(tmpdir(), "neg-one-"));
      try {
        const stack = openMemoryStack(dir, { episodeRetentionDays: 0, embedder: null });
        const pipe = new CapturePipeline(stack.store, { reviewRoot: dir });
        const res = await pipe.run({ session: "s", turn: 1, project: "P", text: t } as never, {
          negativity,
        } as never);
        const saved = await stack.store.all();
        expect(res.entries.length, t).toBe(1);
        expect(saved[0]!.kind, t).toBe("lesson");
        for (const bad of ["傻逼", "操你", "他妈"]) {
          expect(saved[0]!.content.includes(bad), `${t} -> ${saved[0]!.content}`).toBe(false);
        }
        stack.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("纠正句抽出方向并写进正文 (可执行的教训)", async () => {
    const { saved } = await run("错了！我说的是先跑测试再改代码");
    expect(saved[0]!.kind).toBe("lesson");
    expect(saved[0]!.content).toContain("先跑测试再改代码");
  });

  it("负面轮次**不进审核队列** (它的形状必然误命中 uncited)", async () => {
    const { res } = await run("你傻逼", "x".repeat(400) + " 根因在 cache.ts:42。");
    expect(res.reviewQueued ?? 0).toBe(0);
  });
});

describe("放宽入口不等于什么都记", () => {
  it("纯指令 / 闲聊 / 正常提问仍然不进库", async () => {
    for (const t of ["继续", "嗯", "今天天气不错", "我先看看代码", "这个方案能不能行? 我们试试"]) {
      const { saved } = await run(t);
      expect(saved.length, t).toBe(0);
    }
  });

  it("没配负面词表时行为与接入前一致 (默认关得掉)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
    const res = await pipe.run({ session: "s", turn: 1, text: "你傻逼" } as never);
    expect(res.entries.length).toBe(0); // 不注入判定面 = 旧行为
    expect(res.negative).toBeUndefined();
    stack.close();
  });
});

describe("正向规则不受影响 (不能被新判据吞掉)", () => {
  it("'以后都要先跑测试再改代码' 仍落 pattern 且正文是原话", async () => {
    const { saved } = await run("以后都要先跑测试再改代码");
    expect(saved[0]!.kind).toBe("pattern");
    expect(saved[0]!.content).toBe("以后都要先跑测试再改代码");
  });

  it("显式 '记住: X' 仍是 fact (显式指令优先级最高)", async () => {
    const { saved } = await run("记住: 缓存过期统一设为 60 秒");
    expect(saved[0]!.kind).toBe("fact");
    expect(saved[0]!.content).toContain("缓存过期统一设为 60 秒");
  });
});

describe("落库形态: 是「我以后怎么做」, 不是「用户当时什么情绪」", () => {
  it("真库里那句教训必须是可执行约束 (含'禁止/必须' 且不含'用户')", async () => {
    for (const t of ["你傻逼", "操你妈", "错了！我说的是先跑测试再改代码"]) {
      const dir = mkdtempSync(join(tmpdir(), "neg-form-"));
      try {
        const stack = openMemoryStack(dir, { episodeRetentionDays: 0, embedder: null });
        const pipe = new CapturePipeline(stack.store, { reviewRoot: dir });
        await pipe.run({ session: "s", turn: 1, project: "P", text: t } as never, {
          negativity,
        } as never);
        const saved = await stack.store.all();
        const c = saved[0]!.content;
        expect(/^(禁止|必须)/.test(c), `${t} -> ${c}`).toBe(true);
        expect(c.includes("用户"), `${t} -> ${c}`).toBe(false);
        stack.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("被否决的做法与改法都落进同一句 (刹车 + 方向盘, 缺一不可)", async () => {
    const { saved } = await run("你傻逼");
    expect(saved[0]!.content).toContain("禁止");
    expect(saved[0]!.content).toContain("改为");
  });
});
