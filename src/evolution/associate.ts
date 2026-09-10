// evolution/associate.ts — 写入期的关联裁决 (纯函数, 确定性, 无 LLM)。
//
// 解决 v1 的两个真实缺陷:
//   1. 去重只有 sha256(全文): 换个说法重记一条 → 库里两条几乎一样的记忆;
//   2. 新记忆与老记忆之间没有任何关联: 检索只能靠字面, "相关内容"永远聚不起来。
//
// 做法: 对候选做**归一化指纹** (去标点/空白/大小写/全半角) + 与近邻算词集 Jaccard:
//   - 指纹相同            → duplicate (等价重述): 不重复落盘, 强化老条目并合并标签/实体;
//   - 相似度 >= mergeFloor → duplicate (近等价): 同上, 保留双方的标签/实体并集;
//   - 相似度 >= linkFloor  → add + relate (自动建边, 权重 = 相似度);
//   - 否则                → add (独立条目)。
//
// 诚实边界: 这是**字面**相似度, 不是语义相似度; 改写得足够彻底就认不出来 (需要 Embedder 通道)。
// 因此它只做"保守的重复抑制与建边", 不做"冲突消解"—— 后者 (UPDATE/MERGE/SUPERSEDE 裁决)
// 是 S2 的事, 且允许失败/可回滚。
import type { MemoryEntry } from "../kernel/types.ts";
import { termStreams } from "../kernel/cjk.ts";

/** 归一化指纹: 大小写/全半角/标点/空白 全部抹平, 只留"内容词序列"。 */
export function normalizeFingerprint(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

export interface AssociationOptions {
  /** 候选覆盖率 >= 该值视为重复 (新内容已被老记忆覆盖)。 */
  mergeFloor?: number;
  /** 词集 Jaccard >= 该值视为相关 (自动建边)。 */
  linkFloor?: number;
  /**
   * 判定"重复"所需的最少候选词数。
   * 短内容 ("上限 10") 与任意含相同词的记忆都可能 100% 覆盖 —— 证据不足时只允许建边, 不允许吞并。
   */
  minEvidenceTokens?: number;
}

export type AssociationAction = "add" | "duplicate" | "link";

export interface AssociationDecision {
  action: AssociationAction;
  /** duplicate/link 的目标条目 id。 */
  targetId?: string;
  similarity: number;
  /** duplicate 时: 应当并入老条目的标签 (仅新增部分)。 */
  mergedTags?: string[];
  /** duplicate 时: 应当并入老条目的实体 (仅新增部分)。 */
  mergedEntities?: string[];
}

/**
 * 词集 (词 + bigram), 与检索索引同一套分词, 保证"像不像"与"搜不搜得到"口径一致。
 * 单字被剔除: 中文里的 "要/上/设" 这类单字噪声大, 留在集合里会虚高覆盖率。
 */
export function tokenSetOf(text: string): Set<string> {
  const s = termStreams(text);
  const out = new Set<string>();
  for (const t of [...s.words, ...s.bigrams]) {
    if (t.length >= 2) out.add(t);
  }
  return out;
}

export interface Overlap {
  /** 候选的词有多少比例已被老条目覆盖 (1 = 候选没有新信息)。 */
  candidateCoverage: number;
  /** 交并比 (对称相似度)。 */
  jaccard: number;
}

export function overlapOf(candidateTokens: Set<string>, existingTokens: Set<string>): Overlap {
  let inter = 0;
  for (const t of candidateTokens) if (existingTokens.has(t)) inter++;
  const union = candidateTokens.size + existingTokens.size - inter;
  return {
    candidateCoverage: candidateTokens.size ? inter / candidateTokens.size : 0,
    jaccard: union ? inter / union : 0,
  };
}

/**
 * 裁决一次写入。existing 应当是"检索出来的近邻"(通常 top-5), 顺序代表相关度。
 * 纯函数: 同样的输入给同样的输出 (便于测试与回放)。
 *
 * 判定用 **候选覆盖率** (候选的词有多大比例已被老条目覆盖) 而不是纯 Jaccard:
 * 中文换个词的近义重述 Jaccard 只有 ~0.7, 但"新内容没有超出老记忆"这件事是确定的。
 * 反向 (候选比老条目更丰富) 不算重复 —— 新信息不能丢, 于是退化成"建边",
 * 真正的版本升级 (UPDATE/SUPERSEDE) 留给 S2 裁决 (见 docs/architecture-v2.md §4.3)。
 */
export function decideAssociation(
  candidate: Pick<MemoryEntry, "content" | "tags" | "entities">,
  existing: readonly MemoryEntry[],
  opts: AssociationOptions = {},
): AssociationDecision {
  const mergeFloor = opts.mergeFloor ?? 0.75;
  const linkFloor = opts.linkFloor ?? 0.3;
  const minEvidence = opts.minEvidenceTokens ?? 5;
  const fingerprint = normalizeFingerprint(candidate.content);
  const candidateTokens = tokenSetOf(candidate.content);

  let bySimilarity: { entry: MemoryEntry; similarity: number; coverage: number } | null = null;
  let byCoverage: { entry: MemoryEntry; similarity: number; coverage: number } | null = null;
  for (const e of existing) {
    if (e.status && e.status !== "active") continue;
    const sameFingerprint = normalizeFingerprint(e.content) === fingerprint;
    const overlap = sameFingerprint
      ? { candidateCoverage: 1, jaccard: 1 }
      : overlapOf(candidateTokens, tokenSetOf(e.content));
    const similarity = sameFingerprint ? 1 : overlap.jaccard;
    const point = { entry: e, similarity, coverage: overlap.candidateCoverage };
    if (!bySimilarity || similarity > bySimilarity.similarity) bySimilarity = point;
    if (!byCoverage || overlap.candidateCoverage > byCoverage.coverage) byCoverage = point;
  }

  // 1) 新内容已被某条老记忆覆盖 → 重复 (强化老条目, 合并新增的标签/实体)。
  //    证据不足 (候选太短) 时不允许吞并 —— 那会把"上限 10"这类短句误判成任何含"上限"的记忆的重复。
  const hasEvidence = candidateTokens.size >= minEvidence;
  if (byCoverage && hasEvidence && byCoverage.coverage >= mergeFloor) {
    const target = byCoverage.entry;
    const mergedTags = (candidate.tags ?? []).filter((t) => !(target.tags ?? []).includes(t));
    const mergedEntities = (candidate.entities ?? []).filter(
      (t) => !(target.entities ?? []).includes(t),
    );
    return {
      action: "duplicate",
      targetId: target.id,
      similarity: Math.max(byCoverage.similarity, byCoverage.coverage),
      ...(mergedTags.length ? { mergedTags } : {}),
      ...(mergedEntities.length ? { mergedEntities } : {}),
    };
  }

  // 2) 与某条老记忆相关但不等价 → 落盘 + 建边 (信息不丢)。
  if (bySimilarity && bySimilarity.similarity >= linkFloor) {
    return {
      action: "link",
      targetId: bySimilarity.entry.id,
      similarity: bySimilarity.similarity,
    };
  }

  // 3) 全新内容 → 独立落盘。
  return { action: "add", similarity: bySimilarity?.similarity ?? 0 };
}
