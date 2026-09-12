// tests/s2/entity-linking.test.ts — S2: 抽取实体 → 结构建边 的完整链路。
//
// 背景 (2026-09 实测): 真实库 80 条里 entities 填充率 **0%**, 56 条孤立, 边只有规则推广产生的
// generalizes。两个根因: ①`StructuredTurn` 根本没有 entities 字段, 抽取层无从产出;
// ②自动捕获走 pipeline 直连存储, 绕过了 facade.remember(), 于是 planStructuralLinks 永不执行。
// 本文件钉住修复后的三条不变量。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import type { TurnStructurer } from "../../src/capture/structurer.ts";

let root: string;
let store: FileBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-entitylink-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 按关键词回固定实体的 stub (模拟 LLM 抽取)。 */
function stub(map: Array<[string, string[]]>): TurnStructurer {
  return {
    async structure(input) {
      const hit = map.find(([k]) => input.text.includes(k));
      return {
        summary: "s",
        tags: ["probe"],
        points: [],
        ...(hit ? { entities: hit[1] } : {}),
        conclusion: "结论:" + input.text.slice(0, 20),
      };
    },
  };
}

describe("实体抽取 → 结构建边", () => {
  it("结构化器给出的 entities 会写进条目", async () => {
    const pipe = new CapturePipeline(store, {
      structurer: stub([["FTS5", ["FTS5", "hybrid.ts"]]]),
    });
    await pipe.run({ session: "s1", text: "记一下: FTS5 是词面通道" });
    const all = await store.all();
    expect(all[0]!.entities).toEqual(["FTS5", "hybrid.ts"]);
  });

  it("共享实体的两条记忆会自动建 relates 边 (这是图检索的前提)", async () => {
    const pipe = new CapturePipeline(store, {
      structurer: stub([
        ["FTS5", ["FTS5", "hybrid.ts"]],
        ["MMR", ["MMR", "hybrid.ts"]],
      ]),
    });
    await pipe.run({ session: "s1", text: "记一下: FTS5 是词面通道" });
    await pipe.run({ session: "s1", text: "记一下: MMR 顺序曾被当成排名" });
    const all = await store.all();
    expect(all).toHaveLength(2);
    const withEdge = all.filter((e) => (e.relations ?? []).length > 0);
    expect(withEdge).toHaveLength(1);
    const rel = withEdge[0]!.relations![0]!;
    expect(rel.type).toBe("relates");
    // 边必须指向另一条 (不能自指)
    expect(rel.toId).not.toBe(withEdge[0]!.id);
    expect(all.some((e) => e.id === rel.toId)).toBe(true);
  });

  it("没有实体也没有标签的条目不建边 (避免空共现)", async () => {
    const pipe = new CapturePipeline(store, {
      structurer: {
        async structure() {
          return { summary: "s", tags: [], points: [], conclusion: "结论" };
        },
      },
    });
    await pipe.run({ session: "s1", text: "记一下: 甲" });
    await pipe.run({ session: "s1", text: "记一下: 乙" });
    const all = await store.all();
    expect(all.every((e) => !(e.relations ?? []).length)).toBe(true);
  });

  it("maxStructuralLinks=0 关闭建边 (可配置)", async () => {
    const pipe = new CapturePipeline(store, {
      structurer: stub([
        ["FTS5", ["FTS5", "hybrid.ts"]],
        ["MMR", ["MMR", "hybrid.ts"]],
      ]),
      maxStructuralLinks: 0,
    });
    await pipe.run({ session: "s1", text: "记一下: FTS5 是词面通道" });
    await pipe.run({ session: "s1", text: "记一下: MMR 顺序曾被当成排名" });
    const all = await store.all();
    expect(all.every((e) => !(e.relations ?? []).length)).toBe(true);
  });

  it("建边失败不影响落盘 (增强不是门槛)", async () => {
    // 只让 all() 抛错, 其余方法透传真实 store —— 否则测的是"整个 store 坏了"。
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "all") return async () => { throw new Error("store down"); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const pipe = new CapturePipeline(broken as never, {
      structurer: stub([["FTS5", ["FTS5"]]]),
    });
    const r = await pipe.run({ session: "s1", text: "记一下: FTS5 是词面通道" });
    expect(r.entries).toHaveLength(1);
    expect((await store.all()).length).toBe(1);
  });
});
