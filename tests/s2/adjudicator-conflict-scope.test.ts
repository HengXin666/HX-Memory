// tests/s2/adjudicator-conflict-scope.test.ts — 裁决器的取代必须建立在"真冲突"之上。
//
// 为什么需要它 (2026-09-18): 裁决器的取代条件是"同 kind + **冲突** + 更晚 + 置信度不低"。
// 而"冲突"用的是 `hardConflict` —— 它此前**只看数字差异/极性, 没有"是否同一件事"这一环**,
// 于是**任意两条含数字的记忆**都能满足"冲突" ⇒ 后写入的那条会取代先写入的 (旧条目转 shadow, 默认查不到)。
//
// 修 `hardConflict` (§194) 后, 这个缺陷**自动消失** (两者共用同一判据) ——
// 本文件把这条传导关系钉住: 若将来有人把裁决器的冲突判据换成别的实现, 这些断言会失败。
import { describe, expect, it } from "vitest";
import { heuristicAdjudicator } from "../../src/evolution/adjudicator.ts";

const target = (content: string) => ({
  id: "t1", kind: "fact" as const, content, source: "test", scope: "agent" as const,
  ts: { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" },
  status: "active" as const,
});
const cand = (content: string) => ({
  kind: "fact" as const, content, tags: [], entities: [],
  ts: { validAt: "2026-06-01T00:00:00Z" }, // 候选更晚
});

const adj = heuristicAdjudicator();

describe("裁决器: 取代必须以'真冲突'为前提", () => {
  it("**同主题 + 数字不同** → supersede (候选更晚)", async () => {
    const r = await adj.adjudicate({
      candidate: cand("服务端口配置为 90 用于本地调试"),
      target: target("服务端口配置为 60 用于本地调试"),
    } as never);
    expect(r.verdict).toBe("supersede");
  });

  it("同主题 + 措辞变体 + 数字不同 → 仍 supersede", async () => {
    const r = await adj.adjudicate({
      candidate: cand("容器并发上限改为 50"),
      target: target("容器并发上限设为 10"),
    } as never);
    expect(r.verdict).toBe("supersede");
  });

  it("**不同主题 + 数字不同** → keep-both (**不再误取代**)", async () => {
    // 修复前这类会被判 supersede (因为"数字不同"即算冲突)
    const r = await adj.adjudicate({
      candidate: cand("发布 v1.2.3 版本"),
      target: target("第 3 轮的注入时机问题"),
    } as never);
    expect(r.verdict).toBe("keep-both");
  });

  it("**完全无关** → keep-both", async () => {
    const r = await adj.adjudicate({
      candidate: cand("部署流水线回滚策略"),
      target: target("缓存过期设为 60 秒"),
    } as never);
    expect(r.verdict).toBe("keep-both");
  });

  it("极性相反 → supersede (该判据本身已隐含同主题)", async () => {
    const r = await adj.adjudicate({
      candidate: cand("缓存不要开启过期"),
      target: target("缓存要开启过期"),
    } as never);
    expect(r.verdict).toBe("supersede");
  });

  it("候选更早 → 永不取代 (时间倒退时不取代)", async () => {
    const r = await adj.adjudicate({
      candidate: { ...cand("服务端口配置为 90"), ts: { validAt: "2025-01-01T00:00:00Z" } },
      target: target("服务端口配置为 60"),
    } as never);
    expect(r.verdict).toBe("keep-both");
  });
});
