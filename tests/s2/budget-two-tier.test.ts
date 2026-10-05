// tests/s2/budget-two-tier.test.ts — 预算必须对**全部返回条目**生效 (含第二梯队补位)。
//
// 为什么需要它 (2026-09-18 实测): `assembleHits` 里 `extras` (图扩展/实体反查的"第二梯队")
// 在预算裁剪**之后**追加, 且**只检查条数上限与通道配额, 不检查 token** ⇒ 预算对它完全失效。
//
// 症状 (真实库, tokenBudget=100): 返回 6 条**全部来自 graph/entity**, 单条最大 1400 token
// (总预算的 14 倍); 而预算内的 primary **一条都没进** ⇒ 注入路径整体超支 5.8 倍 (实测 4994 vs 700)。
//
// 修法: extras 只在**预算还有余量**时追加。这与"图/实体必须能被召回"的既有契约**不冲突** ——
// 契约场景不传 tokenBudget (走默认 1200, 余量充足); 而"预算紧张时优先主榜单"是预算机制的应有之义。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠ 临时目录必须登记并在 afterEach 里删除。
 *
 * 为什么 (2026-09-18): 本文件第一版用 `"/tmp/budget-two-tier-" + Math.random()` 做根,
 * **从不删除** —— 每次跑测试泄漏 3 个目录 (实测确认)。这是**我引入的缺陷**, 不是历史遗留。
 * 它属于"验证脚手架污染环境"那一类 (与 §307 的库内残留 / §310 的 106MB 泄漏同源)。
 */
const tmpRoots: string[] = [];
const newRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hxmem-budget-two-tier-"));
  tmpRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { estimateTokens } from "../../src/kernel/ranking.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const mk = (id: string, content: string, relations: MemoryEntry["relations"] = []) =>
  ({ id, kind: "lesson", content, source: "t", scope: "agent", ts: T, relations } as MemoryEntry);

/** 长正文的"补位候选" —— 模仿真实库里的长条目。 */
function longBody(n: number) {
  return ("这是一条很长的记忆正文用于测试预算约束 " + "内容填充".repeat(n));
}

describe("预算对第二梯队补位同样生效", () => {
  it("**预算紧张时不追加超预算的 extras**", () => {
    const store = new FileBackend({ root: newRoot() });
    const seed = mk("seed", "容器并发策略缺失");
    // 造 6 条长正文邻居 (graph 通道的候选)
    const neighbors = Array.from({ length: 6 }, (_, i) => mk("n" + i, longBody(80) + i));
    for (const e of [seed, ...neighbors]) store.add(e);
    // seed 指向所有邻居 (图边)
    store.update("seed", { relations: neighbors.map((n) => ({ type: "relates" as const, toId: n.id, weight: 0.9 })) });

    const r = new HybridRetriever(store, { now: () => T.validAt });
    const out = r.retrieveSync({ text: "容器并发策略", limit: 6, tokenBudget: 100 });
    const used = out.hits.reduce((n, h) => n + estimateTokens(h.entry.content) + 8, 0);
    // 关键: 实际用量不得超出预算 (此前会返回 6 条数千 token)
    expect(used).toBeLessThanOrEqual(100);
    store.close();
  });

  it("**预算充足时 extras 仍能补位** (既有契约能力不削弱)", () => {
    const store = new FileBackend({ root: newRoot() });
    const seed = mk("seed", "容器并发策略缺失");
    const neighbor = mk("neighbor", "部署流水线上的其它注意点");
    store.add(seed);
    store.add(neighbor);
    store.update("seed", { relations: [{ type: "relates", toId: "neighbor", weight: 0.9 }] });

    const r = new HybridRetriever(store, { now: () => T.validAt });
    // 不传 tokenBudget → 默认 1200, 余量充足
    const out = r.retrieveSync({ text: "容器并发策略", limit: 5 });
    const hit = out.hits.find((h) => h.entry.id === "neighbor");
    expect(hit?.channels).toContain("graph");
    store.close();
  });

  it("被预算挡掉的 extras 出现在 dropped 里 (可观测)", () => {
    const store = new FileBackend({ root: newRoot() });
    const seed = mk("seed", "容器并发策略缺失");
    const neighbors = Array.from({ length: 4 }, (_, i) => mk("m" + i, longBody(60) + i));
    for (const e of [seed, ...neighbors]) store.add(e);
    store.update("seed", { relations: neighbors.map((n) => ({ type: "relates" as const, toId: n.id, weight: 0.9 })) });

    const r = new HybridRetriever(store, { now: () => T.validAt });
    const out = r.retrieveSync({ text: "容器并发策略", limit: 4, tokenBudget: 60 });
    // 被挡掉的应能在 dropped 里找到 (reason=budget)
    expect(out.dropped.some((d) => d.reason === "budget")).toBe(true);
    store.close();
  });
});
