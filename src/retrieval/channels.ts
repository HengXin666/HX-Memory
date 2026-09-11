// retrieval/channels.ts — 召回通道的**取数**逻辑 (规则 / 全文 / 向量 / 标签 / 图扩展)。
//
// 为什么独立: 每个通道都是"从某个来源取一批候选并记下命中理由", 彼此完全独立;
// 而 hybrid.ts 关心的是**融合**(RRF)、去冗余(MMR)与预算裁剪。这两件事的变化原因不同 ——
// 加通道不该改融合逻辑, 调融合不该碰通道。拆开后 hybrid.ts 回到可通读的规模。
//
// 各通道的语义差异 (刻意不统一, 每条都有理由):
//   - rules: 保底通道, 不受覆盖率过滤影响 (规则是人工确认的, 不该被相关性筛掉);
//   - bm25: 走覆盖率门槛 (字面不重合的命中多半是噪声);
//   - vector: **不做**字面覆盖率过滤 —— "字面不重合但语义相近"正是它存在的意义;
//   - tag: 显式标签命中, 不做覆盖率过滤;
//   - graph: **不做**文本过滤 —— "结构相关但字面不相关"正是图通道的意义, 噪声由 perSeedCap 控制。
import type { Channel, RetrievalCapabilities, RetrievalRequest, VectorIndex } from "../kernel/ports.ts";
import type { MemoryEntry, RelationType } from "../kernel/types.ts";
import { termStreams } from "../kernel/cjk.ts";
import { voiceVariants } from "../kernel/voice.ts";
import type { RankedList } from "../kernel/ranking.ts";

/** 图扩展的边类型权重 (高的先扩展; 语义上更"同类"的关系排前面)。 */
export const GRAPH_EDGE_WEIGHT: Partial<Record<RelationType, number>> = {
  supersededBy: 0.9,
  supersedes: 0.9,
  sameAs: 0.9,
  instanceOf: 0.8,
  generalizes: 0.7,
  appliesTo: 0.6,
  contradicts: 0.5,
  relates: 0.4,
  mentions: 0.3,
  derivedFrom: 0.3,
  source: 0.2,
};

export interface QueryTerms {
  /** 去重后的查询词 (词流 + bigram 流)。 */
  terms: string[];
  /** 用于覆盖率计算的重词 (优先词流; 无词流时用 bigram)。 */
  weighted: string[];
}

export function queryTerms(text: string): QueryTerms {
  // 语音容错: 原形与归一形**都**进检索词 —— 记忆里存的可能是错写, 也可能是规范写法,
  // 只取一边就会漏召回 (实测语料里有 "绘话"/"密等" 这类词)。
  const all: string[] = [];
  const seen = new Set<string>();
  const words: string[] = [];
  const bigrams: string[] = [];
  for (const variant of voiceVariants(text)) {
    const streams = termStreams(variant);
    words.push(...streams.words);
    bigrams.push(...streams.bigrams);
  }
  for (const t of [...words, ...bigrams]) {
    if (seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }
  // 词流是"真正的词", 覆盖率以它为主; 没有词流 (纯 CJK 被切碎) 时退回 bigram。
  const weighted = words.length ? words : all;
  return { terms: all.slice(0, 64), weighted: weighted.slice(0, 32) };
}

export function coverage(text: string, terms: readonly string[]): number {
  if (!terms.length) return 0;
  const haystack = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (haystack.includes(t)) hit++;
  return hit / terms.length;
}

/** 每个通道取数所需的外部能力 (由 HybridRetriever 注入, 避免这里知道融合/缓存细节)。 */
export interface ChannelDeps {
  source: {
    query: (q: { kind?: string; tag?: string; limit?: number }) => MemoryEntry[];
    searchText: (text: string, limit: number) => MemoryEntry[];
    get: (id: string) => MemoryEntry | null;
    traverse: (fromId: string, type: string) => MemoryEntry[];
  };
  caps: RetrievalCapabilities;
  channelLimit: number;
  coverageFloor: number;
  graphHops: number;
  vectorIndex?: VectorIndex;
  enabled: (channel: Channel) => boolean;
  weightOf: (channel: Channel) => number;
  textOf: (e: MemoryEntry) => string;
  keep: (e: MemoryEntry) => boolean;
  qualifies: (e: MemoryEntry) => boolean;
  remember: (e: MemoryEntry) => MemoryEntry;
  addReason: (id: string, reason: string) => void;
  syncVectorIndex: () => void;
}

/** 依次执行全部启用通道, 返回各自的排名表与降级说明。 */
export function gatherChannels(
  deps: ChannelDeps,
  req: RetrievalRequest,
  text: string,
  terms: QueryTerms,
  candidateWindow: number,
): { ranked: RankedList[]; degraded: string[] } {
  const ranked: RankedList[] = [];
  const degraded: string[] = [];

  // ---- 通道 1: 已确认的跨项目规则 (保底通道; 不受覆盖率过滤影响) ----
  if (deps.enabled("rules")) {
    const rules = deps.source.query({ kind: "rule" }).filter((r) => r.scope === "global").filter(deps.keep);
    const scored = rules
      .map((r) => {
        const rel = terms.weighted.length ? coverage(deps.textOf(r), terms.weighted) : 0.5;
        return { r, rel };
      })
      .sort((a, b) => b.rel - a.rel)
      .slice(0, deps.channelLimit);
    for (const { r } of scored) {
      deps.remember(r);
      deps.addReason(r.id, "rules:confirmed-global");
    }
    ranked.push({
      channel: "rules",
      ids: scored.map((s) => s.r.id),
      weight: deps.weightOf("rules") * 1.5,
    });
  }

  // ---- 通道 2: 全文检索 (BM25) ----
  if (deps.enabled("bm25") && text.trim()) {
    const hits = deps.source.searchText(text, candidateWindow).filter(deps.keep);
    const qualified: MemoryEntry[] = [];
    const dropped: string[] = [];
    for (const e of hits) {
      deps.remember(e);
      if (deps.qualifies(e)) {
        qualified.push(e);
        deps.addReason(e.id, "bm25:" + deps.caps.engine);
      } else {
        dropped.push(e.id);
      }
    }
    for (const id of dropped) deps.addReason(id, "filtered:low-coverage");
    ranked.push({
      channel: "bm25",
      ids: qualified.slice(0, deps.channelLimit).map((e) => e.id),
      weight: deps.weightOf("bm25"),
    });
  }

  // ---- 通道 2b: 向量 (语义召回) ----
  if (deps.enabled("vector") && text.trim() && deps.vectorIndex) {
    deps.syncVectorIndex();
    // 异步嵌入器的投影: 触发后台补齐 (不 await —— 预步注入绝不等 IO);
    // 未就绪时明确记降级, 而不是静默地"这次没有语义召回"。
    if (typeof deps.vectorIndex.refresh === "function") {
      void deps.vectorIndex.refresh().catch(() => undefined);
      if (deps.vectorIndex.ready === false) {
        degraded.push("vector:projection-warming (异步嵌入器尚未补齐, 本轮仅字面召回)");
      }
    }
    const vectorIds: string[] = [];
    for (const hit of deps.vectorIndex.search(text, candidateWindow)) {
      const entry = deps.source.get(hit.id);
      if (!entry || !deps.keep(entry)) continue;
      deps.remember(entry);
      // 向量通道**不做**字面覆盖率过滤 —— "字面不重合但语义相近"正是它存在的意义。
      if (!vectorIds.includes(entry.id)) {
        vectorIds.push(entry.id);
        deps.addReason(entry.id, "vector:" + hit.score.toFixed(3));
      }
    }
    if (vectorIds.length) {
      ranked.push({ channel: "vector", ids: vectorIds, weight: deps.weightOf("vector") });
    }
  }

  // ---- 通道 3: 标签 ----
  if (deps.enabled("tag") && req.tags?.length) {
    const tagged: MemoryEntry[] = [];
    for (const tag of req.tags) {
      for (const e of deps.source.query({ tag, limit: candidateWindow })) {
        if (!deps.keep(e)) continue;
        deps.remember(e);
        if (!tagged.some((x) => x.id === e.id)) tagged.push(e);
        deps.addReason(e.id, "tag:" + tag);
      }
    }
    ranked.push({ channel: "tag", ids: tagged.map((e) => e.id), weight: deps.weightOf("tag") });
  }

  // ---- 通道 4: 图扩展 (种子 = 目前得分最高的若干条) ----
  if (deps.enabled("graph") && deps.graphHops > 0 && ranked.length) {
    const seeds = ranked
      .flatMap((l) => l.ids.slice(0, 5))
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .slice(0, 5);
    const graphIds: string[] = [];
    const perSeedCap = 3;
    const edges = (Object.keys(GRAPH_EDGE_WEIGHT) as RelationType[]).sort(
      (a, b) => (GRAPH_EDGE_WEIGHT[b] ?? 0) - (GRAPH_EDGE_WEIGHT[a] ?? 0),
    );
    for (const seedId of seeds) {
      let perSeed = 0;
      for (const type of edges) {
        for (const neighbor of deps.source.traverse(seedId, type)) {
          if (!deps.keep(neighbor) || perSeed >= perSeedCap) continue;
          deps.remember(neighbor);
          if (!graphIds.includes(neighbor.id)) {
            graphIds.push(neighbor.id);
            perSeed++;
          }
          // 图扩展**不做**文本覆盖率过滤: "结构相关但字面不相关"正是图通道存在的意义。
          // 噪声由 perSeedCap + RRF 的低排名 + 预算裁剪共同控制。
          deps.addReason(neighbor.id, "graph:" + type + ":" + seedId);
        }
      }
    }
    if (graphIds.length) {
      ranked.push({ channel: "graph", ids: graphIds, weight: deps.weightOf("graph") });
    }
  }

  return { ranked, degraded };
}
