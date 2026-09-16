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
import type {
  Channel,
  RetrievalCapabilities,
  RetrievalRequest,
  VectorIndex,
} from "../kernel/ports.ts";
import type { MemoryEntry, RelationType } from "../kernel/types.ts";
import { termStreams } from "../kernel/cjk.ts";
import { entityKeysOf } from "../kernel/entity.ts";
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
    /** 实体反查 (可选: 引擎没有实体倒排时该通道直接不出现)。 */
    byEntities?: (keys: readonly string[], limit?: number) => MemoryEntry[];
  };
  caps: RetrievalCapabilities;
  channelLimit: number;
  coverageFloor: number;
  graphHops: number;
  /** 实体通道的上限与强度门槛 (标定项; 见 ports.ts 的 EntityChannelOptions)。 */
  entityChannel: { maxIds: number; minShared: number; mode: "main" | "tier2" };
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
): { ranked: RankedList[]; degraded: string[]; tier2: RankedList[] } {
  const ranked: RankedList[] = [];
  // 第二梯队: 不与主榜单竞争分数的通道 (图扩展 / 实体反查)。见文件末尾的说明。
  const tier2: RankedList[] = [];
  const degraded: string[] = [];

  // ---- 通道 1: 已确认的跨项目规则 (保底通道; 不受覆盖率过滤影响) ----
  if (deps.enabled("rules")) {
    const rules = deps.source
      .query({ kind: "rule" })
      .filter((r) => r.scope === "global")
      .filter(deps.keep);
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
  //
  // 已知张力 (2026-09 实测, 待后续处理): 实体共现建出来的边是**主题邻居**而非**答案** ——
  // 建边后图候选的 gold 精确率实测只有 8.5% (50/588), 且带 secondary 目标的 6 个 case 上
  // 图扩展的次级召回增益为 +0.000 (那些目标字面本来就能命中)。
  // 但把图通道降为"仅兜底"会删掉设计能力 (conformance 明确要求: 从命中的种子出发,
  // 把字面不相关的邻居召回并给出可审计的 why), 因此本改动**只记录测量**, 不改默认行为。
  // 要动这条默认需要先有一套"必须靠边才能答对"的 case —— 当前 case 集不满足该前提。
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
      // 图扩展进**第二梯队**而不是主榜单。
      //
      // 为什么 (实测): 实体/标签共现建出的边是"主题邻居"而非"答案", 图候选的 gold 精确率
      // 只有 8.5% (50/588)。按 RRF 同权重参与竞争时, 它给主榜单里的条目二次计分,
      // 把词面-only 的高分条目挤下去: 全体 R@1 从 0.684 掉到 0.630。
      // 但它确实能拿到字面不可达的目标 (图专属 case 上 0.250 -> 0.750)。
      // 两个读数方向相反, 因此不是"开/关"的取舍, 而是**分层**:
      // 主榜单先按相关性排好, 图候选作为尾巴追加, 占独立配额 (见 hybrid.ts 的 graphTierQuota)。
      tier2.push({ channel: "graph", ids: graphIds, weight: deps.weightOf("graph") });
    }
  }

  // ---- 通道 5: 实体反查 (种子 = 字面命中的条目) ----
  //
  // 为什么它必须有, 而图扩展不够 (实测依据, docs/benchmark-review.md §二之二):
  //   entity_only case 的桥是"共享实体", 而 **104 条里只有 4 条把实体写在查询里** ——
  //   其余 100 条必须先从字面命中拿到种子, 再用种子的实体反查。这正是写入期建边做不到的:
  //   建边必须在不知道查询的情况下预先决定"哪几条相关", 而反查知道这一问命中了哪些实体。
  //   实测把共享实体的**全部**配对都建边 (442 条, 现状 3.3 倍) 也只把命中从 19/104 提到 22/104;
  //   瓶颈是检索期的图配额 (候选池平均 12.9 条、目标平均排第 8, 而配额只有 3)。
  //
  // 位置: 在图扩展**之后**、但进**主榜单** (ranked) 而不是第二梯队。
  //   - 在图之后: 图通道的种子口径因此完全不变 (它的种子取自 rules/bm25/vector/tag), 行为可对照;
  //   - 进主榜单: 尾巴配额够不到的排位 (第 8), 只有参与主排序才拿得到 —— 本轮改动的目的就在这里。
  //   代价是它可能挤掉词面命中, 因此权重是**标定出来的** (见 hybrid.ts 的 channelWeights 与 Agent Note)。
  if (deps.enabled("entity") && deps.source.byEntities && terms.terms.length) {
    const seeds = ranked
      .flatMap((l) => l.ids.slice(0, 5))
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .slice(0, 5);
    // 种子 → 实体键。种子条目可能自己没抽到实体 (纯中文陈述型), 那它对反查就没有贡献。
    const seedKeys = new Set<string>();
    for (const seedId of seeds) {
      const seed = deps.source.get(seedId);
      if (!seed) continue;
      for (const key of entityKeysOf(seed)) seedKeys.add(key);
    }
    if (seedKeys.size) {
      const shared = new Map<string, number>();
      for (const candidate of deps.source.byEntities([...seedKeys], candidateWindow)) {
        if (!deps.keep(candidate)) continue;
        deps.remember(candidate);
        // 命中几个种子实体 = 相关性; RRF 只吃排名, 所以顺序必须由这个计数决定。
        const hit = entityKeysOf(candidate).filter((k) => seedKeys.has(k)).length;
        if (hit > 0) shared.set(candidate.id, hit);
      }
      const { maxIds, minShared, mode } = deps.entityChannel;
      // 决定性排序: 共享实体多者在前, 同分按 id —— 不得依赖 SQL 返回顺序 (它是实现细节)。
      const ordered = [...shared.entries()]
        .filter(([, hit]) => hit >= minShared)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      if (ordered.length) {
        const ids = ordered.slice(0, maxIds).map(([id]) => id);
        for (const id of ids) deps.addReason(id, "entity:shared-" + (shared.get(id) ?? 0));
        // **必须截断**: 实测不截断时该通道的 RRF 质量足以把词面命中的金牌挤下去
        // (主 case H@1 0.807 → 0.509), 而它自己的收益只有 +0.09。
        // 两个出口: "main" = 与词面竞争主排序; "tier2" = 独立配额的尾巴 (与图通道同一修法)。
        // 选哪个是**测出来的**, 不是偏好 —— 见 Agent Note 的对照表。
        const list = { channel: "entity", ids, weight: deps.weightOf("entity") };
        if (mode === "tier2") tier2.push(list);
        else ranked.push(list);
      }
    }
  }

  return { ranked, degraded, tier2 };
}
