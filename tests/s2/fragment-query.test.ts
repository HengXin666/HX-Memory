// tests/s2/fragment-query.test.ts — "代码碎片探针"的判据必须被钉住。
//
// 为什么需要它 (2026-09-18, §454): 基准里 **51% 的"查询"是从条目截取的代码碎片**
// (形如 `ng_model_id),`), 而在它们上算出的指标**系统性低估真实提问上的表现**
// (碎片 R@10 = 0.8221 vs 自然提问 = 0.93)。于是需要把它们标出来单独报告。
//
// **这个判据已经误判过一次** —— 第一版只用"短 + 含拉丁词", 把
// "PostgreSQL 的 autovacuum 什么时候触发" 这类**完整短提问**也判成碎片
// (实测 32 条弃权样本里 **31 条**被误判)。本文件钉住修正后的行为。
//
// ⚠ 判据仍有内在限度: "gRPC 的 deadline 和 timeout 区别" 无问句词但**仍是提问**,
//   会被判成碎片。所以它的用途是**分别报告**, 不是"把误判的算作错" —— 本文件
//   同时钉住这个限度 (免得后人以为它是个精确分类器)。
import { describe, expect, it } from "vitest";
import { isFragmentQuery, uniqueProbe } from "../../bench/lib/cases.ts";

describe("代码碎片探针的判据", () => {
  it("**真碎片被识别** (代码片段, 无问句结构)", () => {
    for (const frag of [
      "generalize)",
      "ng_model_id),",
      "ed,rejected,archived",
      "d+4*0.2)/(exposure+4",
      "Rebuildable/VectorIn",
      "-ai-docs",
      "m628f5dac4967429d",
    ]) {
      expect(isFragmentQuery(frag), frag).toBe(true);
    }
  });

  it("**完整短提问不算碎片** (问句词是直接证据) —— 这是第一版误判的地方", () => {
    for (const whole of [
      "PostgreSQL 的 autovacuum 什么时候触发",
      "Redis 的 AOF 重写怎么调优",
      "gRPC 的 deadline 怎么设",          // 长度 23, 含拉丁词, 但有问句词
      "Kafka 的 ISR 收缩是什么原因",
      "Terraform 的 state 锁怎么释放",
      "为什么 DSH 的设置要重启才生效",
    ]) {
      expect(isFragmentQuery(whole), whole).toBe(false);
    }
  });

  it("**长查询一律不算碎片** (即使无问句词)", () => {
    const long = "前端接口地址变更以后生产环境静默失效, 但回滚会涉及数据库迁移与灰度流量切换";
    expect(long.length).toBeGreaterThan(30);
    expect(isFragmentQuery(long)).toBe(false);
  });

  it("**无拉丁词的中文碎片式短句** —— 保持不判碎片 (保守)", () => {
    // 判据要求"含 >= 3 个连续拉丁字符", 所以纯中文短句不会被判碎片。
    // 那是有意的: 纯中文短句**可能就是提问** ("缓存怎么配"), 贸然判碎片会误伤。
    expect(isFragmentQuery("缓存怎么配")).toBe(false);
    expect(isFragmentQuery("注入预算")).toBe(false);
  });

  it("**已知限度**: 无问句词的短提问会被判成碎片 (用途是分层而非精确分类)", () => {
    // 把这条限度**显式钉住** —— 若有人试图"修"它, 本测试会红, 强迫他先读注释。
    expect(isFragmentQuery("gRPC 的 deadline 和 timeout 区别")).toBe(true);
  });

  it("uniqueProbe 产出的碎片应当被判据识别 (端到端一致性)", () => {
    // 造一个含代码片段的长条目, 让 uniqueProbe 从中取探针
    const text = "前文铺垫足够长以便探针落在后面的片段上。" + "a".repeat(0) +
      "const x = parseConfig(ng_model_id);" + "后续内容继续拉长这个条目以便通过长度门槛。".repeat(3);
    const probe = uniqueProbe(text, "别的条目内容完全不同");
    if (probe) {
      // 探针若含代码标识符, 判据应当把它标为碎片 (除非含问句词)
      const hasLatin = /[A-Za-z_]{3,}/.test(probe);
      if (hasLatin && !/[怎么什么为什么哪吗呢]/.test(probe) && probe.length <= 30) {
        expect(isFragmentQuery(probe)).toBe(true);
      }
    }
  });
});
