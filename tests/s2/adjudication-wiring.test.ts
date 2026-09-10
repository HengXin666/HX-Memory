// tests/s2/adjudication-wiring.test.ts — 冲突裁决真的接进了写入路径 (不只是"有个服务")。
//
// 背景: 此前"没有显式更新信号的矛盾"只写一条 contradicts 边, 两条都 active, 矛盾永久堆积。
// 现在写入路径会先对"同 kind 且硬冲突"的邻居预裁决, 再决定取代/强化/并存。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { MemoryFacade } from "../../src/app/facade.ts";
import type { Adjudicator } from "../../src/evolution/adjudicator.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-adj-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const mk = (opts: ConstructorParameters<typeof MemoryFacade>[1] = {}) =>
  new MemoryFacade({ store, retriever: new HybridRetriever(store) }, { ...opts });

describe("冲突裁决接线", () => {
  it("默认启发式: 更晚且置信度不低 → 取代 (旧条目置 superseded, 不删除)", async () => {
    const facade = mk();
    const first = await facade.remember({
      content: "缓存过期时间是 60 秒",
      kind: "decision",
      importance: 5,
      validAt: "2026-06-01T00:00:00.000Z",
    });
    const second = await facade.remember({
      content: "缓存过期时间是 300 秒",
      kind: "decision",
      importance: 5,
      validAt: "2026-06-02T00:00:00.000Z",
    });
    expect(second.decision).toBe("superseded");
    expect((await facade.get(first.entry.id))?.status).toBe("superseded");
    expect(store.all().length).toBe(2);
  });

  it("默认启发式: 时间倒退 → keep-both (两条 active + 双向 contradicts)", async () => {
    const facade = mk();
    const first = await facade.remember({
      content: "缓存过期时间是 60 秒",
      kind: "decision",
      validAt: "2026-06-02T00:00:00.000Z",
    });
    const second = await facade.remember({
      content: "缓存过期时间是 300 秒",
      kind: "decision",
      validAt: "2026-06-01T00:00:00.000Z",
    });
    expect(second.decision).toBe("contradicted");
    expect((await facade.get(first.entry.id))?.status).toBe("active");
    expect((await facade.get(second.entry.id))?.status).toBe("active");
  });

  it("规则永不被裁决器取代 (双保险: 即使注入一个激进的裁决器)", async () => {
    // 一个"永远说 supersede"的裁决器 —— 用来证明 evolve 的硬约束不依赖注入实现。
    const aggressive: Adjudicator = {
      id: "aggressive",
      async adjudicate() {
        return { verdict: "supersede", confidence: 1, reason: "测试用激进裁决器" };
      },
    };
    const facade = mk({ adjudicator: aggressive });
    store.add({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "缓存过期时间是 60 秒",
      source: "review",
      ts: { validAt: "2026-05-01T00:00:00.000Z", assertedAt: "2026-05-01T00:00:00.000Z" },
      confirmedBy: "hx",
      confirmedAt: "2026-05-01T00:00:00.000Z",
    });
    const res = await facade.remember({ content: "缓存过期时间是 300 秒", kind: "lesson" });
    // 目标是 rule → 绝不取代, 只标记冲突 (规则本体状态必须不变)。
    expect((await facade.get("rule-1"))?.status).toBe("active");
    expect(res.decision).toBe("contradicted");
    // 规则确实被标记了冲突边 (可追溯), 但状态没被机器改。
    expect((await facade.get("rule-1"))?.relations?.some((r) => r.type === "contradicts")).toBe(
      true,
    );
  });

  it("裁决器抛错时退回安全默认 (标记冲突而不是让写入失败)", async () => {
    const broken: Adjudicator = {
      id: "broken",
      async adjudicate() {
        throw new Error("model down");
      },
    };
    const facade = mk({ adjudicator: broken });
    await facade.remember({ content: "缓存过期时间是 60 秒", kind: "decision" });
    const second = await facade.remember({ content: "缓存过期时间是 300 秒", kind: "decision" });
    expect(second.decision).toBe("contradicted");
    expect(store.all().length).toBe(2);
  });

  it("autoEvolve=false 时不跑裁决 (省一次模型调用)", async () => {
    let calls = 0;
    const counting: Adjudicator = {
      id: "counting",
      async adjudicate() {
        calls++;
        return { verdict: "keep-both", confidence: 0.5, reason: "计数" };
      },
    };
    const facade = mk({ autoEvolve: false, adjudicator: counting });
    await facade.remember({ content: "缓存过期时间是 60 秒", kind: "decision" });
    await facade.remember({ content: "缓存过期时间是 300 秒", kind: "decision" });
    expect(calls, "关闭自动演化时不应调用裁决器").toBe(0);
  });

  it("非冲突的相近内容不走裁决 (避免无谓的模型调用)", async () => {
    let calls = 0;
    const counting: Adjudicator = {
      id: "counting2",
      async adjudicate() {
        calls++;
        return { verdict: "keep-both", confidence: 0.5, reason: "计数" };
      },
    };
    const facade = mk({ adjudicator: counting });
    await facade.remember({ content: "容器并发要显式设置上限", kind: "lesson" });
    await facade.remember({ content: "数据库连接池要设置最大连接数", kind: "lesson" });
    expect(calls, "没有硬冲突就不该裁决").toBe(0);
  });
});
