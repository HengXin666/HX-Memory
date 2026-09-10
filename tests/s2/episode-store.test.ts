// tests/s2/episode-store.test.ts — Episode 追加日志的契约 (ADR-018)。
//
// 它存在的唯一理由: 抽取器一定会升级, 到那时要能"重放"而不是"重聊"。
// 因此这里钉住四件事: 追加不改写 / 往返无损 (含多行正文) / 坏行不毁全场 / 保留期真的删。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeStore } from "../../src/storage/episode-store.ts";

let root: string;
let episodes: EpisodeStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-episodes-"));
  episodes = new EpisodeStore({ root });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Episode 日志: 追加与读取", () => {
  it("按天分文件, 一行一条 (JSONL)", () => {
    episodes.append({
      session: "s1",
      turn: 1,
      role: "user",
      text: "第一条",
      at: "2026-06-01T00:00:00.000Z",
    });
    episodes.append({
      session: "s1",
      turn: 2,
      role: "user",
      text: "第二天",
      at: "2026-06-02T00:00:00.000Z",
    });
    expect(readdirSync(episodes.dir).sort()).toEqual(["2026-06-01.jsonl", "2026-06-02.jsonl"]);
  });

  it("多行正文往返无损 (换行不会被当成两条)", () => {
    const text = "第一行\n第二行\n\n第四行";
    episodes.append({ session: "s1", turn: 1, role: "user", text, at: "2026-06-01T00:00:00.000Z" });
    const all = episodes.all();
    expect(all.length).toBe(1);
    expect(all[0]?.text).toBe(text);
  });

  it("按时间升序返回, 支持 since / bySession", () => {
    episodes.append({
      id: "a",
      session: "s1",
      turn: 1,
      role: "user",
      text: "A",
      at: "2026-06-01T00:00:00.000Z",
    });
    episodes.append({
      id: "b",
      session: "s2",
      turn: 2,
      role: "user",
      text: "B",
      at: "2026-06-03T00:00:00.000Z",
    });
    episodes.append({
      id: "c",
      session: "s1",
      turn: 3,
      role: "user",
      text: "C",
      at: "2026-06-02T00:00:00.000Z",
    });
    expect(episodes.all().map((e) => e.id)).toEqual(["a", "c", "b"]);
    expect(episodes.since("2026-06-02T00:00:00.000Z").map((e) => e.id)).toEqual(["c", "b"]);
    expect(episodes.bySession("s1").map((e) => e.id)).toEqual(["a", "c"]);
    expect(episodes.count()).toBe(3);
  });

  it("同一 id 重复追加只算一次 (重放必须幂等)", () => {
    const e = episodes.append({
      session: "s1",
      turn: 1,
      role: "user",
      text: "唯一",
      at: "2026-06-01T00:00:00.000Z",
    });
    appendFileSync(join(episodes.dir, "2026-06-01.jsonl"), JSON.stringify(e) + "\n", "utf8");
    expect(episodes.count()).toBe(1);
  });

  it("坏行只跳过并记 warning, 其余行照常可读 (外部可编辑的日志不能一坏全废)", () => {
    episodes.append({
      session: "s1",
      turn: 1,
      role: "user",
      text: "好行",
      at: "2026-06-01T00:00:00.000Z",
    });
    appendFileSync(join(episodes.dir, "2026-06-01.jsonl"), "这不是 JSON\n", "utf8");
    appendFileSync(
      join(episodes.dir, "2026-06-01.jsonl"),
      JSON.stringify({ id: "x" }) + "\n",
      "utf8",
    );
    expect(episodes.all().length).toBe(1);
    expect(episodes.warnings().length).toBe(2);
  });

  it("非法输入在写入时拒绝 (空正文/坏时间戳/坏 id)", () => {
    expect(() => episodes.append({ session: "s", turn: 1, role: "user", text: "   " })).toThrow(
      /empty/,
    );
    expect(() =>
      episodes.append({ session: "s", turn: 1, role: "user", text: "x", at: "昨天" }),
    ).toThrow(/at/);
    expect(() =>
      episodes.append({ id: "../etc/passwd", session: "s", turn: 1, role: "user", text: "x" }),
    ).toThrow(/id/);
  });

  it("保留期: prune 按整天文件删除, 0 表示永久保留 (默认不动任何东西)", () => {
    const kept = new EpisodeStore({ root, retentionDays: 0 });
    kept.append({
      session: "s",
      turn: 1,
      role: "user",
      text: "很久以前",
      at: "2020-01-01T00:00:00.000Z",
    });
    expect(kept.prune("2026-06-01T00:00:00.000Z")).toBe(0);

    const pruned = new EpisodeStore({ root, retentionDays: 30 });
    pruned.append({
      session: "s",
      turn: 1,
      role: "user",
      text: "最近",
      at: "2026-05-31T00:00:00.000Z",
    });
    expect(pruned.prune("2026-06-01T00:00:00.000Z")).toBe(1);
    expect(pruned.all().map((e) => e.text)).toEqual(["最近"]);
  });
});
