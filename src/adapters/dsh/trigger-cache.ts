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
import { estimateTokens } from "../../kernel/ranking.ts";
import type { MemoryFacade } from "../../app/facade.ts";
import type { TriggerDecision } from "../../trigger/policy.ts";
import {
  encodeLineage,
  normalizeScopeArg,
  type ProjectScope,
  type ProjectScopeArg,
} from "../../kernel/project-lineage.ts";

export interface TriggerCacheDeps {
  facade: MemoryFacade;
  /** 写版本号来源 (存储层; 用于"变了才重算")。 */
  revision: () => number;
  /** always-on 的 token 预算 (默认 400: 保底但不喧宾夺主)。 */
  budgetTokens?: number;
  /**
   * always-on 的**条数上限** (默认 3)。
   *
   * 为什么默认收到 3 (2026-09-29, 用户实测 "太多无用上下文"): 真实首轮注入 9 条 / 581 token,
   * 其中 41% 是包装。token 闸只管总长度, 管不住"9 条平铺各自占用注意力" —— 而保底通道的
   * 目的是**不变量**, 不是"把库里所有规则都倒出来"。留 3 条的取法是"分最高的 3 条"
   * (selectAlwaysOnDetailed 已按分数降序 + id tiebreak 排好), 被挡的会进 blocked 报告,
   * 面板可解释"为什么只注入了这几条"。设 0 表示不限制 (恢复旧行为)。
   *
   * 可以是**函数**: 面板改设置后不需要重启 (与 autoEvolve/episodeRetentionDays 同一约定 ——
   * 本项目实测过"只读一次快照 ⇒ 改了不生效"这类缺陷)。
   */
  maxEntries?: number | (() => number);
}

export interface TriggerCache {
  /** 刷新 (写版本号变了才重算); 预步注入前 await 它, 因此第一轮就有保底内容。 */
  refresh(scope?: ProjectScopeArg): Promise<void>;
  /** 当前 always-on 集合的 id (按工作区取; 不传 = 不含任何项目内条目)。 */
  ids(scope?: ProjectScopeArg): string[];
  /** 按触发决策组装注入内容 (always-on 保底 + 意图召回叠加)。 */
  recallFor(
    text: string,
    decision: Pick<TriggerDecision, "inject" | "budgetTokens">,
    scope?: ProjectScopeArg,
  ): MemoryEntry[];
}

/** 缓存键: 祖先链的编码, 或""表示"没有项目上下文"。 */
type CacheKey = string;

/**
 * 缓存键: 有链用链 (链决定可见集合), 无链用单值项目键。
 * 链用 NUL 编码 (见 kernel/project-lineage 的 encodeLineage) —— 可打印分隔符会碰撞。
 */
function scopeKey(scope?: ProjectScope): CacheKey {
  if (!scope) return "";
  if (scope.lineage?.length) return encodeLineage(scope.lineage);
  return scope.project ?? "";
}

export function createTriggerCache(deps: TriggerCacheDeps): TriggerCache {
  const budget = deps.budgetTokens ?? 400;
  // 0 视为"不限制" (与"不传"不同: 它显式要求恢复旧行为, 便于用户与测试对照)。
  // 0 视为"不限制" —— 每次求值 (面板改动当轮生效)。
  const maxEntriesNow = (): number | undefined => {
    const raw = deps.maxEntries === undefined ? 3 : typeof deps.maxEntries === "function" ? deps.maxEntries() : deps.maxEntries;
    return raw > 0 ? raw : undefined;
  };
  // **按项目分别缓存**, 而不是一份全局缓存。
  //
  // 为什么必须分开 (真实缺陷): 此前只有一对 cache/cachedRevision, 且失效判据是
  // "写版本号变了"。同一版本里第一个来热身的项目会把**它自己项目的**always-on 灌进去,
  // 之后所有项目都直接命中这份缓存 —— 于是 A 项目的私有决策被注入给 B 项目, 直到某次写入
  // 把版本号顶掉才重算 (实测: 8 个项目的条目混在同一次注入里)。
  // 版本号仍然必要 (变了才重算), 但它是**每个项目各自**的失效依据。
  // 缓存里同时记**当时的条数上限**: 它是选取的输入之一, 不进键的话"面板改了条数"会命中旧缓存,
  // 表现是"改了不生效" —— 正是本仓反复踩过的那类静默缺陷 (见 deps.maxEntries 的说明)。
  const caches = new Map<CacheKey, { entries: MemoryEntry[]; revision: number; maxEntries?: number }>();
  const inflight = new Map<CacheKey, Promise<void>>();
  const keyOf = (scope?: ProjectScopeArg): CacheKey => scopeKey(normalizeScopeArg(scope));

  const refresh = (scopeArg?: ProjectScopeArg): Promise<void> => {
    const scope = normalizeScopeArg(scopeArg);
    const key = scopeKey(scope);
    const revision = deps.revision();
    const maxEntries = maxEntriesNow();
    const cached = caches.get(key);
    if (cached && cached.revision === revision && cached.maxEntries === maxEntries && cached.entries.length) {
      return Promise.resolve();
    }
    // 同一工作区、同一版本的在途刷新直接复用 (避免并发预步重复查询)。
    const pending = inflight.get(key);
    if (pending && cached?.revision === revision && cached.maxEntries === maxEntries) return pending;
    const task = deps.facade
      .alwaysOn({
        ...(scope?.project ? { project: scope.project } : {}),
        ...(scope?.lineage?.length ? { lineage: scope.lineage } : {}),
        budgetTokens: budget,
        ...(maxEntries === undefined ? {} : { maxEntries }),
      })
      .then((entries) => {
        caches.set(key, { entries, revision, maxEntries });
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
    ids: (scope) => (caches.get(keyOf(scope))?.entries ?? []).map((e) => e.id),
    recallFor: (text, decision, scopeArg) => {
      if (!decision.inject) return [];
      const scope = normalizeScopeArg(scopeArg);
      const entry = caches.get(keyOf(scopeArg))?.entries ?? [];
      const out = new Map<string, MemoryEntry>();
      for (const e of entry) out.set(e.id, e);
      // ⚠ 2026-09-18 修复: 此前用 **content.length (字符数) + 8** 当 token 数 —— 量纲不一致。
      // 而 decision.budgetTokens 是 **token 预算**, 两者相减没有意义。
      // 实测该错误使剩余预算被**低估约 10%** (字符 364 vs token 331), 虽方向保守 (偏小),
      // 但它与下游 recall 的 tokenBudget 单位不同 ⇒ 两处口径分叉 (本项目反复强调的坑)。
      // 改用与检索/裁剪同一函数 estimateTokens, 保证"预算"这个概念在整个链路上只有一种度量。
      const alwaysOnCost = entry.reduce((n, e) => n + estimateTokens(e.content) + 8, 0);
      const intentsBudget = Math.max(0, decision.budgetTokens - alwaysOnCost);
      if (intentsBudget > 0) {
        // 意图召回**必须**带工作区范围 (祖先链优先, 老调用点退化为单值)。
        //
        // 为什么必须在这里修 (真实缺陷): 这条路径此前完全不带 scope, 于是意图通道
        // 召回的是**全库**条目 —— always-on 通道辛苦做的项目隔离, 被紧跟着的召回
        // 原样漏掉; 症状是"父工程的记忆看不见"与"别的项目的记忆却混进来"同时消失
        // 在半隔离的表象下。范围参数在这里的作用是让两个通道口径一致。
        const ranged: { project?: string; lineage?: readonly string[] } = {
          ...(scope?.project ? { project: scope.project } : {}),
          ...(scope?.lineage?.length ? { lineage: scope.lineage } : {}),
        };
        for (const hit of deps.facade.recall({
          text,
          purpose: "recall",
          limit: 6,
          tokenBudget: intentsBudget,
          ...(Object.keys(ranged).length ? { scope: ranged } : {}),
        }).hits) {
          out.set(hit.entry.id, hit.entry);
        }
      }
      return [...out.values()];
    },
  };
}
