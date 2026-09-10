// tests/s2/structurer.test.ts — S2: AI 结构化端口 (启发式兜底) + pipeline 增强 + 知情权 (recent/delete)。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { heuristicStructurer } from "../../src/capture/structurer.ts";

let root: string;
let store: FileBackend;
let pipe: CapturePipeline;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-struct-"));
  store = new FileBackend({ root });
  pipe = new CapturePipeline(store, { structurer: heuristicStructurer() });
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("heuristicStructurer: 确定性结构化兜底", () => {
  it("推断并发/容器标签", async () => {
    const s = await heuristicStructurer().structure({
      text: "所有容器都有并发策略问题, 注意幂等",
      project: "a",
    });
    expect(s.tags).toContain("concurrency");
    expect(s.tags).toContain("container");
    expect(s.summary.length).toBeGreaterThan(0);
  });

  it("无信号时给 general 标签", async () => {
    const s = await heuristicStructurer().structure({ text: "今天天气不错", project: "a" });
    expect(s.tags).toEqual(["general"]);
  });
});

describe("pipeline: AI 结构化增强落盘", () => {
  it("结构化后的 tags 写入真相文件 + 索引", async () => {
    const r = await pipe.run({
      text: "所有容器都有并发策略问题, 下次要注意幂等",
      session: "s1",
      project: "hx-memory",
    });
    expect(r.entries.length).toBe(1);
    const e = r.entries[0]!;
    expect(e.tags).toBeDefined();
    expect(e.tags!.length).toBeGreaterThan(0);
    // 真相文件里出现 tags 行
    const files = ["daily", "digest"];
    const found = files.some((d) => {
      const dir = join(root, d);
      if (!existsSync(dir)) return false;
      return readdirSync(dir).some((f) => {
        const c = readFileSync(join(dir, f), "utf8");
        return c.includes("id: " + e.id) && c.includes("tags: [");
      });
    });
    expect(found).toBe(true);
  });
});

describe("知情权: recent + delete", () => {
  it("recent 返回最新捕获且带 tags", async () => {
    const rec = store.recent(10);
    expect(rec.length).toBeGreaterThan(0);
    expect(rec[0]!.tags).toBeDefined();
  });

  it("delete 撤回一条自动沉淀 (从面板消失, 真相保留为 shadow)", async () => {
    const r = await pipe.run({
      text: "决定改用 pnpm workspace",
      session: "s2",
      project: "hx-memory",
    });
    const id = r.entries[0]!.id;
    store.remove(id);
    // 真相仍在 (status=shadow, 不物理删)
    expect(store.get(id)).not.toBeNull();
    expect(store.get(id)!.status).toBe("shadow");
    // 但从"新沉淀"面板消失 (recent 排除 shadow)
    const rec = store.recent(50);
    expect(rec.some((e) => e.id === id)).toBe(false);
  });
});
