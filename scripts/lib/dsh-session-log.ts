// scripts/lib/dsh-session-log.ts — 读 DSH 会话日志 (~/.dsh/sessions/<桶>/session-<uuid>/session[.vN].jsonl.zstd)。
// backfill-sessions.ts 与 eval/memory-recall.ts 共用这一份 (2026-11-02 从 backfill-sessions.ts 抽出, 行为不变)。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as zlib from "node:zlib";

export interface Ev { type?: string; seq?: number; time?: number; data?: any }
export interface Header { id: string; createdAt?: number; cwd?: string; origin?: string; version?: number }

/** 列出会话文件; 同一会话目录里有 v4 就不读 v3 / 无版本号 (DSH 升级迁移会留旧文件)。 */
export function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const f = d + "/" + n;
      if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(n)) out.push(f);
      else if (depth < 3) {
        try { if (statSync(f).isDirectory()) walk(f, depth + 1); } catch { /* 跳过 */ }
      }
    }
  };
  walk(dir, 0);
  const byDir = new Map<string, string[]>();
  for (const f of out) {
    const k = f.slice(0, f.lastIndexOf("/"));
    byDir.set(k, [...(byDir.get(k) ?? []), f]);
  }
  const ver = (f: string) => Number(/session\.v(\d+)\./.exec(f)?.[1] ?? 0);
  const pick = (fs: string[]) => fs.sort((a, b) => ver(b) - ver(a))[0]!;
  return [...byDir.values()].map(pick).sort();
}

/**
 * 解压会话日志。DSH 的 *.jsonl.zstd 是**多个 zstd 帧首尾相接** (每次追加写一帧), 而 Node 的 zstdDecompressSync
 * 只解第一帧 ⇒ 按帧魔数切开逐帧解; 切错 (魔数恰好出现在压缩数据里) 就把下一段并进来再试。
 * 没有 zlib zstd 的 Node 退回 zstd 命令行 (它原生支持多帧)。
 */
export function readZstd(f: string): string {
  const buf = readFileSync(f);
  const dz = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (!dz) return execFileSync("zstd", ["-dc", f], { maxBuffer: 1 << 30 }).toString("utf8");
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts: number[] = [];
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
  starts.push(buf.length);
  const out: Buffer[] = [];
  let a = 0;
  while (a < starts.length - 1) {
    let b = a + 1;
    for (;;) {
      try {
        out.push(dz(buf.subarray(starts[a]!, starts[b]!)));
        break;
      } catch (e) {
        if (++b >= starts.length) throw e;
      }
    }
    a = b;
  }
  return Buffer.concat(out).toString("utf8");
}

/** 解析一个会话文件; 解压失败或没有 session 头返回 null (调用方记账跳过)。 */
export function parseSession(f: string): { header: Header; events: Ev[] } | null {
  let text: string;
  try { text = readZstd(f); } catch { return null; }
  let header: Header | null = null;
  const events: Ev[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type === "session" && !header) header = o as Header;
    else events.push(o as Ev);
  }
  return header ? { header, events } : null;
}
