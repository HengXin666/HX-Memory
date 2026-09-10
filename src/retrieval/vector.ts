// retrieval/vector.ts — 默认向量索引: 内存线性扫描 (可换 sqlite-vec/LanceDB/Qdrant)。
//
// 定位: 让"语义召回"这条通道**默认就能跑**, 而不是等接上某个向量库才存在。
//   - 全量投影 + 增量嵌入: 由存储提供廉价投影 (indexDocs) 与写版本号 (revision),
//     变了才同步、只嵌新条目 —— 绝不按查询扫一批候选 (那样在万级下会静默漏索引);
//   - 身份自述: embedderId/dim 是索引身份 (ADR-023), 换模型必须新建索引而不是复用;
//   - 线性扫描: 千级条目下是亚毫秒级; 万级以上应该换 ANN 引擎 (同一个 VectorIndex 端口)。
//
// 诚实边界: 这不是向量数据库, 没有持久化、没有 ANN 索引、没有多进程共享 ——
// 它随时可以从真相重建 (派生数据), 这正是它可以被替换的前提。
import type { IndexDoc, SyncEmbedder, VectorIndex } from "../kernel/ports.ts";
import { cosine } from "./embedding.ts";
import { contentFingerprint } from "../kernel/hashing.ts";

interface VectorRecord {
  hash: string;
  vector: number[];
}

export interface LinearVectorIndexOptions {
  /** 嵌入器 (必须支持同步调用 —— 预步注入不能等 IO)。 */
  embedder: SyncEmbedder;
  /** 检索时的余弦下限 (默认 0.35): 低于它不算命中, 避免"什么都能召回"。 */
  floor?: number;
}

export class LinearVectorIndex implements VectorIndex {
  readonly embedderId: string;
  readonly dim: number;
  private readonly embedder: SyncEmbedder;
  private readonly floor: number;
  private readonly records = new Map<string, VectorRecord>();
  /** 统计 (可观测: 看得到"这次同步重嵌了几条")。 */
  private embeddedTotal = 0;

  constructor(opts: LinearVectorIndexOptions) {
    this.embedder = opts.embedder;
    this.embedderId = opts.embedder.id;
    this.dim = opts.embedder.dim;
    // 下限优先级: 显式配置 > 嵌入器自述 (已标定) > 保守默认。
    this.floor = opts.floor ?? opts.embedder.floor ?? 0.35;
  }

  get embeddedCount(): number {
    return this.embeddedTotal;
  }

  /**
   * 增量同步 (幂等): 只嵌"新增或内容变了"的条目, 淘汰已消失的条目。
   * 复杂度 O(投影条数) 次哈希比较 + O(变更条数) 次嵌入 —— 稳态下写入一条只嵌一条。
   */
  upsert(docs: readonly IndexDoc[]): void {
    const pending: Array<{ id: string; hash: string; text: string }> = [];
    // 新旧哈希对账: changed 里只留真正需要重嵌的 id。
    const changed = new Set<string>();
    for (const doc of docs) {
      const hash = contentFingerprint(doc.content);
      const existing = this.records.get(doc.id);
      if (existing && existing.hash === hash) continue;
      pending.push({ id: doc.id, hash, text: doc.content });
      changed.add(doc.id);
    }
    // 淘汰: 投影里不再出现的 id (撤回/删除)。只在"投影条数 < 索引条数"时才扫描。
    if (this.records.size > docs.length) {
      const alive = new Set(docs.map((d) => d.id));
      for (const id of this.records.keys()) if (!alive.has(id)) this.records.delete(id);
    }
    if (!pending.length) return;
    const vectors = this.embedder.embedSync(pending.map((p) => p.text));
    pending.forEach((item, index) => {
      const vector = vectors[index];
      if (!vector) return;
      this.records.set(item.id, { hash: item.hash, vector });
      this.embeddedTotal++;
    });
    void changed;
  }

  remove(id: string): void {
    this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
    this.embeddedTotal = 0;
  }

  size(): number {
    return this.records.size;
  }

  /** 近邻检索: 查询一次嵌入 + 线性扫描 (O(N·dim))。 */
  search(query: string, limit: number): Array<{ id: string; score: number }> {
    const trimmed = query.trim();
    if (!trimmed || !this.records.size) return [];
    const [queryVector] = this.embedder.embedSync([trimmed]);
    if (!queryVector) return [];
    const hits: Array<{ id: string; score: number }> = [];
    for (const [id, record] of this.records) {
      const score = cosine(queryVector, record.vector);
      if (score < this.floor) continue;
      hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(1, limit));
  }
}
