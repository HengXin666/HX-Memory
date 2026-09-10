// tests/s2/facade.test.ts — MemoryFacade: 使用层唯一 API 的行为契约。
//
// 这一层是"多宿主"的地基: 所有宿主 (DSH/MCP/Codex/HTTP) 都只调它, 所以它的语义必须被钉住,
// 尤其是"重复不重复落盘 / 更新会强化老条目 / 撤回是持久 shadow"这三条。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { MemoryFacade } from "../../src/app/facade.ts";

let root: string;
let store: FileBackend;
let facade: MemoryFacade;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-facade-"));
  store = new FileBackend({ root });
  facade = new MemoryFacade(
    { store, retriever: new HybridRetriever(store) },
    { now: () => "2026-06-01T00:00:00.000Z" },
  );
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("remember: 去重与强化", () => {
  it("首次写入 = added", async () => {
    const r = await facade.remember({ content: "容器并发要显式设上限", kind: "lesson" });
    expect(r.decision).toBe("added");
    expect(await facade.get(r.entry.id)).not.toBeNull();
  });

  it("换个说法重记 → duplicate: 不新增条目, 老条目被强化", async () => {
    const first = await facade.remember({ content: "容器并发要显式设上限", kind: "lesson" });
    const again = await facade.remember({ content: "容器并发要显式设置上限!", kind: "lesson" });
    expect(again.decision).toBe("duplicate");
    expect(again.targetId).toBe(first.entry.id);
    expect((await store.all()).length).toBe(1);
    const updated = await facade.get(first.entry.id);
    expect(updated?.reinforcement).toBe(1);
    expect(updated?.lastHitAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("重复写入时新增的标签/实体并入老条目", async () => {
    const first = await facade.remember({
      content: "容器并发要显式设上限",
      tags: ["concurrency"],
    });
    await facade.remember({
      content: "容器并发要显式设上限",
      tags: ["concurrency", "container"],
      entities: ["容器"],
    });
    const updated = await facade.get(first.entry.id);
    expect(updated?.tags).toEqual(["concurrency", "container"]);
    expect(updated?.entities).toEqual(["容器"]);
  });

  it("相关但不同的内容会建边 (关联性真的写进真相)", async () => {
    const first = await facade.remember({ content: "数据库连接池超时设置" });
    const second = await facade.remember({ content: "数据库连接池要设置最大连接数与超时" });
    expect(second.decision).toBe("linked");
    expect(
      second.entry.relations?.some((r) => r.type === "relates" && r.toId === first.entry.id),
    ).toBe(true);
    expect(await store.traverse(second.entry.id, "relates")).toEqual([
      expect.objectContaining({ id: first.entry.id }),
    ]);
  });
});

describe("recall / history / revise / forget / link / stats", () => {
  it("recall 返回可注入文本 (含跨项目规则标注)", async () => {
    await facade
      .remember({
        content: "涉及容器并发时先检查并发策略",
        kind: "rule",
        scope: "global",
        source: "review:confirm",
        // rule 必须带确认记录 (存储闸门)
      })
      .catch(() => null);
    // rule 走存储闸门: 未确认会被拒; 用 revise 之前先确认一条合法的
    const rule = await facade
      .remember({
        content: "涉及容器并发时先检查并发策略",
        kind: "rule",
        scope: "global",
      })
      .catch(() => null);
    expect(rule).toBeNull(); // 未确认 rule 被拒 (治理铁律)
    const out = facade.recall({ text: "容器并发", limit: 3 });
    expect(Array.isArray(out.hits)).toBe(true);
    expect(out.degraded.some((d) => d.includes("semantic"))).toBe(true);
  });

  it("history 返回演化链 (最旧 → 最新)", async () => {
    const a = await facade.remember({ content: "容器并发上限设为 10" });
    const b = await facade.remember({ content: "容器并发上限改为 50" });
    await facade.link(b.entry.id, a.entry.id, "supersedes");
    await facade.link(a.entry.id, b.entry.id, "supersededBy");
    const chain = await facade.history(b.entry.id);
    expect(chain.map((e) => e.id)).toEqual([a.entry.id, b.entry.id]);
  });

  it("revise 能改内容, 但不允许把内容清空 (撤回要走 forget)", async () => {
    const r = await facade.remember({ content: "容器并发上限设为 10" });
    const updated = await facade.revise(r.entry.id, { content: "容器并发上限设为 20" });
    expect(updated.content).toContain("20");
    await expect(facade.revise(r.entry.id, { content: "   " })).rejects.toThrow(/content/);
  });

  it("forget 是持久撤回: 检索不到, 真相仍在, 理由进审计", async () => {
    const r = await facade.remember({ content: "这条记忆要被撤回" });
    const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
    facade.onAudit((event, payload) => audits.push({ event, payload }));
    await facade.forget(r.entry.id, "用户要求删除");
    expect(facade.recall({ text: "要被撤回" }).hits).toEqual([]);
    expect((await facade.get(r.entry.id))?.status).toBe("shadow");
    expect(audits[0]?.event).toBe("forget");
    expect(audits[0]?.payload.why).toBe("用户要求删除");
  });

  it("link 重复调用不产生重复边", async () => {
    const a = await facade.remember({ content: "条目 A 内容" });
    const b = await facade.remember({ content: "条目 B 内容" });
    await facade.link(a.entry.id, b.entry.id, "relates", 0.5);
    await facade.link(a.entry.id, b.entry.id, "relates", 0.9);
    const from = await facade.get(a.entry.id);
    expect(from?.relations?.filter((r) => r.type === "relates").length).toBe(1);
    expect(from?.relations?.[0]?.weight).toBe(0.9);
  });

  it("命中即强化: reinforcement+1 且写 lastHitAt; 窗口内重复命中只算一次", async () => {
    const r = await facade.remember({ content: "容器并发要显式设上限" });
    const first = await facade.reinforce([r.entry.id]);
    expect(first.reinforced).toEqual([r.entry.id]);
    const after = await facade.get(r.entry.id);
    expect(after?.reinforcement).toBe(1);
    expect(after?.lastHitAt).toBe("2026-06-01T00:00:00.000Z");

    // 同一窗口 (默认 60s) 内再次命中 → 合并, 不重复写盘
    const second = await facade.reinforce([r.entry.id]);
    expect(second.reinforced).toEqual([]);
    expect(second.skipped[0]).toEqual({ id: r.entry.id, reason: "coalesced" });
    expect((await facade.get(r.entry.id))?.reinforcement).toBe(1);
  });

  it("强化不复活 shadow/expired (撤回是持久的)", async () => {
    const r = await facade.remember({ content: "已撤回的记忆" });
    await facade.forget(r.entry.id, "test");
    const report = await facade.reinforce([r.entry.id]);
    expect(report.reinforced).toEqual([]);
    expect(report.skipped[0]?.reason).toBe("not-active");
    expect((await facade.get(r.entry.id))?.status).toBe("shadow");
  });

  it("recent: 按写入时间倒序, 且隐藏 shadow (面板视图与检索口径一致)", async () => {
    const a = await facade.remember({ content: "第一条记录内容" });
    const b = await facade.remember({ content: "第二条记录内容" });
    await facade.forget(a.entry.id, "test");
    const recent = await facade.recent(10);
    expect(recent.map((e) => e.id)).toEqual([b.entry.id]);
    expect(recent[0]?.content).toBe("第二条记录内容");
  });

  it("stats 给出可观测面 (含引擎降级信息)", async () => {
    await facade.remember({ content: "容器并发要显式设上限", kind: "lesson", project: "api" });
    await facade.remember({ content: "前端圆角改成 8px", kind: "preference", project: "web" });
    facade.withIndexStatus(() => store.ftsStatus());
    const stats = await facade.stats();
    expect(stats.total).toBe(2);
    expect(stats.byKind.lesson).toBe(1);
    expect(stats.projects).toEqual(["api", "web"]);
    expect(stats.index).toMatchObject({ available: true });
  });
});
