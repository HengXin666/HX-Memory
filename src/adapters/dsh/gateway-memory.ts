// adapters/dsh/gateway-memory.ts — 面板的**记忆读取出口**投影: 证据链 / 检索结果形状。
//
// 为什么拆出来 (2026-09-18): 与 gateway-review.ts 同一个理由 —— gateway 是薄投影层,
// 而这两个出口各自带着取舍 (证据链要如实降级、检索要显式声明 purpose), 且 gateway.ts
// 一直贴着 400 行上限 (verify-structure 会拦)。
//
// 关键契约: 投影只做**形状转换**, 不复制任何判定逻辑 ——
// 证据链的三种降级原因只有一处实现 (app/evidence.ts), 检索语义只有一处 (Facade)。
// 面板与 memory_evidence 工具因此必然看到同一份数据 (分叉会让用户不知道该信哪个)。
import type { MemoryFacade } from "../../app/facade.ts";

/** 面板能拿到的最小 Facade 面 (窄化, 避免 gateway 与整个 Facade 耦合)。 */
export interface MemoryPanelFacade {
  evidenceChain(id: string): ReturnType<MemoryFacade["evidenceChain"]>;
  recall(req: Parameters<MemoryFacade["recall"]>[0]): ReturnType<MemoryFacade["recall"]>;
  /**
   * 剔除 (审核 drop 走它): 写 shadow, 持久且重建不复活。
   *
   * ⚠ **2026-10-05 语义反转**: 这里**曾经是 `remember`** (把待审候选写进库)。
   * 现在条目在捕获时已入库, 因此审核需要的是"拿掉它"的能力 —— 换成了 forget。
   */
  forget(id: string, why: string): ReturnType<MemoryFacade["forget"]>;
}

/** 证据链出口的结果: 命中返回链路, 否则返回可展示的错误对象 (不抛异常打爆面板)。 */
export async function projectEvidenceChain(
  facade: MemoryPanelFacade | undefined,
  rawId: unknown,
): Promise<unknown> {
  if (!facade) return { error: "facade unavailable" };
  const id = String(rawId ?? "").trim();
  if (!id) return { error: "id is required" };
  const chain = await facade.evidenceChain(id);
  if (!chain) return { error: "no memory entry with id " + id };
  return chain;
}

/** 面板看到的记忆行 (检索结果 / 最近沉淀共用的字段集)。 */
export interface MemoryRowView {
  id: string;
  kind: string;
  content: string;
  scope: string;
  project?: string;
  source: string;
  confirmedBy?: string;
  confirmedAt?: string;
  validAt: string;
}

/** 把条目投影成面板行 (字段集固定, 前端不必处理可选爆炸)。 */
export function toMemoryRow(e: {
  id: string;
  kind: string;
  content: string;
  scope: string;
  project?: string;
  source: string;
  confirmedBy?: string;
  confirmedAt?: string;
  ts: { validAt: string };
}): MemoryRowView {
  return {
    id: e.id,
    kind: e.kind,
    content: e.content,
    scope: e.scope,
    ...(e.project ? { project: e.project } : {}),
    source: e.source,
    ...(e.confirmedBy ? { confirmedBy: e.confirmedBy } : {}),
    ...(e.confirmedAt ? { confirmedAt: e.confirmedAt } : {}),
    validAt: e.ts.validAt,
  };
}

/**
 * 面板检索的 token 预算。
 * 为什么按 limit 换算而不是固定值: 面板是**人**在搜, 要的是"看得见的几条" ——
 * 固定预算会让 limit 大时被裁 (用户以为漏了), limit 小时浪费 (多算候选)。
 */
export function panelSearchBudget(limit: number): number {
  return Math.max(400, limit * 160);
}

/** 待审队列出口的形状 (available 与 items 分开: "没接线" ≠ "没有待审")。 */
export interface CaptureReviewView {
  available: boolean;
  items: unknown[];
}

/**
 * 待审队列投影: 缺省源时如实返回 available:false。
 *
 * 为什么 available 必须存在: 与 scheduleLog 同一取舍 —— "没有待审"与"这个机制没接线"
 * 是两件完全不同的事, 面板若分不清, 用户会以为一切正常 (而实际上队列根本没接上)。
 */
export function projectCaptureReview(
  source: { recent(limit: number): unknown[] } | undefined,
  rawLimit: unknown,
): CaptureReviewView {
  if (!source) return { available: false, items: [] };
  const n = typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(200, rawLimit)
    : 50;
  return { available: true, items: source.recent(n) };
}

/** 面板检索的入参。 */
export interface PanelSearchInput {
  text?: string;
  kind?: string;
  limit?: number;
}

/**
 * 面板检索出口: 与工具 / MCP / CLI 走同一条检索语义。
 *
 * purpose:"recall" —— 面板是"用户主动搜最相关的记忆", 不是"注入不变量";
 * 不区分的话规则保底通道会让前几条永远是那几条规则 (用户实测的第一困惑)。
 */
export async function projectPanelSearch(
  facade: PanelRecallFacade | undefined,
  store: { query(q: { text?: string; kind?: string; limit?: number }): unknown[] },
  q: PanelSearchInput,
): Promise<unknown[]> {
  const limit = q.limit ?? 10;
  const entries = facade
    ? facade
        .recall({
          ...(q.text ? { text: q.text } : {}),
          ...(q.kind ? { kinds: [q.kind as never] } : {}),
          purpose: "recall",
          limit,
          tokenBudget: panelSearchBudget(limit),
        })
        .hits.map((hit) => hit.entry)
    : (store.query({ text: q.text, kind: q.kind as never, limit }) as PanelEntryLike[]);
  return entries.map((e) => toMemoryRow(e as PanelEntryLike));
}

/** 面板检索所需的最小 Facade 面 (窄化)。 */
export interface PanelRecallFacade {
  recall(req: {
    text?: string;
    kinds?: never[];
    purpose: "recall";
    limit: number;
    tokenBudget: number;
  }): { hits: Array<{ entry: PanelEntryLike }> };
}

/** 面板行投影所需的字段 (与 toMemoryRow 的入参一致)。 */
export interface PanelEntryLike {
  id: string;
  kind: string;
  content: string;
  scope: string;
  project?: string;
  source: string;
  confirmedBy?: string;
  confirmedAt?: string;
  ts: { validAt: string };
}

/**
 * 审核裁决: `action="keep"` 保留 (确认) / `action="drop"` **剔除** (写 shadow)。
 *
 * ⚠ **2026-10-05 语义反转** (用户明确要求): 队列成员**已经落盘**了 —— 审核的职责是
 * "把不该留的挑掉", 不是"拦住不让入库"。因此两个动作的含义与旧版正好相反:
 *
 *   · 旧 `accept` = 把它写进库。**这个动作已经不存在了** —— 条目在捕获时就进了库,
 *     再写一遍等于制造重复。因此 accept 现在只是**确认保留** (改状态, 记录人看过并认可);
 *   · 旧 `reject` = 只是出队 (条目本来就没进库)。现在它必须**真的剔除** ——
 *     走 `facade.forget` 写 `status: shadow` (撤回是持久的, 重建不复活)。
 *     只改队列状态会让"剔除"变成一句空话: 条目还在库里、检索还能命中。
 *
 * 为什么保留旧动作名 (`accept`/`reject`) 作为**别名**: 面板与既有测试按旧名调用,
 * 而语义反转不是"改名"能表达的 —— 让两种写法映射到同一套新语义, 比改名后留下
 * 一批静默失效的调用点安全 (旧名调进来会做**正确的新动作**, 而不是报错或做旧动作)。
 */
export async function resolveCaptureReview(
  facade: MemoryPanelFacade | undefined,
  queue: { setStatus(id: string, status: "accepted" | "rejected"): boolean; item(id: string): CaptureReviewLike | null } | undefined,
  id: string,
  action: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!queue) return { ok: false, error: "review queue not mounted" };
  const target = String(id ?? "").trim();
  if (!target) return { ok: false, error: "id is required" };
  // 新名为主, 旧名为别名 (见头注; 两者映射到**同一套新语义**)。
  const keep = action === "keep" || action === "accept";
  const drop = action === "drop" || action === "reject";
  if (!keep && !drop) {
    return { ok: false, error: "action must be keep or drop" };
  }
  const item = queue.item(target);
  if (!item) return { ok: false, error: "no item with id " + target };

  // ---- 剔除: 真的把它从可用记忆里拿掉 (shadow), 不只是出队 ----
  if (drop) {
    if (!facade) return { ok: false, error: "facade unavailable" };
    try {
      await facade.forget(item.id, "panel:captureReview");
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    return queue.setStatus(target, "rejected") ? { ok: true } : { ok: false, error: "update failed" };
  }

  // ---- 保留: 条目已在库中, 这里只确认 (改状态, 不重复写入) ----
  return queue.setStatus(target, "accepted") ? { ok: true } : { ok: false, error: "update failed" };
}

/** 待审项在裁决出口所需的最小形状。 */
export interface CaptureReviewLike {
  id: string;
  question: string;
  conclusion: string;
  project?: string;
  session: string;
  episodeIds?: string[];
}
