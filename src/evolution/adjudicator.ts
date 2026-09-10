// evolution/adjudicator.ts — 冲突裁决端口 + 确定性启发式默认实现。
//
// 为什么需要它: evolve.ts 的 decideEvolution 对"没有显式更新信号的矛盾"只标记 contradicts,
// 两条都保持 active —— 谁对谁错是刻意留给人或模型的裁决, 但那个裁决口一直不存在, 矛盾于是永久堆积。
// 本文件补上**可插拔端口** (Adjudicator) 与一个保守的默认实现:
//   - 端口让宿主模型 (LLM) 后续接入, 不需要改动内核与任何调用方;
//   - 启发式实现只裁决"能用证据说清楚"的情形, 说不清就 keep-both (交给人), 且 reason 必填可审计。
//
// 边界: 纯逻辑 (无 IO / 无宿主依赖 / 不读时钟 / 无随机), 同样输入必须同样输出。
// 规则豁免: 目标是 rule 时绝不 supersede (人工闸门, ADR-003), 最多回 keep-both 让人处理。
// importance 保留给 LLM 实现使用 (启发式不看它: 重要性不改变"谁更新", 只改变展示优先级)。
import type { MemoryEntry } from "../kernel/types.ts";
import { normalizeFingerprint, overlapOf, tokenSetOf } from "./associate.ts";
import { hardConflict, numbersIn } from "./evolve.ts";

export type AdjudicationVerdict = "supersede" | "keep-both" | "duplicate";

export interface AdjudicationInput {
  candidate: Pick<MemoryEntry, "kind" | "content" | "importance" | "confidence"> & {
    /** 候选的双时态。缺省时无法证明"更晚", 一律不取代 (保守)。 */
    ts?: MemoryEntry["ts"];
  };
  target: Pick<MemoryEntry, "id" | "kind" | "content" | "importance" | "confidence" | "ts">;
}

export interface Adjudication {
  verdict: AdjudicationVerdict;
  /** 对本裁决结论的置信度 (0..1), 不是条目的置信度。 */
  confidence: number;
  /** 必填且非空: 裁决依据 (进审计日志, 空理由视为 bug)。 */
  reason: string;
}

export interface Adjudicator {
  readonly id: string;
  adjudicate(input: AdjudicationInput): Promise<Adjudication>;
}

export interface HeuristicAdjudicatorOptions {
  /** 视为"文本几乎等价"的词集 Jaccard 下限 (默认 0.9)。 */
  duplicateFloor?: number;
  /** 判定"几乎等价"所需的最少词数 (太短的句子证据不足, 默认 4)。 */
  minEvidenceTokens?: number;
  /** 条目未给 confidence 时的缺省值 (默认 0.7, 与 MemoryEntry 注释一致)。 */
  defaultConfidence?: number;
}

/** 条目置信度 (缺省 0.7)。 */
function confidenceOf(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 三位小数: 让 confidence 与 reason 里的数字在不同引擎下稳定可比较。 */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 冲突证据的自然语言描述 (数字不一致优先, 否则是极性相反)。 */
function conflictDetail(candidateText: string, targetText: string): string {
  const candidateNumbers = [...numbersIn(candidateText)];
  const targetNumbers = [...numbersIn(targetText)];
  if (candidateNumbers.length || targetNumbers.length) {
    return (
      "数字不一致 (候选 " +
      (candidateNumbers.join("/") || "无") +
      " vs 目标 " +
      (targetNumbers.join("/") || "无") +
      ")"
    );
  }
  return "极性相反 (一方肯定, 一方否定)";
}

/** ISO 时间比较: 可解析就按毫秒, 否则退化为字符串序 (仍然确定)。 */
function compareValidAt(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb ? 0 : ta < tb ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 启发式裁决器 (默认实现)。判定顺序 (从"证据最强"到"证据不足"):
 *   1. 归一化指纹相同 → duplicate (纯重述, 与写入期去重同一口径);
 *   2. 同 kind + 数字/极性冲突 → 走取代的门槛链 (时间 / 置信度), 不满足就 keep-both;
 *      **冲突必须先于"近等价"判定**: "上限 10" 与 "上限 50" 词集重合度极高 (只差一个数字),
 *      若先比相似度就会把一次真实的更新误判成重复;
 *   3. 同 kind 且无冲突但文本几乎等价 (词集 Jaccard >= duplicateFloor) → duplicate;
 *   4. 其余一律 keep-both (含: 跨 kind、目标是规则、无冲突且不相似、时间倒退/相同、置信度更低)。
 * 顺序即优先级: 候选若是纯重述, 就没有"谁更新"的问题, 直接判重复。
 */
export function heuristicAdjudicator(opts: HeuristicAdjudicatorOptions = {}): Adjudicator {
  const duplicateFloor = opts.duplicateFloor ?? 0.9;
  const minEvidenceTokens = opts.minEvidenceTokens ?? 4;
  const defaultConfidence = opts.defaultConfidence ?? 0.7;

  return {
    id: "heuristic-adjudicator",

    async adjudicate(input: AdjudicationInput): Promise<Adjudication> {
      const { candidate, target } = input;
      const candidateConfidence = confidenceOf(candidate.confidence, defaultConfidence);
      const targetConfidence = confidenceOf(target.confidence, defaultConfidence);
      const sameKind = candidate.kind === target.kind;

      // 1) 重复: 归一化后完全相同 —— 候选没有新信息, 只强化目标。
      if (normalizeFingerprint(candidate.content) === normalizeFingerprint(target.content)) {
        return {
          verdict: "duplicate",
          confidence: 0.95,
          reason:
            "文本归一化后与目标 " + target.id + " 完全相同, 判定为重复 (候选不落盘, 只强化目标)",
        };
      }

      const conflicting = hardConflict(candidate.content, target.content);

      if (sameKind && conflicting) {
        // 2) 取代的硬门槛之一: 规则豁免 (规则只由人改); 跨 kind 的情形由末尾兜底 keep-both。
        if (target.kind === "rule") {
          return {
            verdict: "keep-both",
            confidence: 0.6,
            reason:
              "候选与目标 " +
              target.id +
              " 存在冲突 (" +
              conflictDetail(candidate.content, target.content) +
              "), 但目标是规则 (rule), 规则只由人工确认与修改, 机器不取代 (需人工处理)",
          };
        }

        // 3) 时间: 候选必须严格更晚 (时间倒退 / 时间相同都不够)。
        const candidateValidAt = candidate.ts?.validAt;
        if (candidateValidAt === undefined) {
          return {
            verdict: "keep-both",
            confidence: 0.6,
            reason:
              "候选与目标 " + target.id + " 存在冲突, 但候选缺少 validAt, 无法证明更晚, 不取代",
          };
        }
        const timeOrder = compareValidAt(candidateValidAt, target.ts.validAt);
        if (timeOrder === 0) {
          return {
            verdict: "keep-both",
            confidence: 0.6,
            reason:
              "候选与目标的 validAt 相同 (" +
              candidateValidAt +
              "), 无法判断谁更新, 两条并存待人工判断",
          };
        }
        if (timeOrder < 0) {
          return {
            verdict: "keep-both",
            confidence: 0.7,
            reason:
              "候选 validAt " +
              candidateValidAt +
              " 早于目标 " +
              target.ts.validAt +
              ", 时间倒退时不取代 (新说法未必更真)",
          };
        }

        // 4) 置信度: 候选不低于目标才允许取代。
        if (candidateConfidence + 1e-9 < targetConfidence) {
          return {
            verdict: "keep-both",
            confidence: 0.7,
            reason:
              "候选置信度 " +
              String(candidateConfidence) +
              " 低于目标 " +
              String(targetConfidence) +
              ", 证据更弱, 不取代",
          };
        }

        // 5) 四条同时成立: 同 kind + 冲突 + 更晚 + 置信度不低 → 取代。
        const margin = clamp01(candidateConfidence - targetConfidence);
        return {
          verdict: "supersede",
          confidence: round3(0.6 + 0.4 * margin),
          reason:
            "候选 validAt " +
            candidateValidAt +
            " 更晚且置信度 " +
            String(candidateConfidence) +
            " >= 目标 " +
            String(targetConfidence) +
            ", 同 kind (" +
            candidate.kind +
            ") 且 " +
            conflictDetail(candidate.content, target.content) +
            " → 取代目标 " +
            target.id,
        };
      }

      // 6) 无冲突: 只有"换个说法重述"才判重复。只在同 kind 内判定 ——
      //    同一段文字落在不同 kind 上是两类断言, 不该互相吞并。
      if (sameKind) {
        const candidateTokens = tokenSetOf(candidate.content);
        const targetTokens = tokenSetOf(target.content);
        if (candidateTokens.size >= minEvidenceTokens && targetTokens.size >= minEvidenceTokens) {
          const jaccard = overlapOf(candidateTokens, targetTokens).jaccard;
          if (jaccard >= duplicateFloor) {
            return {
              verdict: "duplicate",
              confidence: 0.9,
              reason:
                "同 kind (" +
                candidate.kind +
                ") 且无数字/极性冲突, 词集重叠 " +
                String(round3(jaccard)) +
                " >= " +
                String(duplicateFloor) +
                ", 与目标 " +
                target.id +
                " 几乎等价, 判定为重复",
            };
          }
        }
      }

      // 7) 其余: 证据不足, 两条并存等人工判断。
      const reason = !sameKind
        ? "种类不同 (候选 " +
          candidate.kind +
          " vs 目标 " +
          target.kind +
          "), 不自动取代, 两条并存待人工判断"
        : "未发现数字/极性冲突, 且与目标 " + target.id + " 的重合度不足以判定重复, 两条并存";
      return { verdict: "keep-both", confidence: sameKind ? 0.5 : 0.6, reason };
    },
  };
}
