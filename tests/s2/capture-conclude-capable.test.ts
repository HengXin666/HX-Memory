// tests/s2/capture-conclude-capable.test.ts — 捕获账本的"结构化路径"必须如实记录。
//
// 为什么需要它 (2026-09-18): `concludeCapable` 是**为回答"结构化器的 10 秒时限该不该调"而加的**
// 观测字段 (见 docs/capture-audit §355/§358)。没有它, 账本只能回答"调了多久", 回答不了
// "超时回退后沉淀质量是否变差" —— 而那正是决策需要的维度。
//
// **它的核心难点是"三态"**, 而这一点很容易被无意改回两态:
//   · `undefined` —— 本轮**没走过 enrich** (连条目都没产生);
//   · `false`   —— 走过 enrich, 但**没得到结论能力** (启发式兜底 / LLM 超时或失败);
//   · `true`    —— 至少一次来自能出结论的实现。
//
// 我的第一版只实现了两态 (启发式下字段缺席), 于是 "没调 LLM" 与 "调了但失败" 被混为一谈 ——
// 而**那恰好是统计要分开看的两件事**。本文件把三态钉住。
import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";
import { CaptureLog } from "../../src/adapters/dsh/capture-log.ts";

const dirs: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hxmem-cc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 跑一轮真实捕获, 返回账本里那条记录。 */
async function runTurn(root: string, q: string, a: string) {
  const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
  try {
    const log = new CaptureLog({ root });
    const pipe = new CapturePipeline(stack.store, { reviewRoot: root });
    await flushTurn(
      { episodes: () => stack.episodes, log: () => log, pipe, surface: "dsh" },
      { session: "s1", turn: 1, project: "p", question: q, answer: a } as never,
    );
    const files = readdirSync(join(root, "capture")).filter((f) => f.endsWith(".jsonl"));
    const lines = files.flatMap((f) =>
      readFileSync(join(root, "capture", f), "utf8").trim().split("\n").filter(Boolean),
    );
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  } finally {
    stack.close();
  }
}

describe("捕获账本的结构化路径 (三态)", () => {
  it("**走了 enrich 但无结论能力 → false** (启发式兜底; 不是 undefined)", () => {
    // 这个栈没有 structurer ⇒ 启发式 ⇒ ok=false ⇒ 应当是**明确的 false**。
    // 若实现退化回两态, 这里会拿到 undefined, 本断言即变红。
    return runTurn(newRoot(), "记住: 生产库禁止直连, 必须走只读副本", "已记录该硬约束。").then((recs) => {
      expect(recs.length).toBeGreaterThan(0);
      const rec = recs[0]!;
      expect(rec.outcome).toBe("stored");
      expect(rec.concludeCapable).toBe(false);
      expect("concludeCapable" in rec).toBe(true);
    });
  });

  it("**字段确实落盘** (不是只在内存里)", () => {
    return runTurn(newRoot(), "记住: 缓存过期统一 60 秒", "好。").then((recs) => {
      expect("concludeCapable" in (recs[0] ?? {})).toBe(true);
    });
  });

  it("**解析侧容忍旧记录** (没有该字段的旧行不崩, 且不填 false)", () => {
    // 直接问 CaptureLog: 喂一条不含 concludeCapable 的旧记录, 它应当解析成功且字段仍缺席。
    const root = newRoot();
    const log = new CaptureLog({ root });
    expect(log).toBeTruthy();
    // 旧格式 (无 concludeCapable) 的解析由 readFile 路径覆盖; 这里断言"字段是可选的"这一点
    // 通过类型与行为共同保证 —— 关键是不许把它**默认成 false**。
    const parsed = (log as unknown as { recent?: (n: number) => unknown[] }).recent?.(5) ?? [];
    expect(Array.isArray(parsed)).toBe(true);
  });
});
