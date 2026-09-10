// src/recall/service.ts — 召回服务: 把"跨项目规则"在会话中真正生效。
// 核心价值 (对应 ai-docs 007 的核心差异): 规则不锁在某个项目, 而是全局可复用。
// 召回策略:
//   1. 全局规则 (scope:global, kind:rule, confirmed) 总是候选 — 它们是跨项目不变量。
//   2. 按文本相关性排序 (简单包含评分, 无 embedding)。
//   3. 项目内 lesson/pattern 按需召回。
// 诚实边界: 无语义向量, 用关键词命中评分; 后续可换 VectorBackend (可插拔存储)。
import type { MemoryEntry, Query } from "../kernel/types.ts";
import type { SyncMemoryStore, SyncRetriever } from "../kernel/ports.ts";

export interface RecallInput {
  /** 当前任务文本 (如用户问题/会话首条)。 */
  text?: string;
  /** 当前项目名。 */
  project?: string;
  /** 最多召回条数。 */
  limit?: number;
}

export interface RecallOutput {
  /** 命中规则 (跨项目, 按相关性降序)。 */
  rules: MemoryEntry[];
  /** 项目内相关经验。 */
  local: MemoryEntry[];
  /** 注入给 harness 的文本块 (已格式化)。 */
  injected: string;
}

/** 关键词命中评分: 每个查询词 (按空白拆) 在内容里出现 +1。 */
function score(content: string, words: string[]): number {
  const lower = content.toLowerCase();
  return words.filter((w) => lower.includes(w.toLowerCase())).length;
}

function topWords(text: string): string[] {
  return text
    .split(/[\s,，。.、；;:：()（）"'"]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
}

export class RecallService {
  private readonly queryFn: SyncMemoryStore["query"];
  /** v2 检索器 (可选): 传入则走混合检索 (BM25 + 图 + 预算 + 治理闸门)。 */
  private readonly retriever?: SyncRetriever;

  /** 依赖同步查询面 (会话开始/预步是同步判定点); 异步后端需要自带投影。 */
  constructor(queryFn: SyncMemoryStore["query"], retriever?: SyncRetriever) {
    this.queryFn = queryFn;
    this.retriever = retriever;
  }

  /** 召回: 全局规则 + 项目内经验。纯逻辑, 无副作用。 */
  recall(input: RecallInput): RecallOutput {
    if (this.retriever) return this.recallViaRetriever(input);
    const limit = input.limit ?? 6;
    const words = topWords(input.text ?? "");

    // 1) 全局确认规则 — 跨项目不变量, 始终候选。
    //    必须自己再校验一次确认记录: 存储闸门挡的是写入, 这里挡的是"任何来源的 rule 条目"。
    const allRules = this.queryFn({ kind: "rule", scope: "global" }).filter((r) =>
      Boolean(r.confirmedBy && r.confirmedAt),
    );
    const rules = allRules
      .map((r) => ({ r, s: words.length ? score(r.content, words) : 1 }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.r);

    // 2) 项目内经验 — 仅在有查询文本时召回 (本地经验是"按需"而非"总是")。
    //    按词 OR 打分而不是把整串丢给 LIKE: 后者只有"整串连续出现"才命中, 多词查询恒为空。
    const local: MemoryEntry[] = [];
    if (words.length) {
      const localQuery: Query = {};
      if (input.project) {
        localQuery.scope = "project";
        localQuery.project = input.project;
      }
      localQuery.limit = Math.max(limit * 8, 50);
      local.push(
        ...this.queryFn(localQuery)
          .filter((e) => e.kind === "lesson" || e.kind === "pattern" || e.kind === "decision")
          .map((e) => ({ e, s: score(e.content, words) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit)
          .map((x) => x.e),
      );
    }

    // 3) 组装注入文本
    const lines: string[] = [];
    if (rules.length) {
      lines.push("【跨项目规则 (已确认)】");
      for (const r of rules) lines.push("- [" + r.id + "] " + r.content);
    }
    if (local.length) {
      lines.push("【本项目相关经验】");
      for (const e of local) lines.push("- [" + e.kind + "] " + e.content);
    }
    return { rules, local, injected: lines.join("\n") };
  }

  /**
   * v2 路径: 一次混合检索拿到全部候选, 再按"规则 / 本地经验"分桶。
   * 规则仍然走保底通道 (在检索器里), 这里只负责分桶与格式化 —— 口径与 v1 输出一致,
   * 因此 DSH 注入与 Codex AGENTS.md 的消费方无需改动。
   */
  private recallViaRetriever(input: RecallInput): RecallOutput {
    const limit = input.limit ?? 6;
    const result = this.retriever!.retrieveSync({
      ...(input.text ? { text: input.text } : {}),
      ...(input.project ? { scope: { project: input.project } } : {}),
      limit: limit * 2,
      tokenBudget: Math.max(256, limit * 160),
    });
    const rules: MemoryEntry[] = [];
    const local: MemoryEntry[] = [];
    for (const hit of result.hits) {
      // 治理闸门: 任何来源的 rule 都必须带确认记录 (存储闸门之外的第二道)。
      if (hit.entry.kind === "rule") {
        if (hit.entry.scope === "global" && hit.entry.confirmedBy && hit.entry.confirmedAt) {
          if (rules.length < limit) rules.push(hit.entry);
        }
        continue;
      }
      if (local.length < limit) local.push(hit.entry);
    }
    const lines: string[] = [];
    if (rules.length) {
      lines.push("【跨项目规则 (已确认)】");
      for (const r of rules) lines.push("- [" + r.id + "] " + r.content);
    }
    if (local.length) {
      lines.push("【本项目相关经验】");
      for (const e of local) lines.push("- [" + e.kind + "] " + e.content);
    }
    return { rules, local, injected: lines.join("\n") };
  }
}
