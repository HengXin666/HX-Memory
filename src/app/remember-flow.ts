// src/app/remember-flow.ts — 写入裁决链 (记住一条内容要走完的全部判断)。
//
// 为什么从 facade.ts 拆出 (2026-09-18): 这是全项目最长的一段编排 (约 136 行), 且它天然是
// **一条链** (候选 → 语义兜底 → 裁决 → 关系装配 → 落盘 → 回写旧条目)。留在 facade 里既顶到
// 行数上限, 也让"链上每一步的取舍"与"门面的其它方法"混在同一个文件。
//
// 语义 (与拆出前逐字一致):
//   · 近邻里已有等价表述 → 不重复落盘, 强化老条目 (reinforcement/lastHitAt) 并合并标签/实体;
//   · 与某条老记忆相关联但不等价 → 落盘 + 自动建 relates 边 (权重 = 相似度);
//   · 其余 → 独立落盘。
// 返回的 decision 让调用方/面板能解释"这次到底发生了什么"。
import type { MemoryEntry, Relation } from "../kernel/types.ts";
import type { Embedder, SyncRetriever } from "../kernel/ports.ts";
import type { RememberInput, RememberResult, FacadeStore } from "./facade-types.ts";
import { buildDraft, adjudicateNeighbors, resolveNeighbors } from "./neighbors.ts";
import { decideEvolution } from "../evolution/evolve.ts";
import { planStructuralLinks } from "../evolution/link.ts";
import { semanticScores } from "../retrieval/embedding.ts";
import type { Adjudicator } from "../evolution/adjudicator.ts";

/** 这条链所需的依赖 (全部显式传入, 便于测试时替换)。 */
export interface RememberFlowDeps {
  store: FacadeStore;
  retriever: SyncRetriever;
  neighborLimit: number;
  maxStructuralLinks: number;
  autoEvolve: () => boolean;
  now: () => string;
  embedder?: Embedder | undefined;
  semanticDuplicateFloor: number;
  adjudicator: Adjudicator;
  /** 审计钩子 (取代/冲突写一条可追溯记录)。缺省静默。 */
  audit?: ((event: string, payload: Record<string, unknown>) => void) | undefined;
}

/** 走完写入裁决链并落盘。 */
export async function runRemember(
  deps: RememberFlowDeps,
  input: RememberInput,
): Promise<RememberResult> {
  const content = input.content.trim();
  if (!content) throw new Error("remember: content is required");
  const at = deps.now();
  const { draft, scope, kind } = buildDraft(input, content, at, () => "draft");

  const neighbors = await resolveNeighbors(
    { store: deps.store, retriever: deps.retriever, neighborLimit: deps.neighborLimit },
    draft,
  );
  // 可选语义兜底: 一次批量嵌入 (候选 + 邻居) → 余弦表。没有 Embedder 时完全不产生开销。
  const semantic = deps.embedder ? await semanticScores(deps.embedder, draft, neighbors) : null;
  // 冲突裁决是异步的 (LLM 实现要调模型), 而 decideEvolution 是纯同步逻辑。
  // 因此在这里**预计算**: 只对"同类且硬冲突"的邻居跑裁决 (其余邻居不需要裁决)。
  const adjudications = await adjudicateNeighbors(
    deps.adjudicator,
    deps.autoEvolve(),
    draft,
    neighbors,
  );
  const decision = decideEvolution(draft, neighbors, {
    ...(adjudications.size
      ? { adjudication: (targetId: string) => adjudications.get(targetId) }
      : {}),
    ...(semantic ? { semanticSimilarity: (id: string) => semantic.get(id) } : {}),
    ...(deps.embedder ? { semanticDuplicateFloor: deps.semanticDuplicateFloor } : {}),
    // 关闭自动演化: 把阈值抬到不可能达到的高度 —— 只保留字面去重与建边, 不取代不标记不语义合并。
    ...(deps.autoEvolve() ? {} : { supersedeFloor: 2, conflictFloor: 2, semanticDuplicateFloor: 2 }),
  });

  // ---- 等价重复: 不落盘, 只强化老条目 ----
  if (decision.action === "duplicate" && decision.targetId) {
    const target = await deps.store.get(decision.targetId);
    if (target) {
      const patch: Partial<MemoryEntry> = {
        reinforcement: (target.reinforcement ?? 0) + 1,
        lastHitAt: at,
      };
      if (decision.mergedTags?.length) patch.tags = [...(target.tags ?? []), ...decision.mergedTags];
      if (decision.mergedEntities?.length) {
        patch.entities = [...(target.entities ?? []), ...decision.mergedEntities];
      }
      await deps.store.update(target.id, patch);
      const updated = (await deps.store.get(target.id)) ?? target;
      return {
        entry: updated,
        decision: "duplicate",
        targetId: target.id,
        similarity: decision.similarity,
      };
    }
  }

  // ---- 关系装配: 显式关系 + 裁决关系 + 结构关联 (标签/实体共现) ----
  const relations: Relation[] = [...(input.relations ?? [])];
  const addRelation = (relation: Relation): void => {
    if (relations.some((r) => r.type === relation.type && r.toId === relation.toId)) return;
    relations.push(relation);
  };
  if (decision.targetId) {
    if (decision.action === "link") {
      addRelation({
        type: "relates",
        toId: decision.targetId,
        weight: Number(decision.similarity.toFixed(3)),
      });
    } else if (decision.action === "supersede") {
      addRelation({ type: "supersedes", toId: decision.targetId });
    } else if (decision.action === "contradict") {
      addRelation({ type: "contradicts", toId: decision.targetId });
    }
  }
  for (const structural of planStructuralLinks(draft, neighbors, {
    maxLinks: deps.maxStructuralLinks,
  })) {
    addRelation(structural);
  }

  const entry = await deps.store.add({
    kind,
    content,
    source: input.source ?? "facade",
    scope,
    ...(input.project ? { project: input.project } : {}),
    ts: { validAt: input.validAt ?? at, assertedAt: at },
    ...(input.tags?.length ? { tags: input.tags } : {}),
    ...(input.entities?.length ? { entities: input.entities } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.derivedFrom?.length ? { derivedFrom: input.derivedFrom } : {}),
    ...(relations.length ? { relations } : {}),
  });

  // ---- 回写旧条目 (取代/冲突的反向指针) ----
  if (decision.targetId && (decision.action === "supersede" || decision.action === "contradict")) {
    const target = await deps.store.get(decision.targetId);
    if (target) {
      const back: Relation[] = [...(target.relations ?? [])];
      const pushBack = (type: Relation["type"], toId: string): void => {
        if (back.some((r) => r.type === type && r.toId === toId)) return;
        back.push({ type, toId });
      };
      if (decision.action === "supersede") {
        pushBack("supersededBy", entry.id);
        // 取代是状态变更 (不删除): 旧版本从默认检索里淡出, 但历史可查、可人工改回。
        await deps.store.update(target.id, { status: "superseded", relations: back });
      } else {
        // 冲突只标记: 两边都保持 active (目标若是 rule, 状态绝不由机器改)。
        pushBack("contradicts", entry.id);
        await deps.store.update(target.id, { relations: back });
      }
      deps.audit?.("evolve", {
        action: decision.action,
        from: entry.id,
        to: target.id,
        reason: decision.reason ?? "unspecified",
      });
    }
  }

  return {
    entry,
    decision:
      decision.action === "supersede"
        ? "superseded"
        : decision.action === "contradict"
          ? "contradicted"
          : decision.action === "link"
            ? "linked"
            : "added",
    ...(decision.targetId ? { targetId: decision.targetId } : {}),
    similarity: decision.similarity,
  };
}
