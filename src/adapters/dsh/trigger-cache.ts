// adapters/dsh/trigger-cache.ts — 声明式触发的**缓存与召回组装**。
//
// 为什么独立: always-on 缓存 + 意图召回叠加是一段自洽的逻辑 (含失效策略与预算扣减),
// 它只依赖 facade/retriever, 与插件的其余接线 (设置、episode、工具注册) 无关。
// 抽出来之后 index.ts 只剩"把零件接起来", 而这段缓存逻辑可以被单独审视与测试。
//
// 两个关键设计 (都不是随手写的):
//   1. **按写版本号失效**: 每次预步都查库会让注入路径变慢; 用 revision 比较实现"变了才重算",
//      稳态下只做一次内存比较 (零查询)。
//   2. **always-on 与意图召回叠加而非二选一**: 规则给不变量, 召回给具体历史;
//      先扣掉 always-on 已占预算, 剩下的给意图通道, 避免两条通道互相挤占。
import type { MemoryEntry } from "../../kernel/types.ts";
import type { MemoryFacade } from "../../app/facade.ts";
import type { TriggerDecision } from "../../trigger/policy.ts";

export interface TriggerCacheDeps {
  facade: MemoryFacade;
  /** 写版本号来源 (存储层; 用于"变了才重算")。 */
  revision: () => number;
  /** always-on 的 token 预算 (默认 400: 保底但不喧宾夺主)。 */
  budgetTokens?: number;
}

export interface TriggerCache {
  /** 刷新 (写版本号变了才重算); 预步注入前 await 它, 因此第一轮就有保底内容。 */
  refresh(project?: string): Promise<void>;
  /** 当前 always-on 集合的 id (按项目取; 不传 = 不含任何项目内条目)。 */
  ids(project?: string): string[];
  /** 按触发决策组装注入内容 (always-on 保底 + 意图召回叠加)。 */
  recallFor(
    text: string,
    decision: Pick<TriggerDecision, "inject" | "budgetTokens">,
    project?: string,
  ): MemoryEntry[];
}

/** 缓存键: 项目键, 或""表示"没有项目上下文"。 */
type CacheKey = string;

export function createTriggerCache(deps: TriggerCacheDeps): TriggerCache {
  const budget = deps.budgetTokens ?? 400;
  // **按项目分别缓存**, 而不是一份全局缓存。
  //
  // 为什么必须分开 (真实缺陷): 此前只有一对 cache/cachedRevision, 且失效判据是
  // "写版本号变了"。同一版本里第一个来热身的项目会把**它自己项目的**always-on 灌进去,
  // 之后所有项目都直接命中这份缓存 —— 于是 A 项目的私有决策被注入给 B 项目, 直到某次写入
  // 把版本号顶掉才重算 (实测: 8 个项目的条目混在同一次注入里)。
  // 版本号仍然必要 (变了才重算), 但它是**每个项目各自**的失效依据。
  const caches = new Map<CacheKey, { entries: MemoryEntry[]; revision: number }>();
  const inflight = new Map<CacheKey, Promise<void>>();
  const keyOf = (project?: string): CacheKey => project ?? "";

  const refresh = (project?: string): Promise<void> => {
    const key = keyOf(project);
    const revision = deps.revision();
    const cached = caches.get(key);
    if (cached && cached.revision === revision && cached.entries.length) return Promise.resolve();
    // 同一项目、同一版本的在途刷新直接复用 (避免并发预步重复查询)。
    const pending = inflight.get(key);
    if (pending && cached?.revision === revision) return pending;
    const task = deps.facade
      .alwaysOn({ ...(project ? { project } : {}), budgetTokens: budget })
      .then((entries) => {
        caches.set(key, { entries, revision });
      })
      // 失败静默: 该轮退化为"无 always-on"而不是阻塞对话 (超时同理, 由调用方限时)。
      .catch(() => undefined)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, task);
    return task;
  };

  return {
    refresh,
    ids: (project) => (caches.get(keyOf(project))?.entries ?? []).map((e) => e.id),
    recallFor: (text, decision, project) => {
      if (!decision.inject) return [];
      const entry = caches.get(keyOf(project))?.entries ?? [];
      const out = new Map<string, MemoryEntry>();
      for (const e of entry) out.set(e.id, e);
      const alwaysOnCost = entry.reduce((n, e) => n + e.content.length + 8, 0);
      const intentsBudget = Math.max(0, decision.budgetTokens - alwaysOnCost);
      if (intentsBudget > 0) {
        for (const hit of deps.facade.recall({
          text,
          purpose: "recall",
          limit: 6,
          tokenBudget: intentsBudget,
        }).hits) {
          out.set(hit.entry.id, hit.entry);
        }
      }
      return [...out.values()];
    },
  };
}
