// dogfood: 捕获"用户偏好中文回复"为真实记忆 (演示完整流程)
import { it, expect } from "vitest";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("self-proof: 用户语言偏好被捕获为记忆 (HX-Memory 第一条真实记忆)", () => {
  const root = mkdtempSync(join(tmpdir(), "hxmem-dogfood-"));
  const store = new FileBackend({ root });
  const pipe = new CapturePipeline(store);

  const r1 = pipe.run({
    text: "记住: 用户要求 AI 每次回复必须用中文",
    session: "bootstrap",
    project: "hx-memory",
  });
  expect(r1.entries).toHaveLength(1);
  expect(r1.entries[0]!.kind).toBe("fact");
  expect(r1.entries[0]!.content).toContain("中文");

  // 内容不同 → 第二条也捕获 (偏好信号 → preference)
  const r2 = pipe.run({ text: "我更喜欢用中文回复", session: "bootstrap", project: "hx-memory" });
  expect(r2.entries[0]!.kind).toBe("preference");

  // 从存储读回, 证明真实落盘
  const hits = store.query({ text: "中文" });
  expect(hits.length).toBeGreaterThanOrEqual(2);

  store.close();
  rmSync(root, { recursive: true, force: true });
});
