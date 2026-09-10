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

/** 硬冲突: 数字不一致 或 极性相反 (一个说做, 一个说别做)。 */
export function hardConflict(a: string, b: string): boolean {
  const na = numbersIn(a);
  const nb = numbersIn(b);
  if (na.size || nb.size) {
    const same = na.size === nb.size && [...na].every((n) => nb.has(n));
    if (!same) return true;
  }
  return hasNegation(a) !== hasNegation(b);
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
  // 与字面去重同一道证据门: 候选太短 (词太少) 时向量相似度极不稳定, 不许吞并 (只允许建边)。
  if (opts.semanticSimilarity && candidateTokens.size >= (opts.minEvidenceTokens ?? 5)) {
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

  if (
    best &&
    best.coverage >= supersedeFloor &&
    candidateTokens.size >= (opts.minEvidenceTokens ?? 5)
  ) {
    const target = best.entry;
    const signal = hasUpdateSignal(candidate.content, opts.updateSignals);
    const timeOk = candidate.ts === undefined || candidate.ts.validAt >= target.ts.validAt;
    const kindOk = target.kind === candidate.kind;
    // 目标不是 rule (规则只能由人改), 且四条同时成立才自动取代。
    if (signal && timeOk && kindOk && target.kind !== "rule") {
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
