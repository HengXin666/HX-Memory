// tests/s1/engine-gate-parity.test.ts — **两个引擎对同一批非法输入必须同判**。
//
// 为什么需要它 (2026-09-18, §704 实测): 入库边界的**权威实现**是 `normalizeEntry`
// (FileBackend 走它), 而 `MemoryStore.add` **手写了 5 条副本** ⇒ 实测两引擎不一致:
//
// | 用例 | FileBackend | MemoryStore (修复前) |
// | --- | --- | --- |
// | 非法 `status` | 拒绝 | **接受** |
// | 非法 `id` | 拒绝 | **接受** |
//
// 而"非法 status 被接受"的后果具体: `isLiveEntry` 对**无法识别的状态**返回 `true`
// ⇒ 那条记忆**既不是有效状态, 也不会被任何过滤挡住** (既无效又过滤不掉)。
//
// ⇒ 本测试的判据不是"写死该拒绝哪些", 而是**两引擎对同一输入必须给出同一答案** ——
// 将来 `normalizeEntry` 加了新校验, 这里自动覆盖 (因为两个引擎都走它)。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };

/** 一批非法/边缘输入 (每条都带一个可读名字)。 */
const CASES: Array<[string, Record<string, unknown>]> = [
  ["非法 status", { kind: "fact", content: "x", source: "s", scope: "agent", status: "bogus", ts: T }],
  ["非法 id", { id: "bad id!", kind: "fact", content: "x", source: "s", scope: "agent", ts: T }],
  ["非法 kind", { kind: "bogus", content: "x", source: "s", scope: "agent", ts: T }],
  ["非法 scope", { kind: "fact", content: "x", source: "s", scope: "bogus", ts: T }],
  ["非法 validAt", { kind: "fact", content: "x", source: "s", scope: "agent", ts: { validAt: "不是时间", assertedAt: T.assertedAt } }],
  ["空 content", { kind: "fact", content: "", source: "s", scope: "agent", ts: T }],
  ["rule 无确认记录", { kind: "rule", content: "x", source: "s", scope: "global", ts: T }],
  ["合法输入", { kind: "fact", content: "正常", source: "s", scope: "agent", ts: T }],
];

/** 对某引擎跑一条输入, 返回"接受"或"拒绝"。 */
function verdict(store: { add(x: never): unknown }, input: Record<string, unknown>): boolean {
  try {
    store.add(input as never);
    return true;
  } catch {
    return false;
  }
}

describe("引擎闸门一致性: FileBackend 与 MemoryStore 同判", () => {
  it("**对每条输入, 两引擎给出同一答案**", () => {
    const root = mkdtempSync(join(tmpdir(), "parity-"));
    const fb = new FileBackend({ root });
    const ms = new MemoryBackend();
    try {
      const mismatches: string[] = [];
      for (const [name, input] of CASES) {
        const a = verdict(fb, { ...input } as Record<string, unknown>);
        const b = verdict(ms, { ...input } as Record<string, unknown>);
        if (a !== b) mismatches.push(name + " (FileBackend=" + a + ", MemoryStore=" + b + ")");
      }
      expect(mismatches, "两引擎对同一输入给出了不同答案").toEqual([]);
    } finally {
      fb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**非法 status 必须被拒** (它的后果比'缺校验'更具体: 会变成过滤不掉的幽灵条目)", () => {
    const ms = new MemoryBackend();
    expect(() =>
      ms.add({ kind: "fact", content: "x", source: "s", scope: "agent", status: "bogus", ts: T } as never),
    ).toThrow(/invalid status/);
  });

  it("**两个引擎存下来的形状一致** (归一化不该只有一条路做)", () => {
    const root = mkdtempSync(join(tmpdir(), "parity2-"));
    const fb = new FileBackend({ root });
    const ms = new MemoryBackend();
    try {
      // CRLF 归一: 那是 normalizeEntry 的职责, 而手写副本不做。
      const withCrlf = { kind: "fact", content: "第一行\r\n第二行", source: "s", scope: "agent", ts: T } as MemoryEntryInput;
      const a = fb.add({ ...withCrlf });
      const b = ms.add({ ...withCrlf });
      expect(a.content).toBe(b.content);
      expect(a.content).not.toContain("\r");
    } finally {
      fb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
