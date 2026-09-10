// retrieval/vector-projected.ts — 异步嵌入器的"投影"向量索引 (architecture-v2 §3.3 / ADR-025)。
//
// 问题: 远端/ONNX 嵌入器是**异步**的, 而预步注入 (agent/pre-step) 的检索判定是同步的。
// 解法: 投影 —— 向量在后台算好放进内存, 同步检索只读缓存:
//   - upsert(docs): 同步登记 + 标记脏 (不阻塞调用方);
//   - refresh(): 异步把待嵌条目补齐 (宿主在注入前带**硬时限**地 await 它);
//   - search(query, limit): 同步; 查询向量没缓存时返回空并触发一次后台补算 (下次命中)。
//
// 朴素但正确的保证: **宁可这次少一条语义召回, 也不能阻塞对话**。
// 投影过期/未就绪时, 检索结果里会出现 degraded 说明 (不静默)。
import type { Embedder, IndexDoc, VectorIndex } from "../kernel/ports.ts";
import { cosine } from "./embedding.ts";

function quickHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36) + ":" + text.length;
}

export interface ProjectedVectorIndexOptions {
  embedder: Embedder;
  /** 余弦下限 (默认 0.35)。 */
  floor?: number;
  /** 单批嵌入条数 (远端 API 一次别塞太多)。 */
  batchSize?: number;
  /** 错误旁路 (远端失败不该打穿检索)。 */
  onError?: (error: unknown) => void;
}

export class ProjectedVectorIndex implements VectorIndex {
  readonly embedderId: string;
  readonly dim: number;
  private readonly embedder: Embedder;
  private readonly floor: number;
  private readonly batchSize: number;
  private readonly onError?: (error: unknown) => void;

  /** id → 待嵌文本 (登记即写入; 嵌好后仍保留文本用于哈希对账)。 */
  private readonly docs = new Map<string, { text: string; hash: string }>();
  private readonly vectors = new Map<string, number[]>();
  private readonly queryCache = new Map<string, number[]>();
  private readonly queryPending = new Set<string>();
  /** 待嵌 id (与 docs 对账得出, 避免每次全量扫描)。 */
  private dirty: string[] = [];
  private running: Promise<void> | null = null;
  /** 是否有一次补齐正在进行 (决定 ready: 正在补 = 未就绪)。 */
  private warming = false;

  constructor(opts: ProjectedVectorIndexOptions) {
    this.embedder = opts.embedder;
    this.embedderId = opts.embedder.id;
    this.dim = opts.embedder.dim;
    // 下限优先级: 显式配置 > 嵌入器自述 (已标定) > 保守默认。
    this.floor = opts.floor ?? opts.embedder.floor ?? 0.35;
    this.batchSize = Math.max(1, opts.batchSize ?? 32);
    if (opts.onError) this.onError = opts.onError;
  }

  /**
   * 投影是否就绪。注意必须把"正在补齐"也算未就绪 ——
   * 只看 dirty 的话, refresh() 一启动就把队列清空, 会谎报"已就绪" (真实踩过)。
   */
  get ready(): boolean {
    return this.dirty.length === 0 && !this.warming;
  }

  get progress(): { embedded: number; total: number } {
    return { embedded: this.vectors.size, total: this.docs.size };
  }

  /** 同步登记 (不阻塞); 变化的部分进入待嵌队列。 */
  upsert(entries: readonly IndexDoc[]): void {
    const alive = new Set<string>();
    for (const entry of entries) {
      alive.add(entry.id);
      const hash = quickHash(entry.content);
      const previous = this.docs.get(entry.id);
      if (previous && previous.hash === hash) continue;
      this.docs.set(entry.id, { text: entry.content, hash });
      this.vectors.delete(entry.id);
      if (!this.dirty.includes(entry.id)) this.dirty.push(entry.id);
    }
    if (this.docs.size > alive.size) {
      for (const id of [...this.docs.keys()]) {
        if (alive.has(id)) continue;
        this.docs.delete(id);
        this.vectors.delete(id);
      }
      this.dirty = this.dirty.filter((id) => alive.has(id));
    }
  }

  remove(id: string): void {
    this.docs.delete(id);
    this.vectors.delete(id);
    this.dirty = this.dirty.filter((d) => d !== id);
  }

  clear(): void {
    this.docs.clear();
    this.vectors.clear();
    this.queryCache.clear();
    this.queryPending.clear();
    this.dirty = [];
  }

  size(): number {
    return this.vectors.size;
  }

  /** 提前登记下一次要查的文本 (与 refresh 配合, 让首轮查询也能拿到语义召回)。 */
  prime(query: string): void {
    const trimmed = query.trim();
    if (!trimmed || this.queryCache.has(trimmed)) return;
    this.queryPending.add(trimmed);
  }

  /** 后台补齐待嵌条目 + 查询缓存; 返回的 promise 可被宿主带硬时限地 await。 */
  async refresh(): Promise<void> {
    if (this.running) return this.running;
    if (!this.dirty.length && !this.queryPending.size) return;
    this.warming = true;
    this.running = this.runOnce().finally(() => {
      this.warming = false;
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<void> {
    const pendingIds = this.dirty;
    this.dirty = [];
    const queries = [...this.queryPending];
    this.queryPending.clear();
    try {
      for (let i = 0; i < pendingIds.length; i += this.batchSize) {
        const batch = pendingIds.slice(i, i + this.batchSize);
        const texts = batch.map((id) => this.docs.get(id)?.text ?? "");
        const vectors = await this.embedder.embed(texts);
        batch.forEach((id, index) => {
          const vector = vectors[index];
          if (vector) this.vectors.set(id, vector);
          else if (this.docs.has(id)) this.dirty.push(id); // 没拿到的下轮再试
        });
      }
      if (queries.length) {
        const vectors = await this.embedder.embed(queries);
        queries.forEach((query, index) => {
          const vector = vectors[index];
          if (vector) this.queryCache.set(query, vector);
        });
      }
    } catch (error) {
      // 失败: 放回队列 (下次 refresh 再试), 并旁路通知 —— 不抛, 不阻塞检索。
      this.dirty.push(...pendingIds.filter((id) => this.docs.has(id)));
      for (const query of queries) this.queryPending.add(query);
      this.onError?.(error);
    }
  }

  /** 近邻检索 (同步): 查询向量未就绪时返回空并触发后台补算。 */
  search(query: string, limit: number): Array<{ id: string; score: number }> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    let queryVector = this.queryCache.get(trimmed);
    if (!queryVector) {
      // 先登记查询向量再判空: 否则"索引还空"时第一次检索会直接返回,
      // 查询永远不会进队列 → 投影永远暖不起来 (真实踩过)。
      if (!this.queryPending.has(trimmed)) {
        this.queryPending.add(trimmed);
        // 不 await: 后台算好供下次使用 (预步路径绝不等 IO)。
        void this.refresh().catch((error) => this.onError?.(error));
      }
      return [];
    }
    if (!this.vectors.size) return [];
    const hits: Array<{ id: string; score: number }> = [];
    for (const [id, vector] of this.vectors) {
      const score = cosine(queryVector, vector);
      if (score < this.floor) continue;
      hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }
}
