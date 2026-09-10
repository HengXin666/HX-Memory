// retrieval/embedding.ts — 嵌入端口的默认实现与相似度工具。
//
// 为什么默认给一个**本地确定性**实现 (而不是必须配 API key):
//   1. 语义能力必须"默认可用"才能被测试、被降级验证 —— 否则永远是一条没人走过的分支;
//   2. 它是纯函数的词/bigram 哈希袋, 零依赖零成本, 中文可用 (与检索分词同源);
//   3. 真语义 (bge-m3/远端 API) 只是换一个 Embedder 实现 —— 上层代码一行不改 (ADR-023)。
//
// 诚实边界: 哈希袋向量抓的是**词汇重合**, 不是真正的语义 (同义改写仍可能漏)。
// 因此它只用于"近似重复的兜底"与"相关度排序的补充信号", 冲突裁决仍然靠显式规则 + 人工闸门。
import type { Embedder, SyncEmbedder } from "../kernel/ports.ts";
import type { MemoryEntry } from "../kernel/types.ts";
import { termStreams } from "../kernel/cjk.ts";

/** 稳定哈希 (FNV-1a 32bit): 同一段文本在任何进程/版本上落到同一维度。 */
function hash32(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface HashingEmbedderOptions {
  /** 维度 (越大冲突越少; 256 对本项目的记忆量级足够)。 */
  dim?: number;
  /** 身份串后缀 (换分词/加权策略时必须改, 否则索引会混用两种向量)。 */
  tag?: string;
}

export class HashingEmbedder implements SyncEmbedder {
  readonly id: string;
  readonly dim: number;
  /** 词汇袋区分度低 (实测同义 0.17 / 无关 0.08), 阈值放宽反而召回噪声, 故偏高。 */
  readonly floor = 0.35;

  constructor(opts: HashingEmbedderOptions = {}) {
    this.dim = Math.max(16, opts.dim ?? 256);
    this.id = "hashing-v1" + (opts.tag ? "+" + opts.tag : "");
  }

  /** 同步面 (预步注入可用)。 */
  embedSync(texts: readonly string[]): number[][] {
    return texts.map((text) => this.embedOne(text));
  }

  embed(texts: readonly string[]): number[][] {
    return this.embedSync(texts);
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const streams = termStreams(text);
    // 词流权重高于 bigram 流: 真正的词更能代表语义, bigram 只做召回兜底。
    const add = (token: string, weight: number): void => {
      const index = hash32(token) % this.dim;
      vector[index] = (vector[index] ?? 0) + weight;
    };
    for (const word of streams.words) add(word, 1);
    for (const bigram of streams.bigrams) add(bigram, 0.5);
    // L2 归一化: 之后点积即余弦, 长短文本可比。
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    return vector;
  }
}

/** 余弦相似度 (输入已归一化时退化为点积)。 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 计算"候选 ↔ 既有条目"的语义相似度表 (id → 余弦)。
 * 一次批量嵌入 (候选 + 邻居), 避免 N 次调用; 空输入返回空表。
 */
export async function semanticScores(
  embedder: Embedder,
  candidate: MemoryEntry,
  existing: readonly MemoryEntry[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!existing.length) return out;
  const vectors = await embedder.embed([candidate.content, ...existing.map((e) => e.content)]);
  const base = vectors[0];
  if (!base) return out;
  existing.forEach((entry, index) => {
    const other = vectors[index + 1];
    if (!other) return;
    out.set(entry.id, cosine(base, other));
  });
  return out;
}
