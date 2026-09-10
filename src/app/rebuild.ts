// app/rebuild.ts — 分级重建 (见 docs/architecture-v2.md §3.2 / ADR-018)。
//
// 为什么重建要单独成服务: 记忆系统的"可迁移性"完全取决于"能不能从上游真相重来一遍"。
//   T1 索引重建: 真相文件 → 结构化/全文索引 (由 Rebuildable 引擎自己实现)
//   T2 抽取重建: episode 原文 → 记忆条目 (本文件; 换抽取器/改规则时用)
//   T3 嵌入重建 / T4 整体迁移: 依赖 T1/T2 的能力, 后续补
//
// T2 的语义 (关键, 也是它与"重新捕获"的区别):
//   - 相同抽取器重放 → 产出的 id 与当初一致 → 全部 unchanged (幂等, 不产生重复记忆);
//   - 换了抽取器 → 产出新条目, 而**原先由该 episode 抽出的、这次不再产出的条目被 supersede**
//     (不是删除: 真相文件里仍在, 历史可查, 只是默认不注入)。
import type { Episode, MemoryEntry, MemoryEntryInput } from "../kernel/types.ts";
import type {
  Awaitable,
  EpisodeStore,
  MemoryStore,
  Rebuildable,
  VerifyReport,
} from "../kernel/ports.ts";
import { captureTurn, nowIso, type CaptureOptions } from "../capture/engine.ts";

export type RebuildLevel = "T1" | "T2";

export interface RebuildReport {
  level: RebuildLevel;
  /** 处理的上游条目数 (episode 数 / 真相文件条目数)。 */
  scanned: number;
  created: number;
  /** 已存在且本次产出相同 → 未改动 (幂等证据)。 */
  unchanged: number;
  /** 被新版本取代的旧条目 (状态置 superseded, 不删除)。 */
  superseded: number;
  errors: string[];
  startedAt: string;
  finishedAt: string;
}

/** 抽取端口: episode → 候选记忆 (规则版 / LLM 版都要能实现)。 */
export interface EpisodeExtractor {
  extract(episode: Episode): Awaitable<MemoryEntryInput[]>;
}

/**
 * 默认抽取器: 复用捕获引擎的确定性规则。
 * 因为产出 id 由内容指纹决定, 所以"用同一个抽取器重放"天然幂等 —— 这是重建可反复执行的前提。
 */
export function captureExtractor(opts: CaptureOptions = {}): EpisodeExtractor {
  return {
    extract(episode) {
      const result = captureTurn(
        {
          text: episode.text,
          session: episode.session,
          ...(episode.project ? { project: episode.project } : {}),
          occurredAt: episode.at,
          episodeId: episode.id,
        },
        opts,
      );
      return result.entries;
    },
  };
}

export interface RebuildDeps {
  store: MemoryStore;
  episodes: EpisodeStore;
  extractor?: EpisodeExtractor;
}

export class RebuildService {
  private readonly store: MemoryStore;
  private readonly episodes: EpisodeStore;
  private readonly extractor: EpisodeExtractor;

  constructor(deps: RebuildDeps) {
    this.store = deps.store;
    this.episodes = deps.episodes;
    this.extractor = deps.extractor ?? captureExtractor();
  }

  /**
   * T2: 从 episode 原文重放抽取。
   * @param since 只重放该时间点之后的 episode (增量重建)
   * @param supersedeStale 旧抽取结果不再被产出时是否置为 superseded (默认 true)
   */
  async rebuildFromEpisodes(
    opts: { since?: string; supersedeStale?: boolean } = {},
  ): Promise<RebuildReport> {
    const startedAt = nowIso();
    const report: RebuildReport = {
      level: "T2",
      scanned: 0,
      created: 0,
      unchanged: 0,
      superseded: 0,
      errors: [],
      startedAt,
      finishedAt: startedAt,
    };
    const episodes = opts.since ? await this.episodes.since(opts.since) : await this.episodes.all();
    const existing = await this.store.all();
    const known = new Set(existing.map((e) => e.id));
    const byEpisode = new Map<string, MemoryEntry[]>();
    for (const entry of existing) {
      for (const episodeId of entry.derivedFrom ?? []) {
        const list = byEpisode.get(episodeId) ?? [];
        list.push(entry);
        byEpisode.set(episodeId, list);
      }
    }

    for (const episode of episodes) {
      report.scanned++;
      let fresh: MemoryEntryInput[];
      try {
        fresh = await this.extractor.extract(episode);
      } catch (error) {
        report.errors.push(`extract failed for ${episode.id}: ${String(error)}`);
        continue;
      }
      const producedIds = new Set<string>();
      for (const input of fresh) {
        const id = input.id;
        if (id && known.has(id)) {
          report.unchanged++;
          producedIds.add(id);
          continue;
        }
        const derivedFrom = [...new Set([...(input.derivedFrom ?? []), episode.id])];
        const entry = await this.store.add({ ...input, derivedFrom, ...(id ? { id } : {}) });
        known.add(entry.id);
        producedIds.add(entry.id);
        report.created++;
      }
      if (opts.supersedeStale === false) continue;
      const successor = [...producedIds][0];
      for (const old of byEpisode.get(episode.id) ?? []) {
        if (producedIds.has(old.id)) continue;
        if ((old.status ?? "active") !== "active") continue;
        const relations = [...(old.relations ?? [])];
        if (successor && !relations.some((r) => r.type === "supersededBy" && r.toId === successor)) {
          relations.push({ type: "supersededBy", toId: successor });
        }
        await this.store.update(old.id, {
          status: "superseded",
          ...(relations.length ? { relations } : {}),
        });
        report.superseded++;
      }
    }
    report.finishedAt = nowIso();
    return report;
  }

  /** T1: 委托给引擎自己的 rebuildFromTruth (引擎必须实现 Rebuildable 才有这个能力)。 */
  async rebuildIndex(): Promise<RebuildReport> {
    const startedAt = nowIso();
    const report: RebuildReport = {
      level: "T1",
      scanned: 0,
      created: 0,
      unchanged: 0,
      superseded: 0,
      errors: [],
      startedAt,
      finishedAt: startedAt,
    };
    const rebuildable = asRebuildable(this.store);
    if (!rebuildable) {
      report.errors.push("store does not implement Rebuildable (无法从真相重建索引)");
      report.finishedAt = nowIso();
      return report;
    }
    const before = (await this.store.all()).length;
    const rebuilt = await rebuildable.rebuildFromTruth();
    report.scanned = before;
    report.created = rebuilt;
    report.finishedAt = nowIso();
    return report;
  }

  /** 一致性自检 (委托给引擎; 引擎不支持时明确说不支持, 而不是假装通过)。 */
  async verify(): Promise<VerifyReport> {
    const rebuildable = asRebuildable(this.store);
    if (!rebuildable) {
      return { ok: false, truth: 0, index: 0, problems: ["store does not implement Rebuildable"] };
    }
    return await rebuildable.verify();
  }
}

/** 能力探测 (结构化类型守卫): 不具备重建能力的存储明确降级, 而不是运行时炸。 */
export function asRebuildable(store: unknown): Rebuildable | null {
  if (!store || typeof store !== "object") return null;
  const candidate = store as Partial<Rebuildable>;
  if (typeof candidate.rebuildFromTruth !== "function") return null;
  if (typeof candidate.verify !== "function") return null;
  return candidate as Rebuildable;
}
