// tests/s2/evidence-chain.test.ts — 证据链 (条目 → 原始对话原话) 的端到端契约。
//
// 为什么要有这条: 产品承诺"可溯源", 而 `derivedFrom` 存了 episode id 却长期没有查询路径 ——
// "这句话是怎么来的"回答不了。本测试钉住三件事:
//   ① 能追到原文; ② 原文是**未经改写**的 (不是摘要冒充); ③ 追不到时如实说明, 不假装成功。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";
import { EpisodeStore } from "../../src/storage/episode-store.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evidence-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 经**真实捕获路径**产生一条带血缘的记忆 (而不是手工造 derivedFrom)。
 *
 * 注意: 捕获自 v3 起是**提炼**而非转录 —— 条目的 content 可能是结构化器给出的结论,
 * 不一定逐字包含问句。因此这里按"有 derivedFrom 的新条目"来定位, 而不是按问句前缀匹配
 * (按前缀匹配会找不到条目 —— 那是测试自己的 bug, 不是实现的)。
 */
async function seed(stack: ReturnType<typeof openMemoryStack>, question: string, answer: string, turn = 1) {
  const before = new Set(stack.store.all().map((e) => e.id));
  const pipe = new CapturePipeline(stack.store);
  await flushTurn(
    { episodes: () => stack.episodes, log: () => null, pipe, surface: "dsh" },
    { session: "session-ev", turn, project: "ev", question, answer } as never,
  );
  const fresh = stack.store.all().filter((e) => !before.has(e.id) && (e.derivedFrom ?? []).length > 0);
  return fresh[0];
}

describe("证据链: 条目 → 原始对话", () => {
  it("能追到未改写的 user/assistant 原文 (不是摘要)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const q = "记住: 证据链要能追到原文的每一个字";
    const a = "已记录: 证据链要能追到原文的每一个字。";
    const entry = (await seed(stack, q, a))!;
    const chain = await stack.facade.evidenceChain(entry.id);
    expect(chain).not.toBeNull();
    expect(chain!.traceable).toBe(true);
    // 原文逐字可取 (含问句本身, 而非被提炼过的结论)
    expect(chain!.episodes.some((e) => e.text === q)).toBe(true);
    expect(chain!.episodes.some((e) => e.text === a)).toBe(true);
    // 顺序还原对话 (user 在前)
    expect(chain!.episodes[0]!.role).toBe("user");
    stack.close();
  });

  it("source 是真实会话 id (与证据链交叉印证)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const entry = (await seed(stack, "记住: 来源与证据链必须相互印证", "已记录。"))!;
    const chain = await stack.facade.evidenceChain(entry.id);
    expect(chain!.source).toBe("session:session-ev");
    stack.close();
  });

  it("无血缘的条目如实说明原因, 不返回看起来成功的空结果", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const e = stack.store.add({ kind: "fact", content: "手工写入的无血缘条目", source: "session:x", scope: "agent" });
    const chain = await stack.facade.evidenceChain(e.id);
    expect(chain!.traceable).toBe(false);
    expect(chain!.reasons.length).toBeGreaterThan(0);
    expect(chain!.reasons[0]).toContain("没有记录血缘");
    stack.close();
  });

  it("原文被保留期清理后如实报缺失, 不拿其它内容顶替", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const entry = (await seed(stack, "记住: 这条的原文稍后会被人为删掉", "已记录。"))!;
    // 人为清空 episode 日志目录内容 (模拟保留期清理)
    const ep = new EpisodeStore({ root, retentionDays: 0 });
    const dir = ep.dir;
    rmSync(dir, { recursive: true, force: true });
    const chain = await stack.facade.evidenceChain(entry.id);
    expect(chain!.episodeIds.length).toBeGreaterThan(0);
    expect(chain!.episodes).toHaveLength(0);
    expect(chain!.traceable).toBe(false);
    expect(chain!.reasons.some((r) => r.includes("不可取"))).toBe(true);
    stack.close();
  });

  it("不存在的条目 id 返回 null (不抛错)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    expect(await stack.facade.evidenceChain("mNotExist")).toBeNull();
    stack.close();
  });

  it("byIds 按时间升序返回且忽略不存在的 id", () => {
    const ep = new EpisodeStore({ root, retentionDays: 0 });
    const a = ep.append({ session: "s", turn: 1, role: "user", text: "第一轮", at: "2026-09-18T01:00:00.000Z" });
    const b = ep.append({ session: "s", turn: 1, role: "assistant", text: "第一轮回复", at: "2026-09-18T01:00:01.000Z" });
    const got = ep.byIds([b.id, a.id, "epNOPE"]);
    expect(got.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(ep.byIds([])).toEqual([]);
  });
});
