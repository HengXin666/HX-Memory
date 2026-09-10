// tests/s2/transfer.test.ts — 导出/导入: 迁移与备份的往返契约。
//
// 这条通路的意义是兑现"存储层可插拔": 导出只认领域类型, 因此 A 引擎导出、B 引擎导入永远可行。
// 断言的四件事: 往返无损 / 幂等 / 治理不被绕过 / 坏行不毁全场。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import { exportMemory, importMemory } from "../../src/app/transfer.ts";
import type { MemoryEntry, MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-transfer-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/** 把 async iterable 收成数组 (测试里便于复用)。 */
async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of stream) out.push(line);
  return out;
}

function seed(id: string, over: Partial<MemoryEntryInput> = {}): MemoryEntry {
  return store.add({
    id,
    kind: "lesson",
    content: "内容 " + id,
    source: "s:" + id,
    scope: "project",
    project: "api",
    ts: T,
    tags: ["t1"],
    entities: ["容器"],
    importance: 7,
    confidence: 0.8,
    reinforcement: 2,
    lastHitAt: T.assertedAt,
    expiresAt: "2027-01-01T00:00:00.000Z",
    derivedFrom: ["ep-1"],
    mergedFrom: ["old-1"],
    structured: { summary: "摘要", points: ["要点"] },
    relations: [{ type: "relates", toId: "other" }],
    ...over,
  });
}

describe("jsonl 往返", () => {
  it("逐字段无损: 导出再导入到另一个引擎, 条目完全相等", async () => {
    const original = seed("a1");
    const lines = await collect(exportMemory([original], "jsonl"));
    // 导入到一个**不同的引擎** (内存实现) —— 证明迁移不需要相同后端。
    const target = new MemoryBackend();
    const report = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l;
      })(),
    );
    expect(report.errors).toEqual([]);
    expect(report.imported).toBe(1);
    expect(await target.get("a1")).toEqual(original);
  });

  it("幂等: 同一份数据导入两次 → 第二次 imported=0, unchanged=总数", async () => {
    seed("b1");
    seed("b2");
    const lines = await collect(exportMemory(store.all(), "jsonl"));
    const target = new MemoryBackend();
    const first = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l;
      })(),
    );
    expect(first.imported).toBe(2);
    const second = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l;
      })(),
    );
    expect(second.imported).toBe(0);
    expect(second.unchanged).toBe(2);
    expect((await target.all()).length).toBe(2);
  });
});

describe("治理与容错", () => {
  it("未确认的 rule 被拒绝 (不绕过存储闸门) 且记入 errors, 不中断整批", async () => {
    const lines = [
      JSON.stringify({
        id: "ok",
        kind: "lesson",
        content: "正常条目",
        source: "s",
        scope: "agent",
        ts: T,
      }),
      JSON.stringify({
        id: "bad-rule",
        kind: "rule",
        content: "未确认规则",
        source: "s",
        scope: "global",
        ts: T,
      }),
      JSON.stringify({
        id: "ok2",
        kind: "fact",
        content: "第二条正常",
        source: "s",
        scope: "agent",
        ts: T,
      }),
    ];
    const target = new MemoryBackend();
    const report = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l + "\n";
      })(),
    );
    expect(report.imported).toBe(2);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain("bad-rule");
    expect((await target.all()).map((e) => e.id).sort()).toEqual(["ok", "ok2"]);
  });

  it("坏行 (非法 JSON / 缺字段) 只跳过并记账, 其余照常导入", async () => {
    const lines = [
      "{ 这不是 JSON\n",
      JSON.stringify({ id: "no-kind", content: "缺 kind" }) + "\n",
      JSON.stringify({
        id: "good",
        kind: "fact",
        content: "好的",
        source: "s",
        scope: "agent",
        ts: T,
      }) + "\n",
    ];
    const target = new MemoryBackend();
    const report = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l;
      })(),
    );
    expect(report.imported).toBe(1);
    expect(report.errors.length).toBe(2);
    expect((await target.all()).map((e) => e.id)).toEqual(["good"]);
  });

  it("末行没有换行结尾也能导入 (手动编辑的备份文件常见)", async () => {
    const line = JSON.stringify({
      id: "tail",
      kind: "fact",
      content: "末行",
      source: "s",
      scope: "agent",
      ts: T,
    });
    const target = new MemoryBackend();
    const report = await importMemory(
      target,
      (async function* () {
        yield line; // 故意不带 \n
      })(),
    );
    expect(report.imported).toBe(1);
  });
});

describe("markdown 格式 (人可读备份)", () => {
  it("导出再导入闭环, 关键字段保留", async () => {
    const original = seed("m1");
    const lines = await collect(exportMemory([original], "markdown"));
    // markdown 块以 frontmatter 开头 (人可读 + 机器可解析), 而不是标题。
    expect(lines[0]).toMatch(/^---\nid: m1\n/);
    const target = new MemoryBackend();
    const report = await importMemory(
      target,
      (async function* () {
        for (const l of lines) yield l;
      })(),
      { format: "markdown" },
    );
    expect(report.errors).toEqual([]);
    const restored = await target.get("m1");
    expect(restored?.content).toBe(original.content);
    expect(restored?.kind).toBe(original.kind);
    expect(restored?.ts).toEqual(original.ts);
    expect(restored?.tags).toEqual(original.tags);
    expect(restored?.relations).toEqual(original.relations);
  });
});
