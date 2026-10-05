// tests/s2/conflict-skeleton.test.ts — 冲突判定的"是否同一件事"门槛。
//
// 为什么需要它 (2026-09-18): `hardConflict` 此前**只看"数字不一致 / 极性相反", 没有"是否同一件事"这一环**。
// 而真实记忆里**几乎每条都含数字** (日期/版本/计数/端口) ⇒ 任意两条都被判冲突。
// 实测: 真实库随机成对 **196/204 (96%) 被判冲突, 其中 99% 字面几乎无关** ——
// 症状是"内容各异的记忆互相取代", 旧条目转 shadow ⇒ **默认查不到**。
//
// 标定 (双向):
//   · 真冲突 (程序化: 同内容改数字, n=100): 骨架覆盖率 min **0.966**
//   · 真冲突 (措辞变体): **0.714 / 0.600 / 0.500** ("设为" vs "改为" 会引入不同 bigram)
//   · 假冲突 (真实库相邻成对, n=207): **p99 0.258**
//   ⇒ 阈值取 **0.5** (真冲突召回 100%, 噪声 0.5%, 且措辞变体全过)
import { describe, expect, it } from "vitest";
import { hardConflict, CONFLICT_SKELETON_FLOOR } from "../../src/evolution/evolve.ts";

describe("冲突判定: 必须有'是否同一件事'的证据", () => {
  it("**同主题 + 数字不同** → 冲突 (这是冲突的定义)", () => {
    expect(hardConflict("并发上限 10", "并发上限 50")).toBe(true);
    expect(hardConflict("服务端口配置为 60", "服务端口配置为 90")).toBe(true);
    expect(hardConflict("超时设为 5 秒", "超时设为 30 秒")).toBe(true);
  });

  it("**同主题 + 措辞变体 + 数字不同** → 仍判冲突 (真冲突里最难的一类)", () => {
    // 这些的骨架覆盖率是 0.5~0.71 —— 若阈值取 0.8 会全部被挡掉 (实测过)
    expect(hardConflict("容器并发上限设为 10", "容器并发上限改为 50")).toBe(true);
    expect(hardConflict("缓存过期设置为 60 秒", "缓存过期改成 300 秒")).toBe(true);
    expect(hardConflict("连接池上限 20 个", "连接池最大 50 个")).toBe(true);
  });

  it("**不同主题 + 数字不同** → **不判冲突** (修复的核心: 这是 96% 误判的来源)", () => {
    // 真实库的典型情形: 两条各说各的事, 但都含数字
    expect(hardConflict("第 3 轮的注入时机问题", "发布 v1.2.3 版本")).toBe(false);
    expect(hardConflict("修复链收尾 7/7 通过", "可区分性检验 3 项完成")).toBe(false);
    expect(hardConflict("端口 8080 用于本地服务", "缓存过期 300 秒")).toBe(false);
  });

  it("极性问题 → 冲突, 且**不受骨架门槛影响**", () => {
    // ⚠ 这条是刻意记录的设计决定: 否定词 ("不要"/"别") **本身就是骨架的一部分**,
    // 它会拉低覆盖率, 而它恰恰是极性差异的唯一载体 ⇒ 对极性分支加骨架门控**自相矛盾**。
    // 实测: "缓存要开启过期" vs "缓存不要开启过期" 骨架覆盖率只有 0.714 (<0.8)。
    expect(hardConflict("缓存要开启过期", "缓存不要开启过期")).toBe(true);
    expect(hardConflict("部署前必须跑完整测试", "部署前禁止跑测试")).toBe(true);
  });

  it("无差异 → 不判冲突", () => {
    expect(hardConflict("并发上限 10", "并发上限 10")).toBe(false);
    expect(hardConflict("并发上限 10", "并发上限 10 并且要加锁")).toBe(false);
  });

  it("阈值常量与标定一致 (防止被无意改动)", () => {
    expect(CONFLICT_SKELETON_FLOOR).toBe(0.5);
    // 阈值必须 <= 措辞变体的最低值 (0.5), 否则真冲突会被挡掉
    expect(CONFLICT_SKELETON_FLOOR).toBeLessThanOrEqual(0.5);
  });
});
