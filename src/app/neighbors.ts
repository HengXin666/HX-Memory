// app/neighbors.ts — 写入前的**候选与裁决准备** (近邻查找 + 冲突预裁决 + 草稿构造)。
//
// 为什么独立: 这段逻辑回答"这条新记忆和已有的哪些条目有关系", 它需要存储、检索器、嵌入器与裁决器,
// 但**不需要** Facade 的公共 API。把它从 facade.ts 拿出来, 编排逻辑 (remember 的决策落盘)
// 就能保持短小可读, 而候选策略可以独立演进 (例如以后加"按实体索引找候选")。
import type { MemoryEntry, MemoryKind, MemoryScope, Query } from "../kernel/types.ts";
import type { Awaitable, SyncRetriever } from "../kernel/ports.ts";
import { hardConflict } from "../evolution/evolve.ts";
import { normalizeFingerprint } from "../evolution/associate.ts";
import type { Adjudication, Adjudicator } from "../evolution/adjudicator.ts";
import type { RememberInput } from "./facade-types.ts";

/** 组装"草稿条目" (未落盘, id 固定为 draft 以免与真实条目混淆)。 */
export function buildDraft(
  input: RememberInput,
  content: string,
  at: string,
  idOf: () => string,
): { draft: MemoryEntry; scope: MemoryScope; kind: MemoryKind } {
  const scope: MemoryScope = input.scope ?? (input.project ? "project" : "agent");
  const kind: MemoryKind = input.kind ?? "fact";
  return {
    scope,
    kind,
    draft: {
      id: idOf(),
      kind,
      content,
      source: input.source ?? "facade",
      scope,
      ts: { validAt: input.validAt ?? at, assertedAt: at },
      ...(input.project ? { project: input.project } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.entities?.length ? { entities: input.entities } : {}),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    },
  };
}

export interface NeighborDeps {
  /** 只要 query 这一项 (Awaitable 返回也接受, 调用处 await)。 */
  store: { query: (q: Query) => Awaitable<MemoryEntry[]> };
  retriever: SyncRetriever;
  neighborLimit: number;
}

/**
 * 近邻候选。三路合并, 因为三种裁决需要不同的候选面:
 *   1. 文本检索 → 近义重述 / 冲突 (同种类);
 *   2. 标签共现 → 结构关联 (共享标签但不一定字面相似);
 *   3. 全局规则 → 与规则冲突必须能被发现 (规则本身绝不被机器改)。
 * 内容太短时不查 (避免和一堆短条目误判重复)。
 */
export async function resolveNeighbors(
  deps: NeighborDeps,
  draft: MemoryEntry,
): Promise<MemoryEntry[]> {
  if (deps.neighborLimit <= 0) return [];
  if (normalizeFingerprint(draft.content).length < 4) return [];
  const found = new Map<string, MemoryEntry>();
  const collect = (entries: readonly MemoryEntry[]): void => {
    for (const entry of entries) {
      if (entry.id === draft.id) continue;
      if (!found.has(entry.id)) found.set(entry.id, entry);
    }
  };
  // 裁决用的检索: 关掉图扩展、向量通道与去冗余 —— 近邻裁决只要"字面最像的几条",
  // 语义相似度由 embedding 余弦单独提供, 不需要走向量召回通道。
  // 这样每次写入就不会触发"向量索引全量对账"(实测这是写入路径的主要开销)。
  collect(
    deps.retriever
      .retrieveSync({
        text: draft.content,
        limit: deps.neighborLimit,
        kinds: [draft.kind],
        expand: { graph: 0 },
        channels: { vector: { enabled: false }, graph: { enabled: false } },
        ...(draft.project ? { scope: { project: draft.project } } : {}),
      })
      .hits.map((h) => h.entry),
  );
  for (const tag of draft.tags ?? []) {
    collect(await deps.store.query({ tag, limit: deps.neighborLimit }));
  }
  collect(await deps.store.query({ kind: "rule", scope: "global", limit: 5 }));
  // 上限: 裁决是 O(邻居) 的, 不能让候选面无限膨胀。
  return [...found.values()].slice(0, Math.max(12, deps.neighborLimit * 3));
}

/**
 * 对候选与近邻做冲突**预裁决** (只处理"同 kind 且硬冲突"的那些)。
 * 为什么只挑硬冲突: 裁决器是为"矛盾但没有显式更新信号"准备的; 其余情形由
 * duplicate/link/supersede 的既有规则直接决定, 多跑一次裁决纯属浪费 (还可能引入噪声)。
 * 失败时静默返回空表 —— 裁决是增强, 不该让一次写入失败。
 */
export async function adjudicateNeighbors(
  adjudicator: Adjudicator,
  autoEvolve: boolean,
  candidate: MemoryEntry,
  neighbors: readonly MemoryEntry[],
): Promise<Map<string, Adjudication>> {
  const out = new Map<string, Adjudication>();
  if (!autoEvolve) return out;
  for (const target of neighbors) {
    if ((target.status ?? "active") !== "active") continue;
    if (target.kind !== candidate.kind) continue;
    if (!hardConflict(candidate.content, target.content)) continue;
    try {
      out.set(
        target.id,
        await adjudicator.adjudicate({
          candidate: {
            kind: candidate.kind,
            content: candidate.content,
            ...(candidate.importance === undefined ? {} : { importance: candidate.importance }),
            ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
            ts: candidate.ts,
          },
          target: {
            id: target.id,
            kind: target.kind,
            content: target.content,
            ...(target.importance === undefined ? {} : { importance: target.importance }),
            ...(target.confidence === undefined ? {} : { confidence: target.confidence }),
            ts: target.ts,
          },
        }),
      );
    } catch {
      // 裁决失败 → 该邻居不预裁决, decideEvolution 会退回"标记冲突" (安全默认)。
    }
  }
  return out;
}
