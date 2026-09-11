// app/governance.ts — 治理动作的**实现** (facade 只做编排与门面)。
//
// 为什么独立成文件: 这些动作的共同点是"都会**改写既有记忆**"(强化计数 / 换字段 / 建边 /
// 撤回 / 标注降权), 而 façade 的另一半职责是"产生新记忆"(remember/recall/digest)。
// 两者变化原因不同 —— 前者随治理策略变, 后者随检索与写入策略变。拆开后各自可单独测,
// 也不会让 facade.ts 撞上仓库的 400 行上限。
//
// 治理铁律 (与 generalize 一致): 机器只能**提议**, 不能替人做"这条记忆是错的"的判断。
// 因此 flag 达标时只产出 review 队列提议, 绝不自动删改。
import type { MemoryEntry, RecallFeedback, Relation, RelationType } from "../kernel/types.ts";
import { needsReview } from "../kernel/feedback.ts";
import type { GeneralizerBridge, FlagResult, RecallReason, ReinforceReport } from "./facade-types.ts";

/** 治理动作需要的端口 (只依赖它真正用到的四个方法, 便于测试替身)。 */
export interface GovernanceStore {
  get(id: string): Promise<MemoryEntry | null> | MemoryEntry | null;
  update(id: string, patch: Partial<MemoryEntry>): Promise<void> | void;
  remove(id: string): Promise<void> | void;
}

export interface GovernanceDeps {
  store: GovernanceStore;
  now: () => string;
  audit?: (event: string, payload: Record<string, unknown>) => void;
  /** 缺省时标注照常落盘, 只是不产生人审提议 (治理能力可降级, 数据不丢)。 */
  generalizer?: () => GeneralizerBridge | undefined;
}

/**
 * 命中即强化 (记忆的"用进废退"): 被检索并注入的记忆延后衰减。
 * 节流 (coalesceMs) 的理由: 预步注入每个 step 都跑, 高频写盘会让真相文件产生无意义的 diff;
 * 同一窗口内重复命中只算一次。只对 active 生效 (shadow/expired 不因命中复活)。
 */
export async function applyReinforce(
  deps: GovernanceDeps,
  ids: readonly string[],
  opts: { now?: string; coalesceMs?: number } = {},
): Promise<ReinforceReport> {
  const at = opts.now ?? deps.now();
  const coalesceMs = opts.coalesceMs ?? 60_000;
  const report: ReinforceReport = { reinforced: [], skipped: [] };
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = await deps.store.get(id);
    if (!entry || (entry.status ?? "active") !== "active") {
      report.skipped.push({ id, reason: "not-active" });
      continue;
    }
    const last = entry.lastHitAt ? Date.parse(entry.lastHitAt) : Number.NaN;
    if (Number.isFinite(last) && Date.parse(at) - last < coalesceMs) {
      report.skipped.push({ id, reason: "coalesced" });
      continue;
    }
    await deps.store.update(id, { reinforcement: (entry.reinforcement ?? 0) + 1, lastHitAt: at });
    report.reinforced.push(id);
  }
  return report;
}

/**
 * agent 对召回质量的**负面**标注 (只记坏的 —— 好的不记, 沉默是默认状态)。
 *
 * 为什么只收负面: 逼 agent 对每条召回都表态会造成义务感, 它会为交差而编造评价,
 * 而噪声比没有信号更糟。因此这里**没有** "used/有用" 的对应入口。
 * 两类分开累加 (irrelevant 与 wrong), 因为它们导向不同修法:
 * irrelevant → 检索/排序问题; wrong → 内容问题, 需要人审改写。
 */
export async function applyFlag(
  deps: GovernanceDeps,
  id: string,
  reason: RecallReason,
  note?: string,
): Promise<FlagResult> {
  if (reason !== "irrelevant" && reason !== "wrong") {
    throw new Error("flagRecall: reason must be irrelevant|wrong, got " + JSON.stringify(reason));
  }
  const entry = await deps.store.get(id);
  if (!entry) return { ok: false, error: "not-found" };
  const current = entry.feedback ?? { irrelevant: 0, wrong: 0 };
  const feedback: RecallFeedback = {
    irrelevant: current.irrelevant + (reason === "irrelevant" ? 1 : 0),
    wrong: current.wrong + (reason === "wrong" ? 1 : 0),
  };
  await deps.store.update(id, { feedback });
  deps.audit?.("flag", { id, reason, note: note ?? "", at: deps.now() });
  // 治理: 坏评够多够密 → 提议人审。只提议, 不自动改。
  const exposure = entry.reinforcement ?? 0;
  const proposed = needsReview(feedback, exposure) ? await proposeReview(deps, entry, feedback) : null;
  return { ok: true, feedback, proposed };
}

/** 产出"这条记忆的坏评超标"的人审提议 (复用 generalize 队列, 人确认才生效)。 */
async function proposeReview(
  deps: GovernanceDeps,
  entry: MemoryEntry,
  feedback: RecallFeedback,
): Promise<string | null> {
  const generalizer = deps.generalizer?.();
  if (!generalizer) return null;
  try {
    const queued = await generalizer.enqueueProposal({
      rule:
        "记忆 " +
        entry.id +
        " 的召回质量不达标 (wrong=" +
        feedback.wrong +
        ", irrelevant=" +
        feedback.irrelevant +
        ", 曝光=" +
        (entry.reinforcement ?? 0) +
        "): " +
        entry.content.slice(0, 120) +
        " —— 请裁决改写或撤回。",
      covers: [entry.id],
      confidence: 1,
      sourceRun: "recall-feedback",
    });
    return queued.id;
  } catch {
    // 提议失败不能拖垮标注本身 (标注已落盘)。
    return null;
  }
}

/** 建边 (显式关联)。重复边由存储层主键去重。 */
export async function applyLink(
  deps: GovernanceDeps,
  a: string,
  b: string,
  type: RelationType,
  weight?: number,
): Promise<void> {
  const from = await deps.store.get(a);
  if (!from) throw new Error("link: not found: " + a);
  const relation: Relation = { type, toId: b, ...(weight === undefined ? {} : { weight }) };
  const relations = [
    ...(from.relations ?? []).filter((r) => !(r.type === type && r.toId === b)),
    relation,
  ];
  await deps.store.update(a, { relations });
}

/** 撤回 (人工显式, 持久): 写 shadow, 检索不再返回, 重建不复活。 */
export async function applyForget(
  deps: GovernanceDeps,
  id: string,
  why: string,
): Promise<void> {
  const existing = await deps.store.get(id);
  if (!existing) return;
  await deps.store.remove(id);
  deps.audit?.("forget", { id, why, at: deps.now() });
}

/** 人工修正 (改动本身留痕在真相文件的 frontmatter 里)。 */
export async function applyRevise(
  deps: GovernanceDeps,
  id: string,
  patch: Partial<MemoryEntry>,
): Promise<MemoryEntry> {
  const existing = await deps.store.get(id);
  if (!existing) throw new Error("revise: not found: " + id);
  if (patch.content !== undefined && !patch.content.trim()) {
    throw new Error("revise: content cannot be emptied (用 forget 撤回)");
  }
  await deps.store.update(id, patch);
  const updated = await deps.store.get(id);
  if (!updated) throw new Error("revise: entry disappeared after update: " + id);
  return updated;
}
