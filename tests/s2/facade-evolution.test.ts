// tests/s2/facade-evolution.test.ts — 写入期演化的端到端契约 (取代 / 冲突 / 结构关联 / 规则豁免)。
//
// 这是"记忆会自己更新"这句话的凭据: 显式更新写演化链 (旧版本淡出但不删),
// 矛盾只标记待人裁决, 规则永不被机器改。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { MemoryFacade } from "../../src/app/facade.ts";
import type { Embedder } from "../../src/kernel/ports.ts";

let root: string;
let store: FileBackend;
let facade: MemoryFacade;

const mk = (opts: ConstructorParameters<typeof MemoryFacade>[1] = {}) =>
  new MemoryFacade(
    { store, retriever: new HybridRetriever(store) },
    { now: () => "2026-06-01T00:00:00.000Z", ...opts },
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-evolve-"));
  store = new FileBackend({ root });
  facade = mk();
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("自动取代 (显式更新信号)", () => {
  it("新条目 supersedes 旧的, 旧的 status=superseded + supersededBy (不删除)", async () => {
    const first = await facade.remember({ content: "容器并发上限设为 10", kind: "lesson" });
    const second = await facade.remember({ content: "容器并发上限改为 50", kind: "lesson" });

    expect(second.decision).toBe("superseded");
    expect(second.targetId).toBe(first.entry.id);
    expect(
      second.entry.relations?.some((r) => r.type === "supersedes" && r.toId === first.entry.id),
    ).toBe(true);

    const old = await facade.get(first.entry.id);
    expect(old?.status).toBe("superseded");
    expect(
      old?.relations?.some((r) => r.type === "supersededBy" && r.toId === second.entry.id),
    ).toBe(true);
    // 两条都在真相里 (历史可查)
    expect(store.all().length).toBe(2);
  });

  it("取代后检索只返回最新版本, history 能看到完整演化链", async () => {
    const first = await facade.remember({ content: "容器并发上限设为 10", kind: "lesson" });
    const second = await facade.remember({ content: "容器并发上限改为 50", kind: "lesson" });

    const hits = facade.recall({ text: "容器并发上限" }).hits;
    expect(hits.map((h) => h.entry.id)).toContain(second.entry.id);
    expect(hits.map((h) => h.entry.id)).not.toContain(first.entry.id);

    const chain = await facade.history(second.entry.id);
    expect(chain.map((e) => e.id)).toEqual([first.entry.id, second.entry.id]);
    expect(chain.map((e) => e.status)).toEqual(["superseded", "active"]);
  });

  it("关闭自动演化时只落盘不改状态 (阈值不可达)", async () => {
    const strict = mk({ autoEvolve: false });
    const first = await strict.remember({ content: "容器并发上限设为 10", kind: "lesson" });
    const second = await strict.remember({ content: "容器并发上限改为 50", kind: "lesson" });
    expect(second.decision).toBe("linked");
    expect((await strict.get(first.entry.id))?.status).toBe("active");
  });

  it("规则永不被自动取代, 状态也不改", async () => {
    store.add({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "容器并发上限设为 10",
      source: "review:confirm",
      ts: { validAt: "2026-05-01T00:00:00.000Z", assertedAt: "2026-05-01T00:00:00.000Z" },
      confirmedBy: "hx",
      confirmedAt: "2026-05-01T00:00:00.000Z",
    });
    const res = await facade.remember({ content: "容器并发上限改为 50", kind: "lesson" });
    expect(res.decision).toBe("contradicted");
    const rule = await facade.get("rule-1");
    expect(rule?.status).toBe("active");
    expect(rule?.relations?.some((r) => r.type === "contradicts")).toBe(true);
  });
});

describe("冲突标记 (无更新信号)", () => {
  it("数字矛盾 → 两边都 active + 双向 contradicts (等人裁决)", async () => {
    const first = await facade.remember({ content: "缓存过期时间是 60 秒", kind: "decision" });
    const second = await facade.remember({ content: "缓存过期时间是 300 秒", kind: "decision" });
    expect(second.decision).toBe("contradicted");
    const firstAfter = await facade.get(first.entry.id);
    expect(firstAfter?.status).toBe("active");
    expect(
      firstAfter?.relations?.some((r) => r.type === "contradicts" && r.toId === second.entry.id),
    ).toBe(true);
    expect(
      second.entry.relations?.some((r) => r.type === "contradicts" && r.toId === first.entry.id),
    ).toBe(true);
    // 两条都能被检索到 (不替用户做选择)
    expect(facade.recall({ text: "缓存过期时间" }).hits.length).toBe(2);
  });

  it("极性相反 (要 vs 不要) → contradicts", async () => {
    await facade.remember({ content: "缓存要开启过期淘汰" });
    const second = await facade.remember({ content: "缓存不要开启过期淘汰" });
    expect(second.decision).toBe("contradicted");
  });
});

describe("结构关联 (标签/实体共现)", () => {
  it("写入时自动与共享标签的记忆建 relates 边 (有上限)", async () => {
    const a = await facade.remember({ content: "并发上限第一条记录", tags: ["concurrency"] });
    const b = await facade.remember({ content: "数据库连接池记录", tags: ["database"] });
    // 内容与 a 无关 (避免被判重复), 但共享标签 → 应该建结构边。
    const c = await facade.remember({ content: "部署流水线的重试策略", tags: ["concurrency"] });
    expect(c.entry.relations?.some((r) => r.type === "relates" && r.toId === a.entry.id)).toBe(
      true,
    );
    expect(c.entry.relations?.some((r) => r.type === "relates" && r.toId === b.entry.id)).toBe(
      false,
    );
    // 结构边写进真相: 重建后仍在
    store.rebuildFromFiles();
    const after = await facade.get(c.entry.id);
    expect(after?.relations?.some((r) => r.type === "relates" && r.toId === a.entry.id)).toBe(true);
  });
});

describe("语义兜底去重 (Embedder 端口)", () => {
  it("字面不重合但向量相近 → duplicate (只强化老条目)", async () => {
    // 桩嵌入器: 只验证"端口 + 阈值 + 证据门"的机制, 真实模型只需换实现。
    const stub: Embedder = {
      id: "stub",
      dim: 2,
      embed(texts) {
        return texts.map((t) => (t.includes("回归") ? [1, 0] : [0.999, 0.045]));
      },
    };
    const semantic = mk({ embedder: stub, semanticDuplicateFloor: 0.95 });
    const first = await semantic.remember({ content: "上线之前必须做一次完整回归测试" });
    const second = await semantic.remember({ content: "每次部署前要跑一遍全量回归校验" });
    expect(second.decision).toBe("duplicate");
    expect(second.targetId).toBe(first.entry.id);
    expect(store.all().length).toBe(1);
  });

  it("没有 Embedder 时完全不产生语义开销 (同一对内容 → 普通裁决)", async () => {
    const first = await facade.remember({ content: "上线之前必须做一次完整回归测试" });
    const second = await facade.remember({ content: "每次部署前要跑一遍全量回归校验" });
    expect(["added", "linked"]).toContain(second.decision);
    expect(second.targetId === first.entry.id || second.targetId === undefined).toBe(true);
  });
});
