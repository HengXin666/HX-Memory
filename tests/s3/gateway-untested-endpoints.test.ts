// tests/s3/gateway-untested-endpoints.test.ts — 那 5 个**从未被调用过**的 RPC 端点。
//
// 为什么需要它 (2026-09-18, §647 全库实测): 从 602 个真实会话里统计 RPC 调用,
// **5 个端点的调用计数为 0** —— `captureReviewQueue` / `deleteEntry` / `recentCaptures` /
// `rejectProposal` / `resolveCaptureReview`。它们有面板入口 (不是没接线), 而是**功能从没被点过**。
//
// 而测试侧也覆盖不到: `tests/s3/gateway.test.ts` 的头注写明"**不实例化 cordis Context (太重)**,
// 真正的 RPC 桥接由 DSH host 提供" ⇒ gateway 类 (带 `@Remote` 装饰器) **在测试与真机 smoke 里
// 都不被实例化** (smoke 只验"插件装得上、宿主能起")。
//
// ⇒ 于是那 5 条路径**从未被执行过**。其中 `deleteEntry` 有**真实分支逻辑**
// (`facade` 在则走 `forget` 撤回; 否则走 `store.remove` 直删) —— 两条分支各自正确,
// 但**"该走哪条"没有测试**。
//
// 手法沿用 `tests/s3/dsh-adapter.test.ts` 已验证的 `Object.create(HxMemoryGateway.prototype)`:
// 绕开装饰器与 cordis Context, 只测**方法体** (那才是这里要守的东西)。
import { describe, expect, it } from "vitest";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";

/** 造一个只填了必要依赖的 gateway 实例 (不跑构造器 ⇒ 不需要 cordis Context)。 */
function gatewayWith(deps: Record<string, unknown>): Record<string, (...a: unknown[]) => unknown> {
  const gw = Object.create(HxMemoryGateway.prototype) as Record<string, unknown>;
  gw.deps = deps;
  return gw as Record<string, (...a: unknown[]) => unknown>;
}

describe("未被调用过的 RPC 端点 (方法体契约)", () => {
  it("**deleteEntry 走 facade 时是撤回 (shadow + 审计理由), 不是物理删除**", async () => {
    const calls: Array<[string, unknown]> = [];
    const gw = gatewayWith({
      facade: {
        forget: async (id: string, why: string) => { calls.push([id, why]); },
      },
      store: { remove: (id: string) => { calls.push(["store.remove", id]); } },
    });
    const out = (await gw.deleteEntry!("m1")) as { ok: boolean };
    expect(out.ok).toBe(true);
    // ⚠ 关键: 有 facade 时**不该**碰 store.remove (那才是物理删除的路)。
    expect(calls).toEqual([["m1", "panel:deleteEntry"]]);
  });

  it("**deleteEntry 无 facade 时退回 store.remove** (降级路径也要正确)", async () => {
    const calls: string[] = [];
    const gw = gatewayWith({ store: { remove: (id: string) => { calls.push(id); } } });
    const out = (await gw.deleteEntry!("m2")) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(calls).toEqual(["m2"]);
  });

  it("deleteEntry 抛错时返回 ok:false 与错误文本 (而不是把异常抛给面板)", async () => {
    const gw = gatewayWith({
      facade: { forget: async () => { throw new Error("boom"); } },
    });
    const out = (await gw.deleteEntry!("m3")) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("boom");
  });

  it("**recentCaptures 有 facade 时走 facade.recent** (默认 limit 20)", async () => {
    const seen: number[] = [];
    const gw = gatewayWith({
      facade: { recent: async (n: number) => { seen.push(n); return []; } },
    });
    await gw.recentCaptures!();
    await gw.recentCaptures!(7);
    expect(seen).toEqual([20, 7]);
  });

  it("**recentCaptures 无 facade 时退回 store.recent → query 排序** (降级路径)", async () => {
    const viaRecent: unknown[] = [];
    const gw1 = gatewayWith({
      store: { recent: (n: number) => { viaRecent.push(n); return []; } },
    });
    await gw1.recentCaptures!();
    expect(viaRecent).toEqual([20]);

    // 连 recent 都没有 (端口上是可选的) ⇒ 必须退回 query 并自行按 assertedAt 倒序。
    const gw2 = gatewayWith({
      store: {
        query: () => [
          { id: "old", kind: "note", content: "o", scope: "project", tags: [], ts: { assertedAt: "2026-01-01" } },
          { id: "new", kind: "note", content: "n", scope: "project", tags: [], ts: { assertedAt: "2026-09-01" } },
        ],
      },
    });
    const out = (await gw2.recentCaptures!()) as Array<{ id: string }>;
    expect(out.map((e) => e.id)).toEqual(["new", "old"]);
  });

  it("**captureReviewQueue 是薄委托**: 转发给 captureReview.recent(limit)", () => {
    const seen: number[] = [];
    const gw = gatewayWith({
      captureReview: { recent: (n: number) => { seen.push(n); return [{ id: "c1" }]; } },
    });
    const out = gw.captureReviewQueue!(30) as { available: boolean; items: Array<{ id: string }> };
    expect(out.available).toBe(true);
    expect(out.items[0]?.id).toBe("c1");
    expect(seen).toEqual([30]);
  });

  it("**captureReviewQueue 无依赖时明确 available:false** (而不是无声空白)", () => {
    const gw = gatewayWith({});
    const out = gw.captureReviewQueue!(10) as { available: boolean; items: unknown[] };
    expect(out.available).toBe(false);
    expect(out.items).toHaveLength(0);
  });

  it("**rejectProposal 是薄委托**: 转发给 generalizer.reject", async () => {
    const seen: string[] = [];
    const gw = gatewayWith({ generalizer: { reject: (id: string) => { seen.push(id); return { ok: true }; } } });
    const out = (await gw.rejectProposal!("p1")) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(seen).toEqual(["p1"]);
  });

  // ---- §753 补的两项: 精算后**真的零覆盖**只剩这两个 (其余 21 个在 tests/ 或 smoke 里都有) ----

  it("**currentProject: 无 currentProject 依赖时返回空串** (面板不该崩, 也不该编造项目)", () => {
    const gw = gatewayWith({});
    expect(gw.currentProject!()).toEqual({ project: "" });
    const gw2 = gatewayWith({ currentProject: () => "HX-Memory" });
    expect(gw2.currentProject!()).toEqual({ project: "HX-Memory" });
  });

  it("**listInvocations: 无 invocations 依赖时返回空数组** (那是唯一一处可选依赖降级)", () => {
    const gw = gatewayWith({});
    expect(gw.listInvocations!()).toEqual([]);
    const seen: number[] = [];
    const gw2 = gatewayWith({
      invocations: { recent: (n: number) => { seen.push(n); return [{ id: "x" }]; } },
    });
    expect(gw2.listInvocations!()).toEqual([{ id: "x" }]);
    // 默认 50; 显式传值要透传 (不吞参数)。
    expect(seen).toEqual([50]);
    gw2.listInvocations!(7);
    expect(seen).toEqual([50, 7]);
  });
});
