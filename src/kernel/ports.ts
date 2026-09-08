// kernel/ports.ts — the Port interfaces. The kernel depends only on these.
// Implementation decisions (which harness, which storage) live in adapters/ + storage/.
//
// 端口必须是"有实现、可断言"的: FileBackend implements MemoryStore,
// GeneralizerService implements Generalizer, CodexAdapter implements HarnessAdapter。
// tests/s1/ports.test.ts 用类型断言钉住这层关系, 避免端口退化成装饰性文档。
import type {
  GeneralizationProposal,
  MemoryEntry,
  MemoryEntryInput,
  ProposalStatus,
  QueuedProposal,
  Query,
} from "./types.ts";

/** 同步 (FileBackend) 与异步 (未来的 SQLite/向量后端) 实现都能满足端口。 */
export type Awaitable<T> = T | Promise<T>;

export interface MemoryStore {
  add(entry: MemoryEntryInput): Awaitable<MemoryEntry>;
  get(id: string): Awaitable<MemoryEntry | null>;
  query(q: Query): Awaitable<MemoryEntry[]>;
  /** 全量读取 (不截断): 去重集回填等需要完整集合的调用点。 */
  all(): Awaitable<MemoryEntry[]>;
  /** Walk relations from an entry (e.g. supersedes chain expansion). */
  traverse(fromId: string, relationType: string): Awaitable<MemoryEntry[]>;
  update(id: string, patch: Partial<MemoryEntry>): Awaitable<void>;
  /** 撤回: 索引与真相文件都标记 shadow (可重建后依然不复活)。 */
  remove(id: string): Awaitable<void>;
}

/**
 * 同步查询面。Binder/RecallService 在注入前做**同步**检索 (pre-step 是同步判定点),
 * 因此它们的构造参数要求这个更窄的接口; 异步后端需要自带缓存层。
 */
export interface SyncMemoryStore {
  query(q: Query): MemoryEntry[];
}

export interface Capture {
  raw: string;
  at: string;
  project?: string;
}

export interface Recall {
  entries: MemoryEntry[];
  /** Advisory token budget hint for the harness injection point. */
  maxTokens?: number;
}

export interface SessionContext {
  id: string;
  project?: string;
  origin?: string; // "root" | "subagent" | ...
  header?: Record<string, unknown>;
}

export interface TurnData {
  text: string;
  at: string;
  role: "user" | "assistant";
}

/**
 * Pull 式 harness 端口 (Codex/CLI 这类"请求-响应"宿主)。
 * DSH 是事件驱动宿主, 走 HxMemoryRuntime + Binder + RecallService 的组合, 不实现此端口
 * (见 docs/architecture.md 的"两种接入形态")。
 */
export interface HarnessAdapter {
  readonly name: "dsh" | "codex" | "cli";
  /** What to inject at session start (guidance, not history). */
  onSessionStart(ctx: SessionContext): Promise<unknown>;
  /** Capture a finished turn into memory. */
  onTurnEnd(turn: TurnData): Promise<Capture[]>;
  /** Optional lightweight recall before a step. Return null to inject nothing. */
  onPreStep(step: { text: string; at: string }): Promise<Recall | null>;
  registerTools(registry: { define(name: string, fn: unknown): void }): void;
}

/** 推广端口: 提议 + 队列 + 人工确认。实现必须永不自动写 rule。 */
export interface Generalizer {
  /** Batch-abstract concrete lessons into candidate rules (never auto-confirm). */
  runBatch(sourceRun: string, candidates: MemoryEntry[]): Promise<QueuedProposal[]>;
  /** 取最近候选跑一批 (面板/工具的统一触发点)。 */
  runRecent(sourceRun: string, limit?: number): Promise<QueuedProposal[]>;
  listQueue(status?: ProposalStatus): QueuedProposal[];
  /** 人工确认 (异步: 存储端口允许异步后端)。 */
  confirm(id: string, by: string): Promise<{ ok: boolean; ruleId?: string; error?: string }>;
  reject(id: string): void;
}

/** 单簇抽象端口 (LLM 或启发式)。 */
export interface Abstractor {
  abstract(cluster: { theme: string; contents: string[]; sources: string[] }): Promise<{
    rule: string;
    confidence: number;
  }>;
}

export type { GeneralizationProposal };
