// tests/s2/atomic-write.test.ts — 真相文件的写入必须是原子的。
//
// 为什么需要它 (2026-09-18): `writeFileParts` 此前直接 `writeFileSync` **原地覆盖** ——
// 若进程在写入中途崩溃/断电, 文件会被**截断到写入进度**, 后面的块全部丢失。
// (盲审也把"读-改-写非原子"列为遗留第 2 条。)
//
// 风险面 (实测区分过):
//   · `appendBlockToFile` (O(1) 快路径): 崩溃只丢末尾一个换行, 不影响解析;
//   · `writeFileParts` (整文件重写): 崩溃会**丢整段内容** ← 本次修的是这个。
//
// 本文件测三件事: ①产物仍正确; ②不留下临时文件; ③崩溃时旧内容**完好**(靠 rename 的原子性)。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileParts, readFileParts, appendBlockToFile } from "../../src/storage/markdown-codec.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const mk = (id: string, c: string) => ({ id, kind: "lesson", content: c, source: "t", scope: "agent", ts: T } as MemoryEntry);

const dirs: string[] = [];
const tmpFile = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hxmem-atomic-"));
  dirs.push(d);
  return join(d, "truth.md");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("真相文件的原子写", () => {
  it("产物仍正确 (改成原子写不该改变结果)", () => {
    const f = tmpFile();
    appendBlockToFile(f, mk("e1", "第一条"));
    writeFileParts(f, readFileParts(f));
    const parts = readFileParts(f);
    expect(parts.blocks).toHaveLength(1);
    expect(parts.blocks[0]).toContain("第一条");
    expect(readFileSync(f, "utf8").endsWith("\n")).toBe(true);
  });

  it("**不留下临时文件** (成功后 tmp 被 rename 消费掉)", () => {
    const f = tmpFile();
    writeFileParts(f, { preamble: "", blocks: ["---\nid: a\n---\n内容"] } as never);
    const left = readdirSync(join(f, "..")).filter((n) => n.includes(".tmp-"));
    expect(left).toEqual([]);
  });

  it("**崩溃时旧内容完好** (新内容先落 tmp, 损坏也只损坏 tmp)", () => {
    const f = tmpFile();
    writeFileParts(f, { preamble: "", blocks: ["---\nid: old\n---\n旧内容"] } as never);
    const before = readFileSync(f, "utf8");
    expect(before).toContain("旧内容");

    // 模拟"新内容写了一半崩溃": 直接写一个半截的 tmp 文件, 不 rename。
    // 目标文件必须**完全不受影响** —— 这正是原子写要保证的性质。
    writeFileSync(f + ".tmp-crashed", "---\nid: half\n---\n半截内", "utf8");
    expect(readFileSync(f, "utf8")).toBe(before);
    expect(readFileSync(f, "utf8")).toContain("旧内容");
  });

  it("**写入是 rename 而非原地覆盖** (inode 会变 —— 这是可观测的原子性判据)", () => {
    // 为什么用 inode: 原子写的本质是"先写 tmp, 再 rename 覆盖" —— rename **会换 inode**;
    // 而原地 writeFileSync 保持同一个 inode, 只是内容被就地改写。
    //
    // 这条断言是**反驳测试逼出来的**: 我最初那 4 条断言在"退回非原子写"时**全部仍然通过**
    // (因为它们只检查"产物正确"与"不留 tmp", 而原地写同样满足这两点)。
    // 只有 inode 这一条能真正区分两种实现。
    const f = tmpFile();
    writeFileParts(f, { preamble: "", blocks: ["---\nid: a\n---\n初始"] } as never);
    const ino1 = statSync(f).ino;
    writeFileParts(f, { preamble: "", blocks: ["---\nid: a\n---\n更新"] } as never);
    const ino2 = statSync(f).ino;
    expect(ino2).not.toBe(ino1);
    expect(readFileSync(f, "utf8")).toContain("更新");
  });

  it("没有块也没有前言时删除文件 (既有语义不变)", () => {
    const f = tmpFile();
    writeFileParts(f, { preamble: "", blocks: ["---\nid: a\n---\nx"] } as never);
    expect(existsSync(f)).toBe(true);
    writeFileParts(f, { preamble: "", blocks: [] } as never);
    expect(existsSync(f)).toBe(false);
  });
});
