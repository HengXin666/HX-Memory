// storage/episode-store.ts — Episode 追加日志 (真相的一部分, ADR-018)。
//
// 布局: <root>/episodes/YYYY-MM-DD.jsonl —— 一天一个文件, 一行一个 episode (JSON)。
// 为什么是 JSONL 而不是 Markdown: episode 是**机器重放的输入** (T2 抽取重建), 不是给人读的记忆;
//   人读的那一层是 memory 条目 (Markdown)。JSON 逐行可追加、可流式读、不会与正文冲突。
// 不变量:
//   1. 追加写, 永不改写 (同一行重复追加时按 id 去重, 保证重放幂等);
//   2. 坏行只跳过并记 warning, 不让整个日志不可读 (fail-closed 但不要抛断整批);
//   3. 保留期可配置 (0 = 永久); prune 以"整天文件"为单位删除。
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Episode, EpisodeInput } from "../kernel/types.ts";
import type { EpisodeStore as EpisodeStorePort } from "../kernel/ports.ts";

export const EPISODES_DIR = "episodes";

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export interface EpisodeStoreConfig {
  root: string;
  /** 保留天数 (0/缺省 = 永久保留, prune 不删任何东西)。 */
  retentionDays?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isIso(value: string): boolean {
  return ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function episodeId(): string {
  return "ep" + randomUUID().replace(/-/g, "").slice(0, 16);
}

export class EpisodeStore implements EpisodeStorePort {
  private readonly root: string;
  private readonly retentionDays: number;
  private readonly skipped: string[] = [];

  constructor(config: EpisodeStoreConfig) {
    this.root = config.root;
    this.retentionDays = config.retentionDays ?? 0;
    mkdirSync(this.dir, { recursive: true });
  }

  /** 日志目录 (人可读位置; 备份/git 时按它取)。 */
  get dir(): string {
    return join(this.root, EPISODES_DIR);
  }

  /** 解析过程中被跳过的行 (可观测: 日志损坏不该是静默的)。 */
  warnings(): readonly string[] {
    return this.skipped;
  }

  append(input: EpisodeInput): Episode {
    const at = input.at ?? nowIso();
    if (!isIso(at)) throw new Error("invalid episode at: " + JSON.stringify(at));
    const id = input.id ?? episodeId();
    if (!ID_PATTERN.test(id)) throw new Error("invalid episode id: " + JSON.stringify(id));
    const text = String(input.text ?? "").replace(/\r\n?/g, "\n");
    if (!text.trim()) throw new Error("episode text cannot be empty");
    const turn = Number.isFinite(input.turn) ? Math.max(0, Math.floor(input.turn)) : 0;
    const episode: Episode = {
      id,
      session: String(input.session ?? ""),
      turn,
      role: input.role === "assistant" ? "assistant" : "user",
      text,
      at,
      ...(input.project ? { project: String(input.project) } : {}),
      ...(input.surface ? { surface: String(input.surface) } : {}),
    };
    appendFileSync(this.fileFor(at), JSON.stringify(episode) + "\n", "utf8");
    return episode;
  }

  all(): Episode[] {
    const seen = new Set<string>();
    const out: Episode[] = [];
    for (const file of this.files()) {
      for (const episode of this.readFile(file)) {
        if (seen.has(episode.id)) continue; // 重复追加 → 重放只算一次 (幂等)
        seen.add(episode.id);
        out.push(episode);
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  since(iso: string): Episode[] {
    return this.all().filter((e) => e.at >= iso);
  }

  bySession(session: string): Episode[] {
    return this.all().filter((e) => e.session === session);
  }

  count(): number {
    return this.all().length;
  }

  /**
   * 按保留期清理。以"整天文件"为单位 (与文件布局一致, 避免重写文件)。
   * 返回删除的 episode 数; retirementDays<=0 时是 no-op。
   */
  prune(now = nowIso()): number {
    if (this.retentionDays <= 0) return 0;
    const cutoff = new Date(Date.parse(now) - this.retentionDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let removed = 0;
    for (const file of this.files()) {
      const day = file.slice(file.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
      if (!DAY_PATTERN.test(day) || day >= cutoff) continue;
      removed += this.readFile(file).length;
      rmSync(file, { force: true });
    }
    return removed;
  }

  private fileFor(at: string): string {
    const day = at.slice(0, 10);
    if (!DAY_PATTERN.test(day)) throw new Error("invalid episode day: " + JSON.stringify(at));
    return join(this.dir, day + ".jsonl");
  }

  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(this.dir, name));
  }

  private readFile(file: string): Episode[] {
    const out: Episode[] = [];
    const content = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    for (const [index, line] of content.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.skipped.push("unparsable episode line " + (index + 1) + " in " + file);
        continue;
      }
      const episode = asEpisode(parsed);
      if (!episode) {
        this.skipped.push("invalid episode line " + (index + 1) + " in " + file);
        continue;
      }
      out.push(episode);
    }
    return out;
  }
}

/** 外部可编辑的日志必须 fail-closed 校验形状 (缺字段的 episode 会让重放产出半截记忆)。 */
export function asEpisode(value: unknown): Episode | null {
  if (typeof value !== "object" || value === null) return null;
  const e = value as Record<string, unknown>;
  const id = e.id;
  const session = e.session;
  const at = e.at;
  const text = e.text;
  const role = e.role;
  const turn = e.turn;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof session !== "string") return null;
  if (typeof at !== "string" || !isIso(at)) return null;
  if (typeof text !== "string") return null;
  if (role !== "user" && role !== "assistant") return null;
  return {
    id,
    session,
    turn: typeof turn === "number" && Number.isFinite(turn) ? turn : 0,
    role,
    text,
    at,
    ...(typeof e.project === "string" ? { project: e.project } : {}),
    ...(typeof e.surface === "string" ? { surface: e.surface } : {}),
  };
}
