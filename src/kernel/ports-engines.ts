// src/kernel/ports-engines.ts — 引擎侧端口 (嵌入 / 向量索引 / 派生索引同步面)。
//
// 为什么从 ports.ts 拆出 (2026-09-18): 这三组契约与"存储/检索/会话"那批端口的**读者不同** ——
// 它们的实现者是要接进来的引擎 (嵌入模型、ANN 索引、FTS 引擎), 而 ports.ts 的读者是
// 内核编排与宿主适配层。按读者拆文件后, 换引擎的人不必在读端口时翻过一堆无关契约。
//
// 引擎准入的硬条件 (ADR-020/ADR-023): 必须能"从真相全量重建", 且能自证"索引与真相一致"。
// 不满足这两条的实现不许进 src/storage/ 或 src/engines/。
import type { Awaitable } from "./ports.ts";

/**
 * 嵌入端口 (ADR-023 的向量侧): 把文本映射成定长向量, 用于语义相似/语义去重/向量召回。
 * 为什么先定义端口再谈引擎: 换模型 = 换一个实现 + 全量重嵌 (T3), 而不是改业务代码;
 * 索引侧必须记录 embedding 身份 (modelId + dim), 不符即重建。
 */
export interface Embedder {
  /** 身份串 (如 "lexical-v1" / "bge-m3@1024"): 进索引身份, 防止混用两种向量。 */
  readonly id: string;
  readonly dim: number;
  /** 批量嵌入 (顺序与输入一致)。 */
  embed(texts: readonly string[]): Awaitable<number[][]>;
  /**
   * 推荐的余弦下限 (**由各嵌入器按自己的分数分布标定**)。
   * 为什么必须由嵌入器声明: 不同模型的相似度尺度完全不同 —— 词汇级嵌入的同义改写约 0.2-0.5,
   * 而真语义模型同一对可能 0.7+; 用一个全局阈值必然有一边失效 (实测过)。
   */
  readonly floor?: number;
}

/**
 * 同步嵌入面。预步注入 (agent/pre-step) 是同步判定点, 不能等 IO ——
 * 本地实现 (哈希袋/常驻 ONNX) 可以直接满足它; 远端 API 类嵌入器做不到,
 * 那种情况走投影 (RetrieverProjection): 后台刷新向量, 预步读缓存 (见 architecture-v2 §3.3)。
 */
export interface SyncEmbedder extends Embedder {
  embedSync(texts: readonly string[]): number[][];
}

/** 能力探测: 只有 embedSync 存在的嵌入器才能进同步检索通道。 */
export function asSyncEmbedder(embedder: Embedder): SyncEmbedder | null {
  const candidate = embedder as Partial<SyncEmbedder>;
  return typeof candidate.embedSync === "function" ? (candidate as SyncEmbedder) : null;
}

/**
 * 向量索引端口 (ADR-023 的向量侧): 近邻检索必须能"换引擎 + 全量重建"。
 * 默认实现是内存线性扫描 (LinearVectorIndex, 见 src/retrieval/vector.ts);
 * 规模上来后换成 sqlite-vec / LanceDB / Qdrant —— 只实现这个端口, 检索层不改。
 * 身份 (embedderId/dim) 必须进索引: 换模型就得重建, 不许混用 (HippoRAG 的 index_manifest 同款)。
 */
export interface VectorIndex {
  readonly embedderId: string;
  readonly dim: number;
  /** 写入/更新 (幂等: 同 id 覆盖; 内容未变时不重复嵌入)。只吃 id+content 的廉价投影。 */
  upsert(docs: readonly IndexDoc[]): void;
  remove(id: string): void;
  clear(): void;
  /** 近邻检索: 返回 id + 余弦分 (降序)。 */
  search(query: string, limit: number): Array<{ id: string; score: number }>;
  size(): number;
  /**
   * 可选: 异步补齐向量 (异步嵌入器的投影)。
   * 同步检索 (预步注入) 只读投影; 宿主在注入前可带**硬时限**地 await 它, 没就绪就降级。
   */
  refresh?(): Promise<void>;
  /**
   * 可选: 提前登记"下一次要查的文本", 让 warm() 能在同一次限时窗口里把它一起嵌好。
   * 没有它也能工作, 只是**第一轮**查询注定没有语义召回 (查询向量要等下一轮才就绪)。
   */
  prime?(query: string): void;
  /** 可选: 投影是否已就绪 (未就绪时检索会记 degraded, 不静默)。 */
  readonly ready?: boolean;
}

/** 索引同步用的最简条目投影 (只要 id + 正文, 不做 relations/tags 的二次查询)。 */
export interface IndexDoc {
  id: string;
  content: string;
}

/**
 * 派生索引 (向量/FTS) 的同步面。为什么单独定义:
 * 按查询去"扫一批候选"在万级下必然漏 (这正是本项目实测到的 bug: 5000 条只索引到 519 条)。
 * 正确做法是"全量投影 + 版本号变更时才同步", 且投影必须是**廉价查询** (单条 SQL, 不 hydrate)。
 */
export interface IndexableSource {
  /** 全量投影 (单次查询; 必须排除 shadow, 但可包含 merged/expired 由索引层决定是否使用)。 */
  indexDocs(): IndexDoc[];
  /** 单调递增的写版本号: 变了才需要重新同步索引 (稳态查询零开销)。 */
  revision(): number;
}
