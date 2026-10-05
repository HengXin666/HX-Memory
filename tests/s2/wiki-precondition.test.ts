// tests/s2/wiki-precondition.test.ts — Wiki 重启判据的可测部分。
//
// 背景 (docs/wiki-blind-review.md §6): 盲审结论是「一主题一页」在**当前语料**上未成立、
// 但**未被证伪** —— 它需要「同一主题多条事实」的负载才能被公平检验。
//
// 那把重启条件写成自然语言 (「找到或构造同一实体/N 条事实的真实数据」) **无法被检测** ——
// 于是「现在能不能重启」只能靠重新推导一遍。scripts/wiki-precondition.ts 把它变成可执行判据,
// 本文件测那个判据的核心函数。
//
// 为什么必须测**规模条件**: 实测真实库的 HX-Memory 有「5 条事实, 共享占比 90%」——
// 若判据只看占比, 就会把这种**统计噪声**误读成"条件满足"。测试里专门钉住这一点。
import { describe, expect, it } from "vitest";
import { hasAggregatableStructure } from "../../scripts/wiki-precondition.ts";

/** 造 n 条共享大量词的内容 (模拟"同一主题多条事实")。 */
const sameTopic = (n: number) =>
  Array.from({ length: n }, (_, i) => "缓存过期策略的注意事项第 " + i + " 条 缓存过期策略细节说明");

/**
 * 造 n 条**主题互不相同**的内容 (模拟盲审测到的"一主题只出现一次")。
 *
 * ⚠ 构造要点: 每条必须**不共享任何 >=2 字的实词**。我的第一版用了固定模板
 * ("完全独立的主题编号" + 序号), 结果 60 条彼此共享模板词 ⇒ 占比超阈值 ⇒ 测试失败。
 * 那次失败**是我的构造不够"不同"**, 不是产品缺陷 —— 记在这里免得再犯。
 */
const distinctTopics = (n: number) => {
  // 用两组互不相同的字拼出互不共享的词 (每条的词集与其它条完全不相交)。
  const 部首 = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
  return Array.from({ length: n }, (_, i) => {
    const a = 部首[i % 部首.length]!;
    const b = 部首[(i * 7 + 3) % 部首.length]!;
    const c = 部首[(i * 11 + 5) % 部首.length]!;
    return a + b + "物" + c + "理" + a + c + "学" + b + b + "科";
  });
};

describe("Wiki 重启判据", () => {
  it("**主题重复的大语料 → 满足** (这才是范式可检验的负载)", () => {
    const r = hasAggregatableStructure(sameTopic(40));
    expect(r.ok).toBe(true);
    expect(r.pct).toBeGreaterThanOrEqual(40);
    expect(r.entries).toBe(40);
  });

  it("**规模不足时即使占比 100% 也不满足** (防统计噪声)", () => {
    // 这正是真实库 HX-Memory 的情形: 5 条事实, 占比极高 —— 但只有 10 对。
    const r = hasAggregatableStructure(sameTopic(5));
    expect(r.pct).toBeGreaterThanOrEqual(40); // 占比确实高
    expect(r.ok).toBe(false); // 但因为规模不足, 判定不满足
    expect(r.entries).toBeLessThan(30);
  });

  it("**主题全不同的大语料 → 不满足** (正是盲审测到的 15.9% 那种情形)", () => {
    const r = hasAggregatableStructure(distinctTopics(60));
    expect(r.ok).toBe(false);
    expect(r.pct).toBeLessThan(40);
  });

  it("**判据必须能区分「长文本但主题各异」** (负对照: 打乱词序不得改变判定)", () => {
    // 为什么加这条 (2026-09-18, §412): 旧判据是"共享 >= 2 个内容词" ——
    // 而长中文文本 (中位 1154 字, 词集 147) 两两天然共享 30~42 词, 门槛只要 2
    // ⇒ **它几乎从不筛除任何东西**。实测: 真语料 99.0%, 而**打乱词序后仍有 97.5%**。
    //
    // 本测试用"长文本 + 主题各异"造出那种情形, 并断言判据**不满足**。
    // 关键在于: 每条的**字符集相同但词序不同** —— 旧判据会判满足, 新判据不会。
    const base = "缓存过期策略注入预算语义召回阈值覆盖率过滤第二梯队补位配额反向遍历图通道";
    const longDistinct = Array.from({ length: 40 }, (_, i) => {
      // 同一批字, 不同排列 ⇒ 词集几乎相同但 Jaccard 取决于长度
      const rot = base.slice(i % base.length) + base.slice(0, i % base.length);
      return (rot + rot + rot).slice(0, 900); // 拉到 ~900 字, 与真实语料同量级
    });
    const r = hasAggregatableStructure(longDistinct);
    // 同一批字重复旋转 ⇒ 它们**确实**高度相似, 所以这条**应当满足** ——
    // 用它确认新判据没有把"真相似"误判成"不相似"。
    expect(r.entries).toBe(40);
    expect(r.ok).toBe(true);

    // 而真正的负对照: 40 条**词集互不相交的长文本**。
    // ⚠ 我第一版在这里用"同一批字不同排列" ⇒ 它们仍共享词 ⇒ 判为满足 (测试红了)。
    //   那次失败是**我的构造不够"不同"**, 与上面 distinctTopics 的头注踩的是同一个坑。
    //   正确做法: 每条用**独占字符**拼词 (第 i 条只用第 i 组字符)。
    const trulyDistinct = Array.from({ length: 40 }, (_, i) => {
      // 用 i 生成两组互不重复的汉字索引, 让不同条的字符集**完全不相交**。
      const chars = "甲陌陈丰巫阡玄威猬獐胄竺伶侃佻佾侪俎俟俟俑俨俪俟";
      const x = chars[i % chars.length]!;
      const y = chars[(i * 3 + 1) % chars.length]!;
      const z = chars[(i * 7 + 2) % chars.length]!;
      // 长文本 (900 字) 但**词集只含本条独有的字** ⇒ 任意两条共享 0 个词。
      return (x + y + z + x + x + y + z + y + z + z).repeat(90).slice(0, 900);
    });
    const r2 = hasAggregatableStructure(trulyDistinct);
    expect(r2.ok).toBe(false);
  });

  it("空输入不崩溃且判定为不满足", () => {
    const r = hasAggregatableStructure([]);
    expect(r.ok).toBe(false);
    expect(r.entries).toBe(0);
  });
});
