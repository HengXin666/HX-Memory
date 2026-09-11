// kernel/binder.ts — VCP 式"记忆拓扑": 项目/Agent 声明绑定哪些记忆源,
// 预步由代码做确定性注入, 不依赖模型自觉调工具。
// 对照 ReMe/旧线 (guidance 指引 + memory_search 工具, 靠模型自觉)。
//
// 设计来源: VCPToolBox RAGDiaryPlugin 的占位符绑定声明
//   (Agent/*.txt 里 "这里是[微明]的日记本:[[微明日记本::Group::Time::TagMemo+]]"),
//   manifest: "通过向量检索动态地将日记内容注入到系统提示词中"。
// 这里落到声明式、类型化、可测试形态: MemoryBinding + 确定性判定。
import type { MemoryEntry, Query } from "./types.ts";
import { TriggerPolicy, type TriggerDecision } from "../trigger/policy.ts";
import { formatEntryLine } from "./injection-format.ts";
import type { RetrievalRequest, RetrievalWarmup, SyncMemoryStore, SyncRetriever } from "./ports.ts";

/** 每个绑定: 查询条件 + 权重 + 条数预算 + 可选信号词门控。 */
export interface MemoryBinding {
  /** 绑定名, 如 "hx-memory.rules" 或项目名。 */
  id: string;
  /** 绑定源的查询条件 (kind/scope/project/...)。 */
  query: Query;
  /** 权重: 影响排序。 */
  weight?: number;
  /** 预算上限 (条数)。 */
  max?: number;
  /** 可选信号词: 命中才注入 (轻量门控, 避免无关噪声)。 */
  signalWords?: string[];
}

/** 项目级绑定声明 (用户/项目所有者配置, 类比 VCP 的 Agent 配置拓扑)。 */
export interface BindingConfig {
  project: string;
  bindings: MemoryBinding[];
}

/**
 * 判定一条绑定对当前文本是否应注入:
 *  - 无 signalWords → 总是注入 (VCP "有绑定即每轮检索");
 *  - 有 signalWords → 文本命中任一信号词才注入 (轻量门控, 避免无关噪声)。
 */
export function bindingShouldInject(binding: MemoryBinding, text: string): boolean {
  const words = binding.signalWords;
  if (!words || words.length === 0) return true;
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/** 关键词命中评分 (与 recall/service 同口径, 便于双线对照公平)。 */
export function keywordScore(content: string, words: string[]): number {
  const lower = content.toLowerCase();
  return words.filter((w) => lower.includes(w.toLowerCase())).length;
}

/** 查询绑定内容并按命中度排序。纯函数, 无副作用。 */
export function resolveBinding(
  binding: MemoryBinding,
  entries: MemoryEntry[],
  text: string,
): MemoryEntry[] {
  if (!bindingShouldInject(binding, text)) return [];
  const words = text
    .split(/[\s,，。.、；;:：()（）"'"]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  const max = binding.max ?? 6;
  const weight = binding.weight ?? 1;
  return entries
    .filter((e) => binding.query.kind === undefined || e.kind === binding.query.kind)
    .map((e) => ({
      e,
      s:
        (e.project === binding.query.project ? 1 : 0) +
        (words.length ? keywordScore(e.content, words) * weight : weight),
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.e);
}

/**
 * 把一组命中条目格式化成注入文本 (与 recall 输出同风格)。
 * 每行末尾带**稳定 id 标记** (见 adapters/dsh/oid.ts): 人读是注记, 代码据此做跨轮去重与差量注入 ——
 * 没有它就只能比"整块文本", 而块文本会随条目集合变化, 于是已注入过的条目被反复重发。
 */
export function formatBoundEntries(heading: string, entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  return "【" + heading + "】\n" + entries.map((e) => formatEntryLine(e.id, e.content)).join("\n");
}

/** always-on 组 (常驻不变量) 与新召回组 (按本轮相关性) 的切分。 */
export interface TriggerGroups {
  /** 常驻条目 (跨项目规则 + 项目关键事实): 同一会话里只该出现一次。 */
  alwaysOn: MemoryEntry[];
  /** 本轮按相关性新召回的条目 (差量注入的对象)。 */
  fresh: MemoryEntry[];
}

/**
 * 把触发通道的一次召回切成两组。
 *
 * 为什么必须切分 (真实缺陷): always-on 是**不变量**, 没有随轮次变化的理由 ——
 * 逐轮重发既烧预算, 又让同一条记忆在上下文里出现 N 次 (模型会误以为它更重要)。
 * 而真正需要逐轮补的是"这件事的具体历史"(意图召回), 它按话题变化。
 * 切分之后由调用方按"已注入 id 集合"只补差量, 两组的语义才不会被同一个判重口径搅在一起。
 *
 * 切分依据是 id 是否属于 always-on 集合 (注入回调提供的就是 always-on 的 id)。
 */
export function splitTriggerGroups(
  entries: readonly MemoryEntry[],
  alwaysOnIds: readonly string[],
): TriggerGroups {
  const resident = new Set(alwaysOnIds);
  const alwaysOn: MemoryEntry[] = [];
  const fresh: MemoryEntry[] = [];
  for (const e of entries) (resident.has(e.id) ? alwaysOn : fresh).push(e);
  return { alwaysOn, fresh };
}

/**
 * Binder: 声明式绑定 → 确定性注入。核心差异点:
 *  旧线: recall() 只按"当前文本"搜全局规则, 会话是否注入靠 guidance 引导模型调工具;
 *  新线: 项目声明的 bindings 先于模型思考被解析, 命中即注入, 与模型自觉无关。
 */
/**
 * 绑定 → 检索请求 (v2)。绑定的 query 是"结构化条件", 加上当前文本就是一次混合检索:
 * 文本负责相关性, query 负责范围, max 负责条数, token 预算按条数保守换算。
 */
export function bindingToRequest(binding: MemoryBinding, text: string): RetrievalRequest {
  const q = binding.query;
  const limit = binding.max ?? 6;
  const req: RetrievalRequest = { text, limit, tokenBudget: Math.max(64, limit * 120) };
  if (q.kind) req.kinds = [q.kind];
  const scope: RetrievalRequest["scope"] = {};
  if (q.project) scope.project = q.project;
  if (q.scope === "global") scope.global = true;
  if (q.scope === "project") scope.global = false;
  if (Object.keys(scope).length) req.scope = scope;
  if (q.tag) req.tags = [q.tag];
  if (q.at) req.asOf = q.at;
  if (q.includeShadow) req.includeHidden = true;
  return req;
}

/** 触发通道的数据来源 (由调用方注入: always-on 选择 + 意图召回 + 时钟)。 */
export interface TriggerSource {
  /** always-on 条目的 id (只用于判定"有没有", 空数组 = 无保底内容)。 */
  alwaysOn(): readonly string[];
  /** 按触发决策召回条目 (实现方决定用哪些通道/预算)。 */
  recallFor(text: string, decision: TriggerDecision): MemoryEntry[];
  /** 当前时间 (ISO)。 */
  now(): string;
  /**
   * 可选: 注入成功后回报被注入的条目 id (用于"命中即强化")。
   * 为什么需要它: 模型主动调 memory_search 那条路会强化, 而**每轮都在跑的确定性注入**此前不强化 ——
   * 结果是主力通道注入的记忆永远不强化、照常衰减, 与"用进废退"的设计正好相反 (实测确认)。
   * 实现方应做节流 (Facade.reinforce 自带 60s 合并窗口), 且失败要静默 (不能拖垮注入)。
   */
  onInjected?(ids: readonly string[]): void;
  /**
   * 可选: 异步把 always-on 集合准备好 (存储查询是异步的, 而预步判定是同步的)。
   * prestep 会在注入前先 `binder.warm()` —— 这是"第一轮就有 always-on 保底"的关键,
   * 否则首轮会因为没有缓存而完全无记忆 (而那正是最需要保底的时刻)。
   */
  warm?(): Promise<void>;
}

export class Binder {
  private readonly queryFn: SyncMemoryStore["query"];
  private readonly configs: () => BindingConfig[];
  /** 通用触发通道 (可选): 没有项目绑定时用它兜底。 */
  private readonly triggerSource?: TriggerSource;
  private readonly triggerPolicy: TriggerPolicy;
  /** 会话内的触发状态 (话题漂移与去重要用)。 */
  private lastQuery: string | undefined;
  private lastInjectedAt: string | null = null;
  private lastDecision: TriggerDecision | null = null;
  /** 最近一次实际写出去的条目 id (可观测: 面板/日志要看"这轮到底给了什么")。 */
  private lastIds: string[] = [];
  /** 最近一次召回的切分结果 (常驻组 / 新召回组), 供测试与可观测读取。 */
  private lastGroups: TriggerGroups | null = null;
  /**
   * v2 检索器 (可选): 传入则绑定走混合检索 (BM25 + 图扩展 + 预算 + 治理闸门);
   * 不传则走 v1 的关键词路径 —— 后者保留是为了不让"没升级的宿主/老测试"被迫一起改,
   * 不是长期形态 (见 docs/architecture-v2.md §7 P1)。
   */
  private readonly retriever?: SyncRetriever;

  /** 依赖同步查询面 (pre-step 是同步判定点); 异步后端需要自带缓存层/投影。 */
  constructor(
    queryFn: SyncMemoryStore["query"],
    configs: () => BindingConfig[],
    retriever?: SyncRetriever,
    triggerSource?: TriggerSource,
    triggerPolicy?: TriggerPolicy,
  ) {
    this.queryFn = queryFn;
    this.configs = configs;
    this.retriever = retriever;
    this.triggerSource = triggerSource;
    this.triggerPolicy = triggerPolicy ?? new TriggerPolicy();
  }

  /** 取某项目声明的绑定 (无则空)。 */
  bindingsFor(project: string): MemoryBinding[] {
    const cfg = this.configs().find((c) => c.project === project);
    return cfg ? cfg.bindings : [];
  }

  /**
   * 注入前热身 (可选): 异步嵌入器的向量投影需要在后台补齐才有语义召回。
   * 带硬时限, 永不阻塞 —— 没补齐就降级 (结果里会说明), 补多少算多少。
   */
  async warm(deadlineMs = 50, query?: string): Promise<void> {
    // 两条都要热: ①向量投影 (异步嵌入器); ②always-on 缓存 (存储查询是异步的)。
    const warmups: Promise<unknown>[] = [];
    const retriever = this.retriever as Partial<RetrievalWarmup> | undefined;
    if (retriever && typeof retriever.warm === "function") {
      warmups.push(retriever.warm(deadlineMs, query));
    }
    if (this.triggerSource?.warm) warmups.push(this.triggerSource.warm());
    if (!warmups.length) return;
    // 硬时限: 超时不报错 (宁可首轮没有 always-on, 也不能阻塞对话)。
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(warmups),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, Math.min(deadlineMs * 4, 2000)));
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /**
   * 对当前文本做确定性预步注入。返回注入文本 (可为空)。
   *
   * 两条通道的差别:
   *   - 项目声明了 bindings → 按绑定注入 (项目所有者显式声明的记忆拓扑, 最精确);
   *   - 没有任何绑定 → **仍不放弃**: 走触发策略的通用通道 (always-on 保底 + 回忆意图门控),
   *     否则"新项目/没配绑定的项目"会完全没有记忆, 而这正是最常见的失灵场景。
   */
  /**
   * @param injectedIds 本会话**已经注入过**的条目 id (由调用方从会话日志解析)。
   *   为什么是这个形状: 注入块一旦进入会话历史就会一直留在上下文里, 重发没有任何信息增量,
   *   只会让同一条记忆出现 N 次并烧掉预算。因此"这一轮该给什么"= 召回结果 − 已注入集合。
   *   传 undefined/空数组 = 不启用差量 (会话开始那次注入就是这样, 它要建立基线)。
   */
  injectFor(project: string, text: string, injectedIds?: readonly string[]): string {
    const excluded = new Set(injectedIds ?? []);
    const bindings = this.bindingsFor(project);
    const blocks: string[] = [];
    const sentIds = new Set<string>();
    for (const b of bindings) {
      // 差量: 本会话已注入过的条目不再重发 (声明式绑定默认每轮注入, 与 always-on 同病)。
      const entries = this.resolve(b, text).filter((e) => !excluded.has(e.id));
      const block = formatBoundEntries(b.id, entries);
      if (!block) continue;
      blocks.push(block);
      for (const e of entries) sentIds.add(e.id);
    }
    this.lastIds = [...sentIds];
    if (blocks.length) {
      // 声明式绑定注入同样要算"被用到" (否则配了绑定的项目反而永不强化);
      // 只算实际发出的条目 —— 被差量过滤掉的本轮并没有被用到。
      if (sentIds.size) this.triggerSource?.onInjected?.([...sentIds]);
      return blocks.join("\n");
    }
    // 通用通道 (无绑定时的兜底): 由触发策略决定是否注入, 逻辑见 trigger/policy.ts。
    return this.injectWithTrigger(text, excluded);
  }

  /** 最近一次注入实际发出的条目 id (空 = 本轮没有可注入的内容)。 */
  lastInjectedIds(): readonly string[] {
    return this.lastIds;
  }

  /** 最近一次召回的切分结果 (常驻组与新召回组分别是什么)。 */
  lastTriggerGroups(): TriggerGroups | null {
    return this.lastGroups;
  }

  /** 通用触发通道 (无项目绑定时的保底): 用注入回调拿 always-on 与意图召回的条目。 */
  private injectWithTrigger(text: string, excluded: ReadonlySet<string>): string {
    if (!this.triggerSource) return "";
    const alwaysOnIds = this.triggerSource.alwaysOn();
    const hasAlwaysOn = alwaysOnIds.length > 0;
    const decision = this.triggerPolicy.decide({
      text,
      hasAlwaysOn,
      ...(this.lastQuery ? { previousQuery: this.lastQuery } : {}),
      lastInjectedAt: this.lastInjectedAt,
    });
    this.lastDecision = decision;
    this.lastQuery = text;
    if (!decision.inject) {
      this.lastIds = [];
      this.lastGroups = null;
      return "";
    }
    // 注意: always-on 与意图召回是**两条独立通道**, 不是二选一 ——
    // always-on 给"不变量", 意图召回给"这件事的具体历史"; 只给前者会让用户问"上次怎么解决的"
    // 时拿不到那条 lesson (真实踩过)。recallFor 的实现方负责合并两者并按预算去重。
    const entries = this.triggerSource.recallFor(text, decision);
    if (!entries.length) return "";
    // 差量注入: 常驻组只该在会话开始时进一次, 之后只补"本会话还没出现过"的条目。
    const groups = splitTriggerGroups(entries, alwaysOnIds);
    this.lastGroups = groups;
    const fresh = [...groups.alwaysOn, ...groups.fresh].filter((e) => !excluded.has(e.id));
    this.lastIds = [];
    if (!fresh.length) return "";
    this.lastInjectedAt = this.triggerSource.now();
    this.lastIds = fresh.map((e) => e.id);
    // 命中即强化: 确定性注入是"每轮都在跑"的主通道, 它注入过的记忆必须也算被用到
    // (只算**实际发出**的那部分 —— 被差量过滤掉的条目这轮并没有被"用到")。
    this.triggerSource.onInjected?.(this.lastIds);
    return formatBoundEntries("相关记忆 (" + decision.mode + ")", fresh);
  }

  /** 最近一次触发决策 (可观测: 面板/日志要看"为什么这轮没注入")。 */
  lastTriggerDecision(): TriggerDecision | null {
    return this.lastDecision;
  }

  /** 解析一条绑定: 有 Retriever 走混合检索 (带治理闸门与预算), 否则走 v1 关键词路径。 */
  private resolve(binding: MemoryBinding, text: string): MemoryEntry[] {
    if (!bindingShouldInject(binding, text)) return [];
    if (!this.retriever) return resolveBinding(binding, this.queryFn(binding.query), text);
    return this.retriever.retrieveSync(bindingToRequest(binding, text)).hits.map((h) => h.entry);
  }
}
