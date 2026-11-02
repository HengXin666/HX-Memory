// kernel/ports-storage.ts — 存储侧端口 (Episode 追加日志 / 派生索引自述与重建)。
// 2026-11-02 从 ports.ts 拆出 (verify-structure 400 行约束); ports.ts re-export, 既有 import 路径不变。
import type { Episode, EpisodeInput } from "./types.ts";
import type { Awaitable } from "./ports.ts";

/**
 * Episode 存储端口 (ADR-018): 原始轮次的追加日志, 是真相的一部分。
 * 为什么需要它: 记忆是"抽取"的产物, 抽取器一定会升级; 只存抽取结果的话,
 * 升级时只能对已经损失过一次信息的结果再抽一遍, 而"全量重建"也就到不了最上游。
 * 硬约束: 追加写, 永不改写; 可配置保留期; 可整体关闭 (隐私)。
 */
export interface EpisodeStore {
  append(input: EpisodeInput): Awaitable<Episode>;
  /** 全量 (按 at 升序); 重放 (T2 抽取重建) 的输入。 */
  all(): Awaitable<Episode[]>;
  /** 只取某个时间点之后的 (增量重放)。 */
  since(iso: string): Awaitable<Episode[]>;
  bySession(session: string): Awaitable<Episode[]>;
  /**
   * 按 id 批量取原文 (溯源链的最后一跳: 记忆条目 → 产生它的那轮对话)。
   *
   * 为什么必须存在: `MemoryEntry.derivedFrom` 存了 episode id, 但此前没有任何按 id 查询的
   * 公开路径  于是"这条结论来自哪一轮对话"在产品层不可回答 (盲审 2026-09-18 指出)。
   * 只提供**批量**形态: 一条记忆天然对应多轮 (user + assistant), 单 id 版本由调用方传单元素数组,
   * 避免同一段逻辑写两遍。找不到的 id 直接缺席返回 (不抛错, 不拿其它内容冒充原话)。
   */
  byIds(ids: readonly string[]): Awaitable<Episode[]>;
  count(): Awaitable<number>;
  /** 按保留期清理; 返回删除的 episode 数 (0 = 未配置保留期, 不清理)。 */
  prune(nowIso?: string): Awaitable<number>;
}
/**
 * 派生索引的自述与重建能力 (ADR-020 / ADR-023)。
 * 引擎准入的硬条件: 必须能"从真相全量重建", 并且能自证"索引与真相一致"。
 * 没有这两个能力的实现, 不许进 src/storage/ 或 src/engines/。
 */
export interface VerifyReport {
  ok: boolean;
  /** 真相 (文件/上游真值) 里的条目数。 */
  truth: number;
  /** 结构化索引里的条目数。 */
  index: number;
  /** 全文索引里的条目数 (无全文索引时为 undefined)。 */
  fullText?: number;
  problems: string[];
}

export interface Rebuildable {
  /** 派生 schema/身份版本 (如 "format2+tokenizer1"); 不符即重建, 不许混用 (ADR-023)。 */
  readonly schemaVersion: string;
  /** 从真相全量重建派生索引 (T1), 幂等; 返回重建的条目数。 
   * .agents/notes/implemented/architecture/2026-09-10-truth-in-files-and-tiered-rebuild.md
   */
  rebuildFromTruth(): Awaitable<number>;
  /** 一致性自检 (索引 ↔ 真相)。 
   * .agents/notes/implemented/architecture/2026-09-29-decision-port-foundation.md
   */
  verify(): Awaitable<VerifyReport>;
}
