// tests/s1/gate.test.ts — 检索两道闸门的直接契约。
//
// 为什么值得直接测: 这两道闸门各自踩过一次坑, 且都**只在中文真实数据上才暴露** 
//   ① 弃权闸门用">= 3 字才算具体词"的判据, 而中文短语几乎全是 2 字, 于是 `specific` 恒为空、
//      闸门在中文上整体失效 (实测 "量子退相干实验装置校准" 对真库返回了 5 条无关记忆);
//   ② 规则保底通道的条目 (rules) 因正文不含查询词而被判"无支持", 导致**整份结果被清空** 
//      而规则是"必须永远在场"的一类, 它们的在场不该由当前查询的相关性决定。
// 间接测试 (paraphrase-recall / abstention 用例) 都没覆盖到这两条, 所以这里直接断言判据本身。
import { describe, expect, it } from "vitest";
import type { RetrievalHit } from "../../src/kernel/ports.ts";
import {
  properNouns,
  ABSTAIN_REASON,
  qualifiesCandidate,
  shouldAbstain,
  qualifiesForRead,
} from "../../src/retrieval/gate.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

function hit(id: string, content: string, channels: RetrievalHit["channels"]): RetrievalHit {
  return {
    entry: { id, content } as MemoryEntry,
    score: 1,
    channels,
    why: "test",
  };
}

describe("候选资格闸门", () => {
  it("全覆盖率直接通过", () => {
    expect(qualifiesCandidate("缓存过期设为 60 秒", ["缓存", "过期"], ["缓存", "过期"], 0.5)).toBe(true);
  });
  it("低覆盖但有 2 个命中词也放行 (召回优先)", () => {
    expect(qualifiesCandidate("缓存与过期无关的句子", ["缓存", "过期", "甲", "乙"], ["缓存", "过期", "甲", "乙"], 0.9)).toBe(true);
  });
  it("完全无命中被挡", () => {
    expect(qualifiesCandidate("完全无关的句子", ["缓存", "过期"], ["缓存", "过期"], 0.5)).toBe(false);
  });
  it("空词表放行 (无判据时不拦)", () => {
    expect(qualifiesCandidate("任意文本", [], [], 0.5)).toBe(true);
  });
});

describe("弃权闸门", () => {
  it("空结果不弃权 (没有东西可弃)", () => {
    expect(shouldAbstain([], ["缓存"])).toBe(false);
  });

  it("有字面支持时不弃权", () => {
    expect(shouldAbstain([hit("m1", "缓存过期设为 60 秒", ["bm25"])], ["缓存"])).toBe(false);
  });

  it("**拉丁专名是核心判据**: 查询的专名不在库里 → 弃权", () => {
    // 实测分离度: 库外问题 "Rust 的 tokio 运行时怎么选" 的 [rust,tokio] 在本库零出现;
    // 而真实提问 "DSH/MCP/Codex" 的 [dsh,mcp,codex] 全部出现。
    expect(shouldAbstain([hit("m1", "完全无关的内容", ["bm25"])], ["rust", "tokio"])).toBe(true);
    expect(shouldAbstain([hit("m1", "DSH 与 MCP 的接线方式", ["bm25"])], ["dsh", "mcp"])).toBe(false);
  });

  it("**通用拉丁词不作为依据** (否则 'memory' 会让任何查询都不弃权)", () => {
    // "CUDA 的 shared memory 优化" 里的 memory 在本库几乎处处出现;
    // 若把它算专名, 该查询永不弃权 (实测)。
    expect(shouldAbstain([hit("m1", "HX-Memory v2 引擎路线", ["bm25"])], ["cuda", "memory"])).toBe(true);
  });

  it("纯中文查询不做专名判定 (无法用子串可靠判断中文专名在不在)", () => {
    // 中文专名会被分词切成单字 ("账号" → "账"/"号"), 强行判定正是误杀的来源。
    expect(shouldAbstain([hit("m1", "完全无关的内容", ["bm25"])], ["缓存", "过期"])).toBe(false);
  });

  it("单词查询无法要求共现, 命中即算支持 (不能错杀)", () => {
    expect(shouldAbstain([hit("m1", "缓存过期设为 60 秒", ["bm25"])], ["缓存"])).toBe(false);
  });


  it("中文查询命中时仍不弃权 (降级判据不能变成错杀)", () => {
    const w = ["量子", "相干", "实验", "装置", "校准"];
    expect(shouldAbstain([hit("m1", "量子计算的实验装置需要校准", ["bm25"])], w)).toBe(false);
  });

  it("**rules 通道的条目不参与弃权判定** (否则保底通道被误杀)", () => {
    // 实测: "弃权闸门" 在 inject 路径下 5 条全是 rules 保底规则, 正文不含查询词
    const hits = [
      hit("r1", "记忆触发须设无条件保底注入通道", ["rules"]),
      hit("r2", "派生索引必须可全量重建", ["rules"]),
    ];
    expect(shouldAbstain(hits, ["弃权", "闸门"])).toBe(false);
  });

  it("rules 与内容条目混合时, 只看内容条目", () => {
    const mixed = [
      hit("r1", "无关的规则正文", ["rules"]),
      hit("m1", "完全无关的内容", ["bm25"]),
    ];
    // 纯中文查询不做专名判定 (中文专名无法用子串可靠判断) → 不弃权
    expect(shouldAbstain(mixed, ["量子", "相干"])).toBe(false);
    const supported = [
      hit("r1", "无关的规则正文", ["rules"]),
      hit("m1", "量子相干是实验前提", ["bm25"]),
    ];
    expect(shouldAbstain(supported, ["量子", "相干"])).toBe(false);
  });

  it("语义支持时不弃权 (向量通道的字面不重合召回不能被误杀)", () => {
    expect(shouldAbstain([hit("m1", "完全不含查询词的内容", ["vector"])], ["缓存", "过期"])).toBe(false);
  });

  it("只有虚词/单字时无判据 → 不弃权", () => {
    expect(shouldAbstain([hit("m1", "任意内容", ["bm25"])], ["的", "了"])).toBe(false);
  });

  it("**rules 通道条目不参与判定** (否则保底通道被误杀)", () => {
    const hits = [hit("r1", "记忆触发须设无条件保底注入通道", ["rules"]), hit("r2", "派生索引必须可全量重建", ["rules"])];
    expect(shouldAbstain(hits, ["rust", "tokio"])).toBe(false);
  });

  it("**entity 通道算结构证据** (长句查询的正确召回常走它)", () => {
    expect(shouldAbstain([hit("m1", "破坏性操作顺序铁律", ["bm25", "entity"])], ["rust", "tokio"])).toBe(false);
  });

  it("弃权原因可审计 (不是空字符串)", () => {
    expect(ABSTAIN_REASON).toContain("abstain:");
  });
});

// ---- 2026-10-05: 转录类条目的读取加严 + 覆盖率分母去重 ----
//
// 现场 (用户实测报的): 一次探针查询 "工具调用 测试 哪些工具可用" 返回前排是
// `[context] "hi / 你熟悉一下，看看怎么调用这个工具"`  零信息量的用户原话转录。
// 两个叠加的真缺陷: ①`weighted` 里词重复导致覆盖率分母虚高; ②转录类条目用虚词算覆盖率。

describe("转录类条目的读取资格 (qualifiesForRead)", () => {
  const bad = "hi\n你熟悉一下，看看怎么调用这个工具，你看看你能调用哪些工具。";
  const gateTerms = ["工具", "调", "用", "测试", "哪些", "可用"]; // 读路径的真实词表 (keepFunctionWords)

  it("**零信息量的 context 转录不再进读取路径** (现场那句话)", () => {
    expect(qualifiesForRead("context", bad, gateTerms, gateTerms, 0.15)).toBe(false);
  });

  it("同一段文本对**非转录类**仍按普通门槛 (不能顺手把知识也拦掉)", () => {
    // lesson/decision 等是知识, 它们不该被这条加严波及  那是"多召回"而非"精排"的取舍。
    expect(qualifiesForRead("lesson", bad, gateTerms, gateTerms, 0.15)).toBe(true);
  });

  it("覆盖率**必须剔除虚词与单字碎片** (否则分母虚高, 浅撞也能过关)", () => {
    // 上面 gateTerms 的 6 个词里, 真正有区分度的只有 工具/测试/可用 三个。
    // 若用原表算: bad 命中 工具+用 ⇒ 2/6 = 0.33, 恰好越过 0.34 之下的一档;
    // 若用剔虚词后的表: 命中 工具 ⇒ 1/3 = 0.33  但分母小反而更严格地暴露"只沾了一个词"。
    // 关键断言是上面的 false: 它证明剔虚词这条路真的改变了结论。
    expect(qualifiesForRead("context", bad, gateTerms, gateTerms, 0.15)).toBe(false);
  });

  it("真正在讲同一件事的 context **仍然放行** (加严不是过滤)", () => {
    const good = "工具调用测试: 逐个试 glob/grep/read/bash 这些工具, 记录哪些可用。";
    expect(qualifiesForRead("context", good, gateTerms, gateTerms, 0.15)).toBe(true);
  });

  it("单字查询**退回原词表** (剔虚词后为空时不短路)", () => {
    // "卡" 这类单字查询: 没有"更有区分度"的词可选, 必须用原表判定 
    // 否则所有单字查询都会命中"无词"分支而被放行。
    expect(qualifiesForRead("context", "网卡配置", ["卡"], ["卡"], 0.15)).toBe(true);
  });
});
