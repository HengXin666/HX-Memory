// tests/s2/sweep-atomic-temps.test.ts — 原子写的孤儿临时文件必须能被清扫。
//
// 为什么需要它 (2026-09-18): 上一轮把真相文件改成原子写 (tmp + rename) 后,
// 正常路径不留残留 (实测写 10 次残留 0), 但**进程在 rename 前崩溃**会留下孤儿 tmp。
//
// 它**不影响正确性** —— 文件名是 `<原文件>.tmp-<pid>-<时间戳>` (**在 .md 之后追加**),
// 而 `walkMd` 只收 `endsWith(".md")` ⇒ 不会被读成真相文件。
// 但它**会永久累积** (此前无清理机制) —— 本文件守住清扫器。
//
// **删除必须保守** (两条判据):
//   ① 文件名含 `.tmp-` 且**不以 `.md` 结尾**;
//   ② **mtime 超过 1 小时** —— 刚产生的 tmp 可能属于一个**正在进行的写入**,
//      删掉它会让那次写入的 rename 失败。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepAtomicTemps } from "../../src/storage/markdown-parse.ts";

const dirs: string[] = [];
const newDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hxmem-sweep-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 造一个"很久以前"的文件 (mtime 拨回 2 小时)。 */
const oldFile = (p: string, content = "x"): void => {
  writeFileSync(p, content, "utf8");
  const past = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(p, past, past);
};

describe("原子写临时文件的清扫", () => {
  it("**清扫陈旧的孤儿 tmp**", () => {
    const d = newDir();
    mkdirSync(join(d, "daily"), { recursive: true }); // 目录不存在时 writeFileSync 会抛 (我第一版漏了这一步)
    oldFile(join(d, "daily", "2026-01-01.md.tmp-123-abc"));
    expect(sweepAtomicTemps(d)).toHaveLength(1);
    expect(existsSync(join(d, "daily", "2026-01-01.md.tmp-123-abc"))).toBe(false);
  });

  it("**不删真相文件** (即使内容里含 .tmp- 字样)", () => {
    const d = newDir();
    mkdirSync(join(d, "daily"), { recursive: true });
    oldFile(join(d, "daily", "2026-01-01.md"), "内容里提到 .tmp- 但不是临时文件");
    expect(sweepAtomicTemps(d)).toHaveLength(0);
    expect(existsSync(join(d, "daily", "2026-01-01.md"))).toBe(true);
  });

  it("**不删太新的 tmp** (可能是正在进行的写入)", () => {
    const d = newDir();
    // 刚写的 tmp: mtime 是现在 ⇒ 必须保留
    writeFileSync(join(d, "x.md.tmp-999-zzz"), "正在写", "utf8");
    expect(sweepAtomicTemps(d)).toHaveLength(0);
    expect(existsSync(join(d, "x.md.tmp-999-zzz"))).toBe(true);
  });

  it("**delete:false 时只列出不删** (dryRun 的语义)", () => {
    const d = newDir();
    oldFile(join(d, "a.md.tmp-1-x"));
    const listed = sweepAtomicTemps(d, { delete: false });
    expect(listed).toHaveLength(1);
    expect(existsSync(join(d, "a.md.tmp-1-x"))).toBe(true); // 仍在
  });

  it("空目录/不存在目录不抛错", () => {
    const d = newDir();
    expect(sweepAtomicTemps(d)).toEqual([]);
    expect(sweepAtomicTemps(join(d, "nope"))).toEqual([]);
  });
});
