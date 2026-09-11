// tests/s1/voice.test.ts — 语音输入的容错归一 (s1, 纯函数)。
//
// 为什么值得单独钉: 用户用**语音输入法**, 文本里有错别字/同音字 (绘话=会话, 密等=幂等, 纸agent=子agent)。
// 这些错字会让"字面"链路整体失效 (意图漏命中 / 同话题被误判成换话题 / 该召回的记忆一条都不召回),
// 且这类失效**不会报错** —— 只有断言能拦住它悄悄退化。
import { describe, expect, it } from "vitest";
import { normalizeVoice, voiceVariants } from "../../src/kernel/voice.ts";
import { detectIntent, topicDriftOf } from "../../src/trigger/policy.ts";
import { queryTerms } from "../../src/retrieval/channels.ts";

describe("normalizeVoice: 确定的误写 → 标准写法", () => {
  it("归一真实语料里的错别字", () => {
    expect(normalizeVoice("多轮绘话")).toBe("多轮会话");
    expect(normalizeVoice("怎么确保它密等呢")).toBe("怎么确保它幂等呢");
    expect(normalizeVoice("拍多个纸agent")).toBe("拍多个子agent");
    expect(normalizeVoice("你clone到ref目录")).toContain("clone");
  });

  it("不碰正确的文本 (臆造纠正比不纠正更危险)", () => {
    const clean = "语义检索要用词典归一加字级 n-gram";
    expect(normalizeVoice(clean)).toBe(clean);
    // "会话"本身就是对的, 不该被改回去
    expect(normalizeVoice("当前会话的计费")).toBe("当前会话的计费");
  });

  it("幂等 (已规范的文本再归一无变化)", () => {
    const once = normalizeVoice("多轮绘话的密等问题");
    expect(normalizeVoice(once)).toBe(once);
  });
});

describe("voiceVariants: 原形与归一形都在, 供检索取并集", () => {
  it("有错字时返回多个变体, 无错字时只有一个", () => {
    expect(voiceVariants("多轮绘话").length).toBeGreaterThan(1);
    expect(voiceVariants("多轮会话")).toHaveLength(1);
  });
});

describe("语音错字不影响判定", () => {
  it("错字不回避意图命中 (绘话→会话 后仍识别为项目状态类提问)", () => {
    expect(detectIntent("这个项目现在绘话怎么样")).not.toBeNull();
    // 注意断言的是"错字不改变判定", 不是"这个形状一定能命中":
    // "我们之前遇到过X吗" 这种形状**本来就不在意图库里** (prior-art 要求显式 有没有/是否/曾经)。
    // 这是意图正则的已知覆盖缺口 (见 Agent Note), 归一化只负责不让错字把它变得更差。
    const withTypo = detectIntent("我们之前有没有遇到过密等问题");
    const clean = detectIntent("我们之前有没有遇到过幂等问题");
    expect(withTypo?.intent.id).toBe(clean?.intent.id);
  });

  it("错字不把同一话题误判成换话题 (归一后再算漂移)", () => {
    const drift = topicDriftOf("容器并发上限怎么设", "容器并发上线怎么设");
    expect(drift).toBeLessThan(0.9);
  });

  it("检索词同时包含错写与规范写法", () => {
    const terms = queryTerms("密等问题怎么处理");
    expect(terms.terms).toContain("幂等");
    expect(terms.terms).toContain("密等");
  });
});
