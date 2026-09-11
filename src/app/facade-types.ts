// app/facade-types.ts — MemoryFacade 的公开类型面与端口要求。
//
// 为什么独立成文件: 类型是**契约**, 实现是**编排**。契约的读者是宿主适配层 (它们只 import 类型),
// 实现的读者是维护检索/演化逻辑的人 —— 两类读者关系不大。分开后 facade.ts 只剩编排逻辑,
// 适配层也能只依赖类型文件 (不把实现拖进编译单元)。
//
// 本文件的类型必须与实现**逐字一致**: 它们是宿主 (DSH 工具 / MCP / CLI) 编译期的唯一契约。
import type { MemoryEntry, MemoryEntryInput, MemoryKind, MemoryScope, Query, RecallFeedback, Relation } from '../kernel/types.ts';
import type { Awaitable, Embedder, RetrievalHit } from '../kernel/ports.ts';
import type { Adjudicator } from '../evolution/adjudicator.ts';
import type { DigestBuilder } from './digest.ts';

export interface FacadeStore {
  add(entry: MemoryEntryInput): Awaitable<MemoryEntry>;
  get(id: string): Awaitable<MemoryEntry | null>;
  update(id: string, patch: Partial<MemoryEntry>): Awaitable<void>;
  remove(id: string): Awaitable<void>;
  all(): Awaitable<MemoryEntry[]>;
  query(q: Query): Awaitable<MemoryEntry[]>;
  traverse(fromId: string, relationType: string): Awaitable<MemoryEntry[]>;
  /** 全文检索面 (近邻裁决与"相关内容"用)。 */
  searchText(text: string, limit?: number): MemoryEntry[];
  /** 可选: "最近沉淀"视图 (面板用); 缺省时 Facade 用 all() 自行排序。 */
  recent?(limit?: number): Awaitable<MemoryEntry[]>;
  /**
   * 可选: always-on 选择所需的廉价投影 (单条 SQL, 不 hydrate)。
   * 有它时 alwaysOn() 走快路径 —— 这条路径在预步每轮都跑, 用 all() 会白付 hydrate 成本。
   */
  entrySummaries?(): Awaitable<
    Array<
      Pick<
        MemoryEntry,
        | "id"
        | "kind"
        | "content"
        | "scope"
        | "project"
        | "importance"
        | "status"
        | "confirmedBy"
        | "confirmedAt"
      >
    >
  >;
}

export interface RememberInput {
  content: string;
  kind?: MemoryKind;
  project?: string;
  scope?: MemoryScope;
  /** 溯源: 会话 id / 文件 / URL; 缺省 "facade"。 */
  source?: string;
  tags?: string[];
  entities?: string[];
  importance?: number;
  confidence?: number;
  /** 血缘: 本条由哪些 episode 抽取而来 (支撑抽取级重建)。 */
  derivedFrom?: string[];
  validAt?: string;
  relations?: Relation[];
}

export type RememberDecision =
  | "added"
  /** 近等价重述: 不重复落盘, 强化老条目并合并标签/实体。 */
  | "duplicate"
  /** 与老记忆相关: 落盘 + 自动建 relates 边。 */
  | "linked"
  /** 显式更新 (改为/不再/废弃...): 新条目 supersedes 旧的, 旧的置 superseded (不删除)。 */
  | "superseded"
  /** 数字/极性矛盾且无更新信号: 两边都保留 + 双向 contradicts 边 (等人/LLM 裁决)。 */
  | "contradicted";

export interface RememberResult {
  entry: MemoryEntry;
  decision: RememberDecision;
  /** duplicate/link 的目标条目。 */
  targetId?: string;
  similarity?: number;
}

export interface RecallResponse {
  hits: RetrievalHit[];
  /** 已格式化的注入块 (空串 = 不注入)。 */
  injected: string;
  tokens: number;
  degraded: string[];
}

/** agent 对召回的**负面**标注原因 (没有"有用"这一类 —— 好的不记)。 */
export type RecallReason = "irrelevant" | "wrong";

export interface FlagResult {
  ok: boolean;
  /** ok:false 时给原因 (如 not-found)。 */
  error?: string;
  /** 累加后的标注计数。 */
  feedback?: RecallFeedback;
  /** 达阈值时产出的 review 提议 id (只提议, 不自动改记忆)。 */
  proposed?: string | null;
}

export interface ReinforceReport {
  reinforced: string[];
  skipped: Array<{ id: string; reason: "not-active" | "coalesced" }>;
}

export interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
  projects: string[];
  rules: number;
  /** 引擎自述 (索引可用性/降级原因), 有则带上。 */
  index?: unknown;
}

export interface FacadeOptions {
  /** 裁决用的近邻数 (0 = 关闭去重与自动建边)。 */
  neighborLimit?: number;
  /** 注入块的标题。 */
  injectionTitle?: string;
  now?: () => string;
  /** 可选嵌入器: 有则启用语义兜底去重 (换说法也能认出重复)。 */
  embedder?: Embedder;
  /** 语义判重的阈值 (默认 0.95; 越高越保守)。 */
  semanticDuplicateFloor?: number;
  /** 关闭自动演化 (取代/冲突标记): 只做去重与建边。可传函数以实时读取设置。 */
  autoEvolve?: boolean | (() => boolean);
  /** 单次写入最多建几条结构关联边 (默认 3; 0 = 关闭)。 */
  maxStructuralLinks?: number;
  /**
   * 冲突裁决器 (可选): 对"数字/极性矛盾但没有显式更新信号"的邻居做裁决。
   * 默认用确定性启发式 (heuristicAdjudicator); 宿主有模型时可换成 LLM 实现。
   * 语义: supersede → 取代; duplicate → 强化; keep-both → 两条并存 + contradicts 边。
   */
  adjudicator?: Adjudicator;
  /** 摘要构建器 (可选): 默认确定性启发式; 宿主有模型时可换成 LLM 润色版。 */
  digestBuilder?: DigestBuilder;
  /**
   * 推广服务 (可选): 唯一用途是"坏评超标的记忆"产出人审提议。
   * 缺省时标注照常落盘, 只是不产生提议 (治理能力可降级, 数据不丢)。
   */
  generalizer?: GeneralizerBridge;
}

/** 只依赖 Facade 需要的那一个方法 (避免 app 层硬依赖 generalize 的实现细节)。 */
export interface GeneralizerBridge {
  enqueueProposal(input: {
    rule: string;
    covers?: string[];
    confidence?: number;
    sourceRun?: string;
  }): { id: string } | Promise<{ id: string }>;
}

