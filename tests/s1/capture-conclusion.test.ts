// tests/s1/capture-conclusion.test.ts — S1: 结论闸门 (记忆层从"转录"改"提炼")。
//
// 背景 (2026-09 实测): 旧路径下 79 条记忆里 12 条 (15%) 是用户问句本身, 助手侧一条都没进。
// 根因: 捕获单元是"用户那一句", 助手输出被显式排除 → 抽取器看着问题猜答案。
// 本文件钉住修复后的语义。
import { describe, expect, it } from "vitest";
import {
  captureTurn,
  hasConclusionSignal,
  isInterrogative,
} from "../../src/capture/engine.ts";

const base = { session: "s1" };

describe("isInterrogative: 只判形态", () => {
  it("问号结尾算问句", () => {
    expect(isInterrogative("这个要怎么改?")).toBe(true);
    expect(isInterrogative("这个要怎么改？")).toBe(true);
  });
  it("疑问语气词收尾算问句", () => {
    expect(isInterrogative("这样能行吗")).toBe(true);
    expect(isInterrogative("我们是不是该换一个方案呢")).toBe(true);
  });
  it("陈述句不算问句", () => {
    expect(isInterrogative("决定采用 pnpm 作为包管理器")).toBe(false);
    expect(isInterrogative("踩坑: 并发要加锁")).toBe(false);
  });
});

describe("hasConclusionSignal: 落地/采纳信号", () => {
  it("识别采纳与确认", () => {
    expect(hasConclusionSignal("那就用你这个方案吧, 采用")).toBe(true);
    expect(hasConclusionSignal("好的")).toBe(true);
    expect(hasConclusionSignal("就这样")).toBe(true);
  });
  it("识别落地", () => {
    expect(hasConclusionSignal("已经修好了")).toBe(true);
    expect(hasConclusionSignal("跑通了")).toBe(true);
  });
  it("纯提问没有结论信号", () => {
    expect(hasConclusionSignal("这个要怎么改?")).toBe(false);
  });

  it("确认词必须成词: 问候语里的\"好\"不算确认 (真实误判)", () => {
    // 实测: 宽松的 /好的?/ 会命中 "你好," 里的 "好,", 让闲聊变成一条 decision。
    expect(hasConclusionSignal("你好, 今天天气不错")).toBe(false);
    expect(hasConclusionSignal("好像不太对")).toBe(false);
    // 成词出现才算
    expect(hasConclusionSignal("好, 就这么办")).toBe(true);
  });
});

describe("captureTurn: 结论闸门", () => {
  it("只有问句、没有回答 → 不落盘 (这是旧行为的主要噪声源)", () => {
    const r = captureTurn({ ...base, text: "你觉得这个方案可以吗？" });
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toBe("no-conclusion:question");
  });

  it("问句 + 助手回答 → 放行 (用户要的是疑问之后的结果)", () => {
    const r = captureTurn({
      ...base,
      text: "你觉得这个方案可以吗？",
      answer: "可以, 但需要先补一个回归测试。",
    });
    expect(r.entries).toHaveLength(1);
  });

  it("问句 + 用户自己敲定 → 放行 (自问自答也是结论)", () => {
    const r = captureTurn({ ...base, text: "那就用 A 吧？可以。" });
    expect(r.entries).toHaveLength(1);
  });

  it("陈述句不受闸门影响", () => {
    const r = captureTurn({ ...base, text: "踩坑: 容器并发要显式设上限" });
    expect(r.entries).toHaveLength(1);
  });

  it('显式"记住 X" 永远放行, 即使是问句', () => {
    const r = captureTurn({ ...base, text: "记住: 以后问句要先看有没有结论" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("fact");
  });
});

describe("captureTurn: 血缘支持一轮两条 episode", () => {
  it("episodeIds 全量写进 derivedFrom (用户问 + 助手答)", () => {
    const r = captureTurn({
      ...base,
      text: "踩坑记录",
      answer: "补充说明",
      episodeIds: ["ep-user", "ep-assistant"],
    });
    expect(r.entries[0]!.derivedFrom).toEqual(["ep-user", "ep-assistant"]);
  });
});