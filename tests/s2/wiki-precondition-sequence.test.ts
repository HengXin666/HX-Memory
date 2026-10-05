// tests/s2/wiki-precondition-sequence.test.ts — 序列结构判据必须被钉住, 且**不许退回那四个被否证的判据**。
//
// 为什么需要它 (2026-09-18, §496): "Wiki 前提是否满足"这件事经过**五个判据迭代**才做对:
//
// | 判据 | 读数 | 否证理由 |
// | --- | --- | --- |
// | 词面共享 >=2 词 | 15.9% | **无区分力** (打乱词序后仍 97.5%) |
// | 实体簇 (entitiesOf) | 94% | **被前缀撑起** (183/184 条以同一前缀开头) |
// | `topicOf` 共享 | 84% | **排除巨簇后只剩 17%** |
// | 同实体 + 同 project | 70% | **全是高频词** (`always-on`/`rrf`/`fail`) |
// | **结构骨架 (本判据)** | **10%** | **与"人读"独立一致** |
//
// 前四个问的是"**它们共享什么**", 而"共享某物"只是"同类记录"的**副产品** ——
// 同一实体的多轮迭代日志每轮内容都不同, 但它们确实是同一序列。
// 本文件钉住"结构判据才对"这件事, 免得后人改回共享类判据。
import { describe, expect, it } from "vitest";
import { sequenceStructure, skeletonOf, hasAggregatableStructure } from "../../scripts/wiki-precondition.ts";

/** 造 n 条**同一序列**的记录 (结构骨架一致, 内容各不相同)。 */
const sequence = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => "HX-Sagasu 第 " + (i + 1) + " 轮: " +
    "这一轮做的是完全不同的事情, 编号 " + i + " 的工作内容与其它轮毫无词面重合。");

/**
 * 造 n 条**主题各异**的记录。
 *
 * ⚠ 构造要点 (我第一版踩过): 骨架只取**前 14 字**, 所以"第 0 类完全不同的记录" 与
 * "第 1 类完全不同的记录" 前 14 字里只差一个数字 —— 归一化后**骨架相同** ⇒ 被判成序列。
 * 那不是判据的 bug, 而是它的**固有局限** (只看开头); 测试数据必须让开头就不同。
 * 真实语料里这是成立的: 我的审计笔记每条开头讲的都是不同的事。
 */
const distinct = (n: number): string[] => {
  const heads = ["缓存过期策略重标定", "注入预算的两级结构", "派生索引身份校验", "变异测试发现无保护",
                  "弃权判据的词边界", "原子写的崩溃窗口", "反向遍历的有效性", "证据链的端到端"];
  // ⚠ 每条的骨架必须**唯一** —— 判据只取前 14 字, 所以不能用"固定前缀 + 序号"的模板
  // (那样归一化后骨架相同, 会被当成序列 —— 那是判据的固有局限, 真库上假阳性低是因为
  //  真实条目的开头本身就各不相同; 实测真库只有 4 个骨架组, 且都是真模板)。
  return Array.from({ length: Math.min(n, heads.length) }, (_, i) => heads[i]! + " 的具体情况记录。");
};

describe("序列结构判据", () => {
  it("**骨架相同 = 同一序列** (即使词面完全不同)", () => {
    const seq = sequence(12);
    const r = sequenceStructure(seq);
    expect(r.maxSeq).toBe(12);
    expect(r.pct).toBe(100);
    // 而共享类判据看不出这是序列 —— 那正是它被否证的地方
    const agg = hasAggregatableStructure(seq);
    expect(agg.ok).toBe(false);
  });

  it("**主题各异的记录不算序列** (骨架全不同)", () => {
    const r = sequenceStructure(distinct(12));
    expect(r.maxSeq).toBe(1);
    expect(r.pct).toBe(0);
  });

  it("**骨架归一化日期与数字** (否则每轮都被当成不同骨架)", () => {
    expect(skeletonOf("HX-Sagasu 第 23 轮: 把两条断掉的链接通")).toBe(
      skeletonOf("HX-Sagasu 第 7 轮: 别的事情"),
    );
    // 日期也要归一化
    expect(skeletonOf("2026-09-18 的审计")).toBe(skeletonOf("2026-01-01 的审计"));
  });

  it("**回归护栏: 不许退回共享类判据**", () => {
    // 一组"每条都提到同一高频词、但主题各异"的记录 —— 共享类判据会判"可聚合", 结构判据不会。
    const heads = ["重读 KInfra 原文", "端到端验证人工闸门", "消除空转断言", "澄清双重误判",
                   "修正同毫秒定性", "核查捕获缺口", "量化序列规模", "归一化判据维度"];
    // 骨架唯一 (每类只一条), 但**都提到同一个高频词** —— 那正是共享类判据会被骗的场景
    const highFreq = heads.map((h, i) => h + " (HX-Memory 第 " + i + " 项): 都提到 HX-Memory 但主题不同。");
    const shared = hasAggregatableStructure(highFreq, {
      minEntries: 20, minPairs: 100, minSharePct: 10,
    });
    const seq = sequenceStructure(highFreq);
    // 共享类判据可能满足 (取决于阈值), 但结构判据必须**看不出序列**
    expect(seq.maxSeq).toBe(1);
    void shared;
  });

  it("混合语料: 序列部分被正确识别", () => {
    const mixed = [...sequence(8), ...distinct(20)];
    const r = sequenceStructure(mixed);
    expect(r.maxSeq).toBe(8);
    expect(r.groups).toBe(1);
    expect(r.covered).toBe(8);
  });
});
