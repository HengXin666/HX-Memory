// scripts/lib/channel-probe.ts — 用真实检索器给每个节点标出"它靠哪条通道被召回"。
//
// 目的 (item 5): 关系图此前所有节点都是同一套中性配色, 看的人无法回答图上最值得问的问题——
// **"这些条目在真实查询下是靠什么被找到的"**。图上一条边 (mentions/relates) 存在, 不等于
// 检索时真的走得通: 图通道可能对它没贡献, 字面通道可能才是真正把它捞上来的那把钩子。
//
// 一条**不可妥协**的边界: 预览脚本承诺只读 (见 graph-preview.ts 头注释)。
// 而检索需要 FTS5 索引 —— 直接对真实库跑检索会在 ~/.dsh/hx-memory 下建/改 index.sqlite,
// 那就是写。做法: 把语料**复制**进临时库 (mkdtemp) 再检索, 真实根目录一个字节都不碰。
// 代价是多一次全量写盘; 收益是"只读"这个承诺仍然是字面为真的。
//
// 已知偏差 (必须说清楚, 而不是假装精确): 临时库按 entry.id 重建, 因此**跨条目边**
// (relations) 仍然有效, 但任何依赖"库里还存在其他条目"的通道统计会与真实库略有差异
// (本预览只标通道, 不报告指标, 因此差异不影响它给出的结论)。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import type { Channel } from "../../src/kernel/ports.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

export interface ChannelProbeInput {
  /** 全量真相条目 (含 shadow; shadow 本身会被排除, 但保留调用方原样传入的权利)。 */
  entries: readonly MemoryEntry[];
  /** 要拿去问检索器的问题 (由调用方从条目标签/实体/内容派生)。 */
  queries: readonly string[];
  /** 每个问题保留前 N 条命中 (默认 5)。 */
  topK?: number;
  /** 语义通道 (默认不开: 预览不该联网, 也不该偷偷加载词典)。 */
  embedder?: "lexical" | null;
}

export interface ChannelProbeResult {
  /** 条目 id → 命中的通道集合。没被任何查询召回的条目不在表里。 */
  channels: Map<string, Set<Channel>>;
  /** 条目 id → 它被哪些查询召回 (面板展示"因为什么问题才亮起来")。 */
  hits: Map<string, string[]>;
  /** 实际问出去的问题数 (去重后)。 */
  queries: number;
  /** 真实执行的检索次数 (去重后)。 */
  retrievals: number;
  /**
   * 覆盖率读数。必须报告而不是隐藏: 如果大部分条目从未被召回, 那么"按通道着色"图上会有
   * 大片灰 —— 那是**真实结论** (这些条目在当前问题分布下不可达), 不是渲染失败。
   */
  covered: number;
  total: number;
}

/**
 * 用临时库跑一遍真实检索, 统计每条记忆是靠哪些通道被召回的。
 *
 * 失败一律返回空表 (调用方据此退化成"不按通道着色"), 而不是让预览整体失败:
 * 预览的第一职责是"能看", 通道着色是附加信息。
 */
export function probeChannels(input: ChannelProbeInput): ChannelProbeResult {
  const empty: ChannelProbeResult = {
    channels: new Map(),
    hits: new Map(),
    queries: 0,
    retrievals: 0,
    covered: 0,
    total: input.entries.length,
  };
  const queries = [...new Set(input.queries.map((q) => q.trim()).filter((q) => q.length > 0))];
  if (queries.length === 0 || input.entries.length === 0) return empty;

  const root = mkdtempSync(join(tmpdir(), "hxmem-probe-"));
  const channels = new Map<string, Set<Channel>>();
  const hits = new Map<string, string[]>();
  let retrievals = 0;
  try {
    const store = new FileBackend({ root });
    try {
      // 逐条重建: 保留 id / relations / 实体 / 标签 / 时间 —— 通道依赖这些字段。
      for (const e of input.entries) {
        try {
          store.add({ ...e });
        } catch {
          // 单条失败不影响整体 (预览是尽力而为)
        }
      }
      const retriever = new HybridRetriever(store);
      for (const q of queries) {
        retrievals++;
        let result;
        try {
          // 用 retrieveSync 而不是 retrieve: 预览是**同步脚本**, 且本地检索路径本就是同步的
          // (retrieve 只是它的 async 包装)。异步投影类索引不参与 —— 预览不联网。
          result = retriever.retrieveSync({
            text: q,
            // recall 语义: 关掉规则保底通道 —— 否则"哪条靠规则进来"会把所有查询读数都染成 rules,
            // 而这里要问的是"这条记忆与这个问题有没有实质关联" (见 RetrievalRequest.purpose 说明)。
            purpose: "recall",
            limit: input.topK ?? 5,
            includeHidden: true,
          });
        } catch {
          continue;
        }
        for (const hit of result.hits) {
          const id = hit.entry.id;
          const set = channels.get(id) ?? new Set<Channel>();
          for (const c of hit.channels) set.add(c);
          channels.set(id, set);
          const list = hits.get(id) ?? [];
          if (!list.includes(q)) list.push(q);
          hits.set(id, list);
        }
      }
    } finally {
      store.close();
    }
  } catch {
    return empty;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return {
    channels,
    hits,
    queries: queries.length,
    retrievals,
    covered: channels.size,
    total: input.entries.length,
  };
}
