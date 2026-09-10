// kernel/binder.ts — VCP 式"记忆拓扑": 项目/Agent 声明绑定哪些记忆源,
// 预步由代码做确定性注入, 不依赖模型自觉调工具。
// 对照 ReMe/旧线 (guidance 指引 + memory_search 工具, 靠模型自觉)。
//
// 设计来源: VCPToolBox RAGDiaryPlugin 的占位符绑定声明
//   (Agent/*.txt 里 "这里是[微明]的日记本:[[微明日记本::Group::Time::TagMemo+]]"),
//   manifest: "通过向量检索动态地将日记内容注入到系统提示词中"。
// 这里落到声明式、类型化、可测试形态: MemoryBinding + 确定性判定。
import type { MemoryEntry, Query } from "./types.ts";
import type { RetrievalRequest, SyncMemoryStore, SyncRetriever } from "./ports.ts";

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

/** 把一组命中条目格式化成注入文本 (与 recall 输出同风格)。 */
export function formatBoundEntries(heading: string, entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  return "【" + heading + "】\n" + entries.map((e) => "- [" + e.id + "] " + e.content).join("\n");
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

export class Binder {
  private readonly queryFn: SyncMemoryStore["query"];
  private readonly configs: () => BindingConfig[];
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
  ) {
    this.queryFn = queryFn;
    this.configs = configs;
    this.retriever = retriever;
  }

  /** 取某项目声明的绑定 (无则空)。 */
  bindingsFor(project: string): MemoryBinding[] {
    const cfg = this.configs().find((c) => c.project === project);
    return cfg ? cfg.bindings : [];
  }

  /** 对当前文本做确定性预步注入。返回注入文本 (可为空)。 */
  injectFor(project: string, text: string): string {
    const bindings = this.bindingsFor(project);
    const blocks: string[] = [];
    for (const b of bindings) {
      const entries = this.resolve(b, text);
      const block = formatBoundEntries(b.id, entries);
      if (block) blocks.push(block);
    }
    return blocks.join("\n");
  }

  /** 解析一条绑定: 有 Retriever 走混合检索 (带治理闸门与预算), 否则走 v1 关键词路径。 */
  private resolve(binding: MemoryBinding, text: string): MemoryEntry[] {
    if (!bindingShouldInject(binding, text)) return [];
    if (!this.retriever) return resolveBinding(binding, this.queryFn(binding.query), text);
    return this.retriever.retrieveSync(bindingToRequest(binding, text)).hits.map((h) => h.entry);
  }
}
