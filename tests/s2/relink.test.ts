// tests/s2/relink.test.ts — 维护动作"重新建边"的契约。
//
// 为什么需要这个动作: 建边只在**写入时**发生, 因此判据改进只对新条目生效 —— 存量条目永远
// 停在旧口径上。实测真实库: active 154 条而 relates 边仅 20 条, 按当前判据重算可得约 400 条。
//
// 本文件钉住四条不变量 (改真相文件的动作必须有这些保证):
//   ① 只加边不碰内容; ② 幂等 (重跑不重复); ③ 只增不减 (人工显式建的边被保留);
//   ④ 干跑不写盘。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { relinkAll } from "../../src/app/relink.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relink-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const T = { validAt: "2026-09-18T00:00:00.000Z", assertedAt: "2026-09-18T00:00:00.000Z" };

/** 造一条含可抽取专名的记忆 (启发式口径 —— 真相字段无 entities)。 */
function seed(store: FileBackend, id: string, content: string, extra: Record<string, unknown> = {}) {
  return store.add({
    id, kind: "lesson", content, source: "test", scope: "agent", ts: T, ...extra,
  } as never);
}

function relatesOf(s: ReturnType<typeof seed>) {
  return (s.relations ?? []).filter((r) => r.type === "relates").length;
}

describe("relink: 给存量条目补边", () => {
  it("**只加边, 不改内容** (改真相文件的动作必须如此)", async () => {
    const store = new FileBackend({ root });
    const before = [
      await seed(store, "m1", "踩坑: prestep.ts 的注入时机由 injectMode 控制"),
      await seed(store, "m2", "决定: prestep.ts 读 trigger-cache 的 revision 决定重算"),
    ];
    const contents = before.map((e) => e.content);
    const report = await relinkAll(store, {});
    expect(report.added).toBeGreaterThan(0);
    const after = store.all();
    // 内容逐字未变
    expect(after.map((e) => e.content)).toEqual(contents);
    // 但边加上了
    expect(after.some((e) => relatesOf(e) > 0)).toBe(true);
    store.close();
  });

  it("**幂等**: 重跑不产生新边", async () => {
    const store = new FileBackend({ root });
    await seed(store, "m1", "踩坑: prestep.ts 的注入时机由 injectMode 控制");
    await seed(store, "m2", "决定: prestep.ts 读 trigger-cache 的 revision");
    const first = await relinkAll(store, {});
    expect(first.added).toBeGreaterThan(0);
    const second = await relinkAll(store, {});
    expect(second.added).toBe(0);
    store.close();
  });

  it("**只增不减**: 人工显式建的边被保留", async () => {
    const store = new FileBackend({ root });
    await seed(store, "m1", "踩坑: prestep.ts 的注入时机");
    const withManual = await seed(store, "m2", "决定: prestep.ts 读 trigger-cache", {
      relations: [{ type: "relates", toId: "m1", weight: 0.5 }],
    });
    expect(relatesOf(withManual)).toBe(1);
    await relinkAll(store, {});
    const after = store.all().find((e) => e.id === "m2")!;
    // 人工那条仍在 (权重未被覆盖)
    expect(after.relations!.some((r) => r.toId === "m1" && r.weight === 0.5)).toBe(true);
    store.close();
  });

  it("**干跑不写盘**", async () => {
    const store = new FileBackend({ root });
    await seed(store, "m1", "踩坑: prestep.ts 的注入时机");
    await seed(store, "m2", "决定: prestep.ts 读 trigger-cache 的 revision");
    const dry = await relinkAll(store, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.applied).toBe(false);
    expect(dry.added).toBeGreaterThan(0); // 报告说"可加"
    // 但盘上一条边都没加
    expect(store.all().every((e) => relatesOf(e) === 0)).toBe(true);
    store.close();
  });

  it("maxLinks=0 时完全不动 (可关闭)", async () => {
    const store = new FileBackend({ root });
    await seed(store, "m1", "踩坑: prestep.ts 的注入时机");
    await seed(store, "m2", "决定: prestep.ts 读 trigger-cache");
    const report = await relinkAll(store, { maxLinks: 0 });
    expect(report.added).toBe(0);
    store.close();
  });

  it("无专名的条目不被强行连边", async () => {
    const store = new FileBackend({ root });
    await seed(store, "m1", "踩坑: 今天天气不错");
    await seed(store, "m2", "决定: 明天也是");
    const report = await relinkAll(store, {});
    expect(report.added).toBe(0);
    store.close();
  });
});
