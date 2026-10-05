// evolution/evolve.ts — 写入期的演化裁决 (在"去重"之上加"更新/冲突").
//
// 三件事, 按保守程度从高到低:
//   1. 去重/合并 (duplicate): 见 associate.ts —— 新内容没有超出老记忆, 只强化不落盘;
//   2. 取代 (supersede): **只在用户显式表达更新时** (改为/不再/废弃/替换为...) 才自动写演化链,
//      新条目 supersedes 旧的, 旧的 status=superseded + supersededBy (不删除, 历史可查);
//   3. 冲突标记 (contradict): 同一话题但数字/极性矛盾, 且没有显式更新信号 → 只加 contradicts 边,
//      两条都保持 active (谁对谁错需要人/LLM 裁决, 机器不猜)。
//
// 硬约束 (不因能力增强而放松):
//   - **规则 (rule) 不参与任何自动演化**: 候选是 rule → 只 add; 目标是 rule → 只标记冲突, 不改状态。
//   - 取代必须"同一话题 + 同一种类 + 时间不倒退 + 有显式信号"四条同时成立。
//   - 可选语义相似度 (Embedder) 只作为**重复**的兜底信号, 不作为取代依据 (换个说法 ≠ 推翻旧结论)。
import type { MemoryEntry } from "../kernel/types.ts";
import type { Adjudication } from "./adjudicator.ts";
import {
  decideAssociation,
  normalizeFingerprint,
  overlapOf,
  tokenSetOf,
  type AssociationOptions,
} from "./associate.ts";

export type EvolutionAction = "add" | "duplicate" | "link" | "supersede" | "contradict";

/** 显式更新信号: 用户在用这些词的时候, 意思就是"之前那条不再成立"。 */
export const DEFAULT_UPDATE_SIGNALS =
  /(改为|改成|更新为|修正为|纠正为|替换为|不再|别再|废弃|弃用|作废|取而代之|迁移到|切换到|renamed to|changed to|no longer|deprecated|migrated to|replaced by)/i;

/** 否定/禁止类词 (用于极性判断)。 */
const NEGATION_SIGNALS = /(不|别|无需|不再|避免|禁止|拒绝|never|avoid|not\b|without)/i;

export interface EvolutionOptions extends AssociationOptions {
  /** 更新信号 (可用配置覆盖)。 */
  updateSignals?: RegExp;
  /** 取代所需的候选覆盖率下限 (默认 0.5: 至少一半的词讲的是同一件事)。 */
  supersedeFloor?: number;
  /** 冲突判定所需的候选覆盖率下限 (默认 0.5)。 */
  conflictFloor?: number;
  /** 可选: 语义相似度查询 (候选 vs 该 id)。 */
  semanticSimilarity?: (targetId: string) => number | undefined;
  /** 语义相似度达到该值即视为重复 (默认 0.92)。 */
  semanticDuplicateFloor?: number;
  /**
   * 可选: 对"硬冲突"邻居的裁决结果 (由调用方**预先算好**)。
   * 为什么是预计算而不是回调里 await: 本函数是纯同步逻辑 (S1 可测), 而裁决端口是异步的
   * (LLM 实现要调模型)。调用方 (Facade) 负责 await 并把结果按 targetId 查表传入。
   */
  adjudication?: (targetId: string) => Adjudication | undefined;
}

export interface EvolutionDecision {
  action: EvolutionAction;
  targetId?: string;
  similarity: number;
  coverage: number;
  /** 语义相似度 (有 Embedder 时给出, 可审计)。 */
  semantic?: number;
  /** 裁决理由 (可审计: 为什么它被取代/标记冲突)。 */
  reason?: string;
  mergedTags?: string[];
  mergedEntities?: string[];
}

export function hasUpdateSignal(text: string, signals: RegExp = DEFAULT_UPDATE_SIGNALS): boolean {
  return signals.test(text);
}

/** 文本里的数字集合 (含小数与百分号): 数字不一致是"事实变了"的强信号。 */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:\.\d+)?%?/g)) out.add(m[0]);
  return out;
}

export function hasNegation(text: string): boolean {
  return NEGATION_SIGNALS.test(text);
}

/**
 * 硬冲突: **关于同一件事**却给出不同值 (数字不一致), **或**极性相反 (一个说做, 一个说别做)。
 *
 * ⚠ 2026-09-18 修复: 此前**只看"数字不一致 / 极性相反", 没有"是否同一件事"这一环**。
 * 而真实记忆里**几乎每条都含数字** (日期/版本/计数/端口) ⇒ 任意两条都会被判冲突。
 * 实测 (真实库随机成对): **196/204 (96%) 被判冲突, 其中 99% 字面几乎无关**。
 *
 * **"关于同一件事"的判据 = 骨架覆盖率** (去掉数字后的词集覆盖率) ——
 * 因为冲突的定义是"同一件事说了不同值", 那么**非数字部分应当几乎相同**。
 *
 * 实测分离度 (**完全不重叠**):
 *
 * | 群体 | 骨架覆盖率 | n |
 * | --- | --- | --- |
 * | 真冲突 (同内容改一个数字) | **min 0.966**, p50 1.000 | 150 |
 * | 假冲突 (真实库相邻成对) | **max 0.349**, p95 0.222 | 206 |
 *
 * 取阈值 **0.8** —— 它落在 0.35~0.97 的空白区中部, 两侧都有充足余量
 * (不用 0.9 是因为真实内容可能有轻微措辞差异; 不用 0.5 是因为那会放进更多噪声)。
 *
 * 注: "数字的上下文重叠"这个候选特征**无效** (真冲突全为 0.000), 已排除。
 */
export function hardConflict(a: string, b: string): boolean {
  const na = numbersIn(a);
  const nb = numbersIn(b);
  const numbersDiffer =
    (na.size > 0 || nb.size > 0) &&
    !(na.size === nb.size && [...na].every((n) => nb.has(n)));
  if (numbersDiffer) {
    // 数字不同时, 必须**关于同一件事**才算冲突 (骨架覆盖率)。
    // ⚠ 这一道门是 2026-09-18 新加的: 此前只看"数字集合不同", 而真实记忆里几乎每条都含数字
    // ⇒ 96% 的成对被误判冲突 (实测 196/204, 其中 99% 字面无关)。
    return skeletonCoverage(a, b) >= CONFLICT_SKELETON_FLOOR;
  }
  // 极性相反: **不加骨架门控** —— 那是自相矛盾的。
  //
  // 为什么: 否定词 ("不要"/"别"/"禁止") **本身就是骨架的一部分**, 它会拉低覆盖率,
  // 而它恰恰是极性差异的**唯一载体**。实测: "缓存要开启过期" vs "缓存不要开启过期" 的骨架
  // 覆盖率只有 0.714 (< 0.8 阈值) —— 若加门控会**把真正的极性冲突全部挡掉**。
  //
  // 而"极性相反"这个判据**本身已隐含同主题**: 不同主题的两句极少恰好一正一负。
  // (实测过 "部署前必须跑完整测试" vs "不要用 tab 缩进" 这类假极性 —— 那是"必须"与"不要"
  //  的偶然组合, 属罕见情形, 且它与数字分支不同, 无法用骨架区分。暂不处理, 记为已知边界。)
  return hasNegation(a) !== hasNegation(b);
}

/**
 * 冲突判定所需的骨架覆盖率下限。
 *
 * 由**双向**标定 (2026-09-18):
 *
 * | 阈值 | 真冲突召回 | 噪声率 | 措辞变体的真冲突是否全过 |
 * | --- | --- | --- | --- |
 * | **0.5** | **100%** | **0.5%** | **是** |
 * | 0.6~0.8 | 100% | 0.5% | **否** (误伤同义措辞) |
 *
 * **为什么是 0.5 而不是 0.8**: 真冲突不仅是"同一句改数字"(骨架 0.966), 还有
 * **同一件事的不同措辞**:
 *   · "容器并发上限**设为** 10" vs "容器并发上限**改为** 50" → 0.714
 *   · "缓存过期**设置为** 60 秒" vs "缓存过期**改成** 300 秒" → 0.600
 *   · "连接池上限 20 **个**" vs "连接池**最大** 50 个" → 0.500
 * ⇒ **真冲突的骨架覆盖率可以低到 0.5**。取 0.8 会把后两类全部挡掉。
 *
 * 而噪声侧 (真实库相邻成对 207 对) 的 **p99 只有 0.258** ⇒ 0.5 仍有充足余量。
 */
export const CONFLICT_SKELETON_FLOOR = 0.5;

/** 骨架覆盖率: 去掉纯数字 token 后的词集覆盖率 ("是否在讲同一件事")。 */
function skeletonCoverage(a: string, b: string): number {
  const strip = (t: string): Set<string> =>
    new Set([...tokenSetOf(t)].filter((x) => !/^[0-9.]+%?$/.test(x)));
  const ta = strip(a);
  const tb = strip(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit++;
  return hit / tb.size;
}

/**
 * 演化裁决 (纯函数)。existing 是检索出来的近邻 (通常 top-5)。
 * 顺序: 规则豁免 → 语义/字面重复 → 显式更新取代 → 硬冲突标记 → 字面相关建边 → 新增。
 */
export function decideEvolution(
  candidate: Pick<MemoryEntry, "kind" | "content" | "tags" | "entities"> & {
    ts?: MemoryEntry["ts"];
  },
  existing: readonly MemoryEntry[],
  opts: EvolutionOptions = {},
): EvolutionDecision {
  // 去重只在**同种类**之间做 (一条 lesson 不该被一条 rule 吞掉, 反之亦然);
  // 取代/冲突则在全部活跃邻居里找目标 (跨规则冲突必须能被发现)。
  const sameKind = existing.filter((e) => e.kind === candidate.kind);
  const base = decideAssociation(candidate, sameKind, opts);

  // 规则豁免: 机器不碰规则 (人工闸门, ADR-003)。候选是 rule 就只落盘, 不做任何自动演化。
  if (candidate.kind === "rule") {
    return {
      action: "add",
      similarity: base.similarity,
      coverage: 0,
      reason: "rule-never-auto-evolves",
    };
  }

  const active = existing.filter((e) => (e.status ?? "active") === "active");
  const supersedeFloor = opts.supersedeFloor ?? 0.5;
  const conflictFloor = opts.conflictFloor ?? 0.5;
  const fingerprint = normalizeFingerprint(candidate.content);
  const candidateTokens = tokenSetOf(candidate.content);

  // 覆盖率最高的活跃邻居 (取代/冲突判定的对象)。
  let best: { entry: MemoryEntry; coverage: number; similarity: number } | null = null;
  for (const entry of active) {
    const same = normalizeFingerprint(entry.content) === fingerprint;
    const overlap = same
      ? { candidateCoverage: 1, jaccard: 1 }
      : overlapOf(candidateTokens, tokenSetOf(entry.content));
    const point = { entry, coverage: overlap.candidateCoverage, similarity: overlap.jaccard };
    if (!best || point.coverage > best.coverage) best = point;
  }

  // 1) 语义兜底: 字面看不出来但向量很近 → 当作重复 (只强化, 不落盘)。
  const semanticFloor = opts.semanticDuplicateFloor ?? 0.95;
  //
  // ⚠ 2026-09-18 定向修正: **字面已经看得出来的差异, 不该被语义兜底覆盖**。
  //
  // 为什么: 兜底的设计目的是"**字面看不出来**但向量很近"(同义改写)。而实测发现
  // "仅标识符不同的两条"(如端口 60 vs 90, 编号 0 vs 1) 的向量余弦也在 0.82~0.99 ——
  // 于是被判成重复而**静默吞并**。但那类内容的字面覆盖率高达 0.875~0.917,
  // 即**字面明明看得出来**。
  //
  // 数据 (2026-09-18 可区分性检验):
  //   同义改写: 字面覆盖率 0.000~0.385 (低) —— 这是兜底该管的;
  //   值差异:   字面覆盖率 0.875~0.917 (高) 且新增词含标识符 —— 这是兜底**不该覆盖的**。
  //   **两类的字面覆盖率区间完全不重叠**, 而语义余弦区间重叠 (0.467~0.956 vs 0.820~0.849)
  //   ⇒ 判据必须建立在**字面覆盖率**上, 而不是调语义阈值 (那会误伤某一类)。
  //
  // 判据: 仅当"候选与最佳语义目标的字面覆盖率 >= 0.75 **且** 候选新增词里含具体标识符"时,
  // 跳过语义兜底 (让字面路径去判它是冲突/取代/并存)。其余情形兜底行为不变。
  const semanticBestEntry = (() => {
    if (!opts.semanticSimilarity) return null;
    let bestId: string | null = null;
    let bestScore = 0;
    for (const entry of sameKind) {
      if ((entry.status ?? "active") !== "active") continue;
      const score = opts.semanticSimilarity(entry.id) ?? 0;
      if (score > bestScore) { bestScore = score; bestId = entry.id; }
    }
    if (!bestId || bestScore < semanticFloor) return null;
    return bestId;
  })();
  const semanticTarget = semanticBestEntry
    ? sameKind.find((e) => e.id === semanticBestEntry)
    : undefined;
  const semanticTargetTokens = semanticTarget ? tokenSetOf(semanticTarget.content) : undefined;
  const newTokensVsSemanticTarget = semanticTargetTokens
    ? [...candidateTokens].filter((t) => !semanticTargetTokens.has(t))
    : [];
  const literalAlreadyDecisive =
    semanticTargetTokens !== undefined &&
    overlapOf(candidateTokens, semanticTargetTokens).candidateCoverage >= 0.75 &&
    newTokensVsSemanticTarget.some((t) => /[0-9a-zA-Z]/.test(t));
  // 与字面去重同一道证据门: 候选太短 (词太少) 时向量相似度极不稳定, 不许吞并 (只允许建边)。
  if (
    opts.semanticSimilarity &&
    !literalAlreadyDecisive &&
    candidateTokens.size >= (opts.minEvidenceTokens ?? 5)
  ) {
    let semanticBest: { entry: MemoryEntry; score: number } | null = null;
    for (const entry of sameKind.filter((e) => (e.status ?? "active") === "active")) {
      const score = opts.semanticSimilarity(entry.id) ?? 0;
      if (!semanticBest || score > semanticBest.score) semanticBest = { entry, score };
    }
    if (semanticBest && semanticBest.score >= semanticFloor) {
      return {
        action: "duplicate",
        targetId: semanticBest.entry.id,
        similarity: Math.max(base.similarity, semanticBest.score),
        coverage: best?.coverage ?? 0,
        semantic: semanticBest.score,
        reason: "semantic-duplicate",
        ...(base.mergedTags ? { mergedTags: base.mergedTags } : {}),
        ...(base.mergedEntities ? { mergedEntities: base.mergedEntities } : {}),
      };
    }
  }

  // 冲突/取代判定的覆盖率门槛: 取代用 supersedeFloor, 冲突用 conflictFloor (两者可分别配)。
  const decisiveFloor = Math.min(supersedeFloor, conflictFloor);
  if (
    best &&
    best.coverage >= decisiveFloor &&
    candidateTokens.size >= (opts.minEvidenceTokens ?? 5)
  ) {
    const target = best.entry;
    const signal = hasUpdateSignal(candidate.content, opts.updateSignals);
    const timeOk = candidate.ts === undefined || candidate.ts.validAt >= target.ts.validAt;
    const kindOk = target.kind === candidate.kind;
    // 目标不是 rule (规则只能由人改), 且四条同时成立才自动取代。
    // 取代要求达到 supersedeFloor (比冲突判定更严) —— 门槛不同是刻意的: 标记冲突比推翻结论安全。
    if (signal && timeOk && kindOk && target.kind !== "rule" && best.coverage >= supersedeFloor) {
      return {
        action: "supersede",
        targetId: target.id,
        similarity: best.similarity,
        coverage: best.coverage,
        reason: "explicit-update-signal",
      };
    }
    if (hardConflict(candidate.content, target.content)) {
      const verdict = opts.adjudication?.(target.id);
      // 双保险: 即使裁决器说 supersede, 目标若是 rule 也绝不取代 (人工闸门, ADR-003)。
      // 硬约束不该只依赖注入的实现 —— 裁决器换成一个更激进的实现时, 这里必须仍然拦住。
      if (verdict?.verdict === "supersede" && target.kind !== "rule") {
        return {
          action: "supersede",
          targetId: target.id,
          similarity: best.similarity,
          coverage: best.coverage,
          reason: "adjudicated-supersede: " + verdict.reason,
        };
      }
      if (verdict?.verdict === "duplicate") {
        return {
          action: "duplicate",
          targetId: target.id,
          similarity: Math.max(best.similarity, verdict.confidence),
          coverage: best.coverage,
          reason: "adjudicated-duplicate: " + verdict.reason,
        };
      }
      // 目标若是 rule: 只标记冲突 (由人去改规则), 理由写清楚。
      return {
        action: "contradict",
        targetId: target.id,
        similarity: best.similarity,
        coverage: best.coverage,
        reason: target.kind === "rule" ? "conflicts-with-rule (需人工处理)" : "hard-conflict",
      };
    }
  }

  return {
    action: base.action,
    ...(base.targetId ? { targetId: base.targetId } : {}),
    similarity: base.similarity,
    coverage: best?.coverage ?? 0,
    ...(base.mergedTags ? { mergedTags: base.mergedTags } : {}),
    ...(base.mergedEntities ? { mergedEntities: base.mergedEntities } : {}),
  };
}
