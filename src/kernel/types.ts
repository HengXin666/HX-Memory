// kernel/types.ts — domain types only. This module MUST NOT import any
// harness (DSH/Codex) or storage driver. Violations are architecture bugs.

export type MemoryKind =
  "fact" | "preference" | "event" | "decision" | "lesson" | "rule" | "pattern" | "context";

export type MemoryStatus =
  | "active"
  /** 被更新版本取代 (演化链上仍可查, 默认不注入)。 */
  | "superseded"
  /** 被合并进另一条 (mergedFrom 留痕, 默认不注入)。 */
  | "merged"
  /** 衰减过期 (可逆: 不删除, 命中可复活)。 */
  | "expired"
  /** 人工撤回 (持久, 重建不复活)。 */
  | "shadow";

export type MemoryScope = "project" | "agent" | "global";

export type RelationType =
  | "relates"
  | "supersedes"
  | "supersededBy"
  | "generalizes"
  | "appliesTo"
  | "source"
  // ---- v2: 关联性 (由 LinkService / EvolutionService 写入) ----
  /** 条目 → 实体: 该条目提到了某实体 (实体用规范化名字作 id)。 */
  | "mentions"
  /** 两记忆互相矛盾 (保留双方, 由人/裁决器决定谁胜出)。 */
  | "contradicts"
  /** 别名/同义 (合并后指向代表条目)。 */
  | "sameAs"
  /** 规则 ← 实例 (generalizes 的反向指针, 便于从规则直达实例)。 */
  | "instanceOf"
  /** 血缘: 本条由哪些 episode 抽取而来 (支撑全量重放)。 */
  | "derivedFrom";

/** Relation always carries a direction (from → to). */
export interface Relation {
  type: RelationType;
  toId: string;
  weight?: number;
}

export interface Timestamps {
  /** When the fact is valid (temporal validity). */
  validAt: string;
  /** When the record was asserted (write time). */
  assertedAt: string;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  /** Provenance: session id / file path / URL. Every entry must be auditable. */
  source: string;
  scope: MemoryScope;
  /** Owning project name when scope:project; absent for agent/global. */
  project?: string;
  ts: Timestamps;
  status?: MemoryStatus;
  relations?: Relation[];
  /** Confirmation record for kind:"rule" (human gate). Machine proposals must NOT set this. */
  confirmedBy?: string;
  confirmedAt?: string;
  /** AI 结构化标签 (进入 SQLite tags 索引, 支持按 tag 召回)。可选: 启发式/未结构化时缺省。 */
  tags?: string[];
  /** AI 结构化摘要 (可选增强, 不替代原文; truth-in-files 仍以 content 为准)。 */
  structured?: { summary: string; points: string[] };

  // ---- v2: 关联性与演化 (全部可选; 缺省时行为与 v1 完全一致) ----
  /** 抽取出的实体 (规范化名), 用于建边 (mentions) 与图扩展召回。 */
  entities?: string[];
  /** 重要性 1..10 (缺省视为中性 5): 影响排序与整合优先级。 */
  importance?: number;
  /** 置信度 0..1 (缺省 0.7): 低置信条目排序降权, 但不被丢弃。 */
  confidence?: number;
  /** 强化次数: 被检索命中并注入的次数 (对数增益, 避免霸榜)。 */
  reinforcement?: number;
  /** 最近一次命中时间 (衰减基线; 缺省用 validAt)。 */
  lastHitAt?: string;
  /** TTL: 到期视为过期 (默认只给 event/context 类; 过期不删除)。 */
  expiresAt?: string;
  /** 血缘: 由哪些 episode 抽取而来 (支撑"换抽取器 → 全量重放")。 */
  derivedFrom?: string[];
  /** 合并来源: 被合并进本条目的旧条目 id (可回溯, 可撤销合并)。 */
  mergedFrom?: string[];
  /**
   * 负面召回标注 (agent 自评)。**只记坏的**: 好的不记 —— 沉默是默认且期望的状态。
   * 逼 agent 对每条召回都表态会造成义务感, 它会为交差而编造评价 (噪声比无信号更糟)。
   * 两类分开计数是因为它们导向不同修法: irrelevant → 调检索/排序权重; wrong → 内容要改写。
   * 质量公式用 bad/reinforcement (后者是曝光分母)。见 kernel/feedback.ts。
   */
  feedback?: RecallFeedback;
}

/** agent 对召回质量的**负面**标注计数。 */
export interface RecallFeedback {
  /** 召回了但不相关 (检索/排序问题)。 */
  irrelevant: number;
  /** 内容与事实不符或已过时 (内容问题, 需人审改写)。 */
  wrong: number;
}

/**
 * Episode: 一轮原始对话 (用户输入 / 助手输出), 追加写, 永不改写。
 *
 * 为什么它必须在真值层: 记忆是"抽取"的产物, 抽取器一定会升级 (正则 → LLM → 下一代)。
 * 只存抽取结果的话, 升级时只能对已经损失过一次信息的结果再抽一遍;
 * 存原文才能做 T2 级重建 (重放抽取), 这也是"全量数据重建"能覆盖到最上游的前提。
 */
export interface Episode {
  id: string;
  session: string;
  /** 会话内轮次序号 (单调递增, 重放顺序依据)。 */
  turn: number;
  role: "user" | "assistant";
  text: string;
  at: string;
  project?: string;
  /** 哪个宿主捕获的 (dsh / claude / codex / mcp / cli)。 */
  surface?: string;
}

/** Episode 写入入参 (id/at 可缺省)。 */
export type EpisodeInput = Omit<Episode, "id" | "at"> & { id?: string; at?: string };

/** Store 写入入参: id/ts 可缺省 (由存储层补齐)。 */
export type MemoryEntryInput = Omit<MemoryEntry, "id" | "ts"> & {
  id?: string;
  ts?: Partial<Timestamps>;
};

export interface Query {
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  tag?: string;
  /** Slice at a validity instant; answers "what was true at T". */
  at?: string;
  /** Filter by owning project (only meaningful with scope:project). */
  project?: string;
  limit?: number;
  /** 默认 false: shadow (已撤回) 条目不参与检索。 */
  includeShadow?: boolean;
}

export interface GeneralizationProposal {
  /** Candidate global rule text. */
  rule: string;
  /** Concrete instances this rule was abstracted from. */
  covers: string[];
  confidence: number;
  suggestedAction: "confirm" | "rewrite" | "reject";
  generatedAt: string;
}

export type ProposalStatus = "proposed" | "confirmed" | "rejected";

/**
 * 一次推广批次的**可观测报告** (面板要回答"这次到底做了什么 / 为什么没效果")。
 *
 * 为什么必须落这份数据: 只回一个 proposed 计数时, 用户看到 "0 条提议" 分不清是
 * "没有候选" / "候选都被已提议覆盖" / "聚类没命中主题" / "AI 抽象降级成草稿" ——
 * 于是只能得出"这个功能没用"的结论。报告把漏斗的每一段暴露出来。
 */
export interface GeneralizationRunReport {
  /** 本次批次开始时间 (ISO)。 */
  at: string;
  /** 进入批次的候选条目数 (lesson/pattern/decision)。 */
  considered: number;
  /** 因已被队列里未驳回的提议覆盖而跳过的条目数。 */
  coveredSkipped: number;
  /** 实际形成主题簇的数量 (无主题信号的条目不进簇)。 */
  clusters: number;
  /** 本次新入队的提议数。 */
  proposed: number;
  /** 是否至少有一簇走了 AI 抽象 (false = 全部启发式草稿)。 */
  usedLlm: boolean;
  /** 耗时 (ms)。 */
  tookMs: number;
  /** 失败原因 (成功时不出现)。 */
  error?: string;
}

/** 推广子系统对面板/CLI 的状态视图。 */
export interface GeneralizationStatus {
  /** 是否接上了 AI 抽象器 (false = 只能产需要人工改写的草稿规则)。 */
  abstractor: boolean;
  /** 最近一次批次报告 (从未跑过则不出现)。 */
  lastRun?: GeneralizationRunReport;
  /** 队列按状态计数。 */
  queue: { proposed: number; confirmed: number; rejected: number };
}

/** One review-queue item: a machine/user proposal awaiting the human gate. */
export interface QueuedProposal {
  id: string;
  status: ProposalStatus;
  proposal: GeneralizationProposal;
  sourceRun: string;
}
