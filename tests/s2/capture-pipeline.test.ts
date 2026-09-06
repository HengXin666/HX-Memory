// tests/s2/capture-pipeline.test.ts — S2: capture pipeline persists through FileBackend.
// Temp dirs, no network.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";

let root: string;
let store: FileBackend;
let pipe: CapturePipeline;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-s2p-"));
  store = new FileBackend({ root });
  pipe = new CapturePipeline(store);
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("CapturePipeline: turn → persisted memory", () => {
  it("captures and persists a lesson", async () => {
    const r = await pipe.run({
      text: "后端队列并发踩坑, 下次要注意幂等",
      session: "sessA",
      project: "hx-memory",
    });
    expect(r.entries).toHaveLength(1);
    const id = r.entries[0]!.id;
    expect(store.get(id)?.kind).toBe("lesson");
    expect(store.get(id)?.scope).toBe("project");
  });

  it("dedupes identical turn across runs", async () => {
    await pipe.run({ text: "记住: 生产库禁止直连", session: "sessA" });
    const second = await pipe.run({ text: "记住: 生产库禁止直连", session: "sessA" });
    expect(second.entries).toHaveLength(0);
    expect(second.deduped).toBe(1);
  });

  it("warmUp restores dedupe after restart", async () => {
    // New pipeline over same store (simulates restart)
    const pipe2 = new CapturePipeline(store);
    const warmed = await pipe2.warmUp();
    expect(warmed).toBeGreaterThan(0);
    const dup = await pipe2.run({ text: "记住: 生产库禁止直连", session: "sessA" });
    expect(dup.deduped).toBe(1);
  });

  it("truth file exists under digest/ for a lesson", async () => {
    const r = await pipe.run({ text: "lesson 信号: 注意超时重试", session: "sessB" });
    const day = r.entries[0]!.ts.validAt.slice(0, 10);
    expect(existsSync(join(root, "digest", day + ".md"))).toBe(true);
  });
});
