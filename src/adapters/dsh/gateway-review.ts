// adapters/dsh/gateway-review.ts — review 队列 / 被标注记忆的**投影** (纯函数 + 视图形状)。
//
// 为什么拆出来: gateway 是"薄投影层", 但两条投影各自带着取舍 (建议动作怎么暴露、
// 坏评怎么排序、裁剪上限), 而 gateway.ts 已经贴着 400 行上限 (verify-structure 会拦)。
// 与 gateway-observability.ts 同一个理由, 只是分属不同关注点 (那是账本, 这是人审面)。
//
// 关键契约: 投影只做**形状转换与有界裁剪**, 不改变语义 —— 排序口径、阈值判定仍然只有
// 一处 (kernel/feedback.ts 的 qualityFactor/badCount), 这里不复制任何判定逻辑。
import type { MemoryEntry } from "../../kernel/types.ts";
import { badCount, qualityFactor } from "../../kernel/feedback.ts";
import type { QueuedProposal } from "../../generalize/service.ts";

/** 一条被 agent 标注过 (负面) 的记忆 —— 面板展示 "bad / 曝光", 让拖后腿的条目可查。 */
export interface FlaggedMemoryView {
  id: string;
  kind: string;
  content: string;
  /** 曝光次数 (reinforcement): 阈值的分母。 */
  exposure: number;
  /** 当前质量因子 0..1 (排序实际用的值)。 */
  quality: number;
  /** 召回了但不相关 (检索/排序问题)。 */
  irrelevant: number;
  /** 内容与事实不符或已过时 (内容问题, 需人审改写)。 */
  wrong: number;
}

/** 面板人审提议时展开的一条实例 (被 covers 引用的原文)。 */
export interface ReviewEntryView {
  id: string;
  kind: string;
  /** 截断到 1000 字: 人审要读的是判断依据, 不是全文转录。 */
  content: string;
  project?: string;
  scope: string;
  /** active / superseded / merged / expired / shadow —— 撤回过的实例也要如实标注。 */
  status: string;
  assertedAt: string;
}

export interface ReviewQueueView {
  id: string;
  status: "proposed" | "confirmed" | "rejected";
  rule: string;
  /**
   * 这条提议由哪些实例抽象而来。
   *
   * 为什么给 id **列表**而不是计数: 人审的判断对象是"它概括的那几条到底在说什么",
   * 一个 `covers: 3` 无法回答该不该确认 —— 实测用户看到 "covers 3 instance(s)" 时
   * 只能靠猜。id 保留是为了让展示层能追溯到条目本身 (面板再按 id 批量取内容)。
   */
  covers: string[];
  confidence: number;
  sourceRun: string;
  generatedAt: string;
  /** 建议动作 (confirm/rewrite/reject); 展示层据此区分"可直接确认"与"必须人工改写"。 */
  suggestedAction: "confirm" | "rewrite" | "reject";
  /**
   * true = 启发式占位草稿 (该簇没走 AI 抽象)。文本形如"经验: <主题> 相关的 N 条实例已沉淀",
   * 只说明"有一簇经验", 不含可确认的内容 —— 面板必须显式标出"需人工改写", 否则用户面对
   * 一整屏同形状的条目无法判断该点确认还是驳回 (实测真实困扰)。
   */
  drafted: boolean;
}

/** 队列行 → 面板视图。covers 给全量 id (不再压成计数)。 */
export function toReviewView(p: QueuedProposal): ReviewQueueView {
  return {
    id: p.id,
    status: p.status,
    rule: p.proposal.rule,
    // 实例 id 全给前端: 计数无法回答"这条提议该不该确认"; 一簇的 id 是有界集合。
    covers: [...p.proposal.covers],
    confidence: p.proposal.confidence,
    sourceRun: p.sourceRun,
    generatedAt: p.proposal.generatedAt,
    suggestedAction: p.proposal.suggestedAction,
    // 老队列行没有 drafted 字段 → false (未知不等于草稿: 不给历史提议扣帽子)。
    drafted: p.proposal.drafted === true,
  };
}

/**
 * 被 agent 标注过的记忆 (按坏评数倒序, 上限封顶)。
 *
 * 只做"过滤 + 投影 + 排序 + 裁剪": 坏评阈值判定在 kernel/feedback.ts, 这里不重新定义,
 * 否则面板看到的"哪些算坏"会与排序实际用的口径分叉。
 */
export function projectFlagged(rows: readonly MemoryEntry[], limit?: number): FlaggedMemoryView[] {
  return rows
    .filter((e) => e.feedback && badCount(e.feedback) > 0)
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      content: e.content.slice(0, 200),
      irrelevant: e.feedback?.irrelevant ?? 0,
      wrong: e.feedback?.wrong ?? 0,
      exposure: e.reinforcement ?? 0,
      quality: qualityFactor(e.feedback, e.reinforcement ?? 0),
    }))
    .sort((a, b) => b.irrelevant + b.wrong - (a.irrelevant + a.wrong))
    .slice(0, Math.min(100, Math.max(1, limit ?? 50)));
}
