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
  /** 当前 always-on 集合的 id。 */
  ids(): string[];
  /** 按触发决策组装注入内容 (always-on 保底 + 意图召回叠加)。 */
  recallFor(text: string, decision: Pick<TriggerDecision, "inject" | "budgetTokens">): MemoryEntry[];
}

export function createTriggerCache(deps: TriggerCacheDeps): TriggerCache {
  const budget = deps.budgetTokens ?? 400;
  let cache: MemoryEntry[] = [];
  let cachedRevision = -1;
  let inflight: Promise<void> | null = null;

  const refresh = (project?: string): Promise<void> => {
    const revision = deps.revision();
    if (revision === cachedRevision && cache.length) return Promise.resolve();
    // 同一版本的在途刷新直接复用 (避免并发预步重复查询)。
    if (inflight) return inflight;
    inflight = deps.facade
      .alwaysOn({ ...(project ? { project } : {}), budgetTokens: budget })
      .then((entries) => {
        cache = entries;
        cachedRevision = revision;
      })
      // 失败静默: 该轮退化为"无 always-on"而不是阻塞对话 (超时同理, 由调用方限时)。
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    refresh,
    ids: () => cache.map((e) => e.id),
    recallFor: (text, decision) => {
      if (!decision.inject) return [];
      const out = new Map<string, MemoryEntry>();
      for (const entry of cache) out.set(entry.id, entry);
      const alwaysOnCost = cache.reduce((n, e) => n + e.content.length + 8, 0);
      const intentsBudget = Math.max(0, decision.budgetTokens - alwaysOnCost);
      if (intentsBudget > 0) {
        for (const hit of deps.facade.recall({ text, limit: 6, tokenBudget: intentsBudget }).hits) {
          out.set(hit.entry.id, hit.entry);
        }
      }
      return [...out.values()];
    },
  };
}
