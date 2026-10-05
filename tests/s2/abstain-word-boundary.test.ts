// tests/s2/abstain-word-boundary.test.ts — 弃权判据必须用**词边界**, 且通用词表要够。
//
// 为什么需要它 (2026-09-18, §430): 弃权判据问的是"查询里的拉丁专名在这个库里存在吗"。
// 它此前用**朴素 includes**, 于是:
//   · `ada` 在库里子串命中 **44** 次 (而词边界只 **4** 次) —— 差额全是 `loaded`/`decade` 这类词的片段;
//   · `cycle` (3→**0**) 与 `variant` (1→**0**) 更极端: 朴素口径下"库里有这个词"完全成立。
// 后果: 查询 "Ada 的 tasking 怎么做并发" / "VHDL 的 delta cycle 是什么" **永不弃权**。
//
// 第二个缺陷是**通用词表太窄**: `rate`/`delta`/`record`/`state`/`lock`/`function` 这类
// **通用计算机词汇**不在表里, 而它们在本库的出现次数与 `memory`(287) 同性质地常见。
// 后果: "Grafana 的 PromQL rate 函数怎么用" 里 grafana/promql **都零出现**, 却因命中条目里
// 恰好有个 "rate" 而不弃权。
//
// 实测修复效果 (32 条有效弃权样本): **0.813 → 0.969**; 而 R@1/R@10 **完全不变**
// (同库 A/B: 启用与禁用闸门的 R@1 都是 0.7064)。
import { describe, expect, it } from "vitest";
import { shouldAbstain, properNouns } from "../../src/retrieval/gate.ts";
import type { RetrievalHit } from "../../src/kernel/ports.ts";

const hit = (content: string, channels: string[] = ["bm25"]) =>
  ({ entry: { id: "x", content }, score: 1, channels, why: "t" }) as unknown as RetrievalHit;

describe("弃权判据: 词边界与通用词表", () => {
  it("**子串不算命中**: ada 不该命中 adapter / readability", () => {
    // ⚠ 我第一版这里写的是 "the config was loaded from disk" —— **那是个错的词例**:
    //   "loaded" 里根本没有 "ada" 子串 (它是 loa-ded), 于是那条测试在朴素 includes 下也通过,
    //   完全没起到反驳作用 (反驳测试暴露的)。
    //   实测真实库: `ada` 的子串命中来自 **adapter(55) / adapters / readability / threadAdapter**
    //   —— 这里用真实形态。
    expect(shouldAbstain([hit("统一适配器层: threadAdapter 与 adapter 的职责划分")], ["ada"])).toBe(true);
    expect(shouldAbstain([hit("readability_extract 的可读性评分")], ["ada"])).toBe(true);
  });

  it("**词边界命中才算**: ada 真作为独立词出现时不弃权", () => {
    expect(shouldAbstain([hit("we chose ada for the tasking model")], ["ada"])).toBe(false);
  });

  it("**通用词不进专名候选** (否则所有查询都不弃权)", () => {
    const p = properNouns(["rate", "delta", "record", "state", "lock", "function", "grafana", "promql"]);
    expect(p).toEqual(["grafana", "promql"]); // 前 6 个是通用词
  });

  it("**专名全不在库中就弃权** (这是判据的本职)", () => {
    expect(shouldAbstain([hit("记忆注入的预算分配与覆盖率过滤")], ["grafana", "promql"])).toBe(true);
  });

  it("**纯中文查询不做此判定** (中文专名无法用子串可靠判断)", () => {
    expect(shouldAbstain([hit("任意内容")], ["缓存", "过期"])).toBe(false);
  });

  it("rules 通道不参与判定 (保底规则不该让闸门清空结果)", () => {
    expect(shouldAbstain([hit("跨项目规则", ["rules"])], ["grafana"])).toBe(false);
  });

  it("vector / entity 通道的存在即视为有支持 (语义相关不该被弃权)", () => {
    expect(shouldAbstain([hit("任意", ["vector"])], ["grafana"])).toBe(false);
    expect(shouldAbstain([hit("任意", ["entity"])], ["grafana"])).toBe(false);
  });
});
