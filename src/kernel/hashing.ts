// kernel/hashing.ts — 哈希与向量归一化的**唯一实现**。
//
// 为什么要独立一个文件: 这些函数曾在 `retrieval/embedding.ts`、`embedding-lexical.ts`、
// `vector.ts`、`vector-projected.ts` 里各写一份 (jscpd 实测 4 处 clone)。它们的语义必须完全一致 ——
// 内容指纹用于"要不要重嵌"的判定, 哈希用于把 token 映射到向量维度; 两处分叉会导致
// "看着没变却重嵌了"或"以为变了却没重嵌"这类**静默**行为差异。
//
// 纯函数, 无 IO, 无依赖 (kernel 铁律)。
import type { IndexDoc } from "./ports.ts";

/**
 * FNV-1a 32 位哈希。用于把 token 映射到向量维度, 以及生成内容指纹。
 * 选 FNV-1a 而不是 SHA-256: 这里只需要"分布均匀 + 跨进程稳定", 不需要密码学强度,
 * 且它比 crypto 快一个数量级 (嵌入在热路径上)。
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 内容指纹 (带长度后缀): 只用于判断"内容变了没有", 不参与检索排序。 */
export function contentFingerprint(text: string): string {
  return fnv1a32(text).toString(36) + ":" + text.length;
}

/**
 * L2 归一化 (原地)。向量比较依赖它: 归一化后点积即余弦, 长短文本可比。
 * 零向量 (空文本) 原样返回, 由调用方处理 (不要产生 NaN)。
 */
export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
  return vector;
}

/** 索引投影的类型别名再导出 (避免各引擎重复 import 路径)。 */
export type { IndexDoc };
