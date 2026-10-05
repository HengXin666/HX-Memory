// src/wiki/compile.ts — 写入侧**编译**: 一轮对话 → 整理进正确的 (目录, 页面, 小节)。
//
// 依据: docs/kinfra-wiki-spec.md §1/§6.1/§9.5 与 §7 的动作空间。核心命题是**编译而非存储**:
//   同一段对话不在检索时临时拼装, 而在写入时就整理成"当前认为成立的知识"。
//   成本模型: 有意在写入侧花 Token, 换读取侧的准确率 (一次写入、长期反复读取)。
//
// 动作空间 (spec §7): route / create / **reuse** 属于"记到哪里"这一组。
//   ⚠ 实测教训: 初版只实现了 route+create, 漏了 **reuse** —— 于是 "alice 对花生过敏" 与
//   "alice 也在做 api-docs" 落到了两张不同的页, 同一实体分裂。那正是条目式的病, 不是 Wiki。
//   复用判定必须存在, 否则"一主题一页"只是口号 (本文件 findTopicPage 就是这一条的实现)。
//
// 边界 (这一层刻意不做什么):
//   · 不做语义合并/摘要重写 (那是 Dream 的活, 且必须有闸门);
//   · 不自动改规则页 (治理策略 frozen/readonly 在此生效);
//   · 路由是**确定性的**: 同输入同库必然同地址 (可重建、可测试)。
import type { WikiConfig } from "./config.ts";
import { defaultSection, governanceOf } from "./config.ts";
import { slug, type WikiAddress } from "./address.ts";
import { termStreams } from "../kernel/cjk.ts";
import { isFunctionWord } from "../kernel/function-words.ts";
import { applySectionWrite, emptyPage, listPages, readPage, writePage, type WikiPage } from "./page.ts";

/** 编译输入: 一轮对话的结论与来源。 */
export interface CompileInput {
  /** 提炼后的结论 (真相源要回答的是"现在什么成立")。 */
  content: string;
  /** 来源引用 (episode id / session / 原始对话定位)。 */
  source: string;
  /** 原始问题 (辅助路由判断)。 */
  question?: string;
}

export interface RouteDecision {
  addr: WikiAddress;
  /** 命中哪条规则 (可审计: 为什么写到这里)。 */
  why: string;
}

/** 强主题词: 标识符形状的可复用专名 (文件/模块/服务/缩写)。 */
const STRONG_PATTERNS: ReadonlyArray<RegExp> = [
  /[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g,
  /\b[A-Za-z][A-Za-z0-9]*[A-Z][a-z0-9]+\b/g,
  /\b[A-Z][A-Z0-9]{1,9}\b/g,
];

/** 弱主题词: 纯字母词 (人名如 alice 就落在这里 —— 它不是标识符形状, 却常是真正的主体)。 */
const WEAK_PATTERN = /\b[a-z][a-z]{2,}\b/g;

/** 弱词里的通用词 (它们是句法成分, 不是主题; 不收会让 "the/and/with" 变成页面名)。 */
const WEAK_STOP: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "this", "that", "not", "but", "all", "any", "can", "has",
  "have", "was", "were", "will", "would", "should", "could", "about", "into", "over", "under",
  "then", "than", "when", "where", "which", "while", "there", "their", "them", "these", "those",
  "only", "also", "just", "more", "most", "some", "such", "very", "well", "make", "made", "use",
  "used", "using", "get", "got", "set", "new", "old", "one", "two", "first", "last", "next",
  "before", "after", "because", "other", "same", "each", "both", "does", "did", "done", "test",
  "code", "file", "files", "true", "false", "null", "http", "https", "www", "todo", "fixme",
]);

/**
 * 主题名抽取: 页面名 = "这张页讲的是什么主题"。
 *
 * 判据按强度降级: 强专名 > 弱词(人名式) > 首短语。
 * 为什么需要弱词这一档: "alice 对花生过敏" 里没有任何标识符形状的专名, 只有 alice;
 * 缺了这一档就会退化成用整句话当主题, 导致同一实体每次写入都新开一页。
 */
export function topicOf(content: string): string {
  // 主题只由**正文**决定: 问句的主语常是"你/怎么/如何", 纳入只会污染主题抽取。
  const hay = content;
  // 候选合并后按**首次出现位置**取, 而不是按词频。
  // 为什么是位置 (2026-09-18 实测教训): 词频判据会把宾语当主语 ——
  // "user-service 依赖 order-service 的下单接口" 里 order-service 出现更多, 于是整条事实
  // 被并进 order-service 页 (错误合并); 而句首的 user-service 才是这条事实的主体。
  // 位置判据同时照顾了两类词: alice(弱词) 在句首时同样能胜出。
  const positions: Array<{ name: string; at: number; strong: boolean }> = [];
  for (const re of STRONG_PATTERNS) {
    for (const m of hay.matchAll(re)) {
      const name = m[0].trim();
      if (name.length < 3) continue;
      positions.push({ name, at: m.index ?? 0, strong: true });
    }
  }
  for (const m of hay.matchAll(WEAK_PATTERN)) {
    const name = m[0];
    if (WEAK_STOP.has(name)) continue;
    positions.push({ name, at: m.index ?? 0, strong: false });
  }
  if (positions.length) {
    positions.sort((a, b) => a.at - b.at || (a.strong === b.strong ? 0 : a.strong ? -1 : 1));
    return positions[0]!.name;
  }
  // 中文主题抽取 (2026-09-18 修复): 此前中文直接落到"整句截断 24 字"兜底, 实测
  // "缓存过期设为 60 秒" 的页面名就是整句本身 —— 于是同一主题每次写入都新开一页,
  // 聚合彻底失效 (实测 125 条 → 69 页, 其中 63 页只有 1 条来源 = 91%)。
  // 判据: 取**有区分度的词** (排除虚词; 复用 kernel/function-words 的封闭类词表,
  // 而不是另造一份 —— 同一类判据在全仓库只应有一处实现)。
  // 优先长词 (2-4 字的中文短语比 1 字更有主题性), 用 termStreams 的词流而非 bigram 流。
  const stream = termStreams(hay);
  const cjkWords = stream.words
    .filter((w) => /^[\u4e00-\u9fff]{2,}$/.test(w))
    .filter((w) => !isFunctionWord(w))
    .filter((w) => !WEAK_STOP.has(w.toLowerCase()));
  const cjkPicked = mostFrequentByLength(cjkWords);
  if (cjkPicked) return cjkPicked;
  const first = content.split(/[。;；\n,，]/)[0]?.trim() ?? "";
  return first.slice(0, 24) || "general";
}

/**
 * 挑中文主题词: 先按频率, 同频取**更长**者 (长词更有主题性; "缓存过期"优于"缓存")。
 * 稳定性: 频率与长度都相同时按首次出现顺序 —— 同输入必然同主题 (支撑重建幂等)。
 */
function mostFrequentByLength(candidates: readonly string[]): string | null {
  if (!candidates.length) return null;
  const freq = new Map<string, number>();
  for (const c of candidates) freq.set(c, (freq.get(c) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  let bestLen = 0;
  for (const c of candidates) {
    const n = freq.get(c) ?? 0;
    if (n > bestN || (n === bestN && c.length > bestLen)) {
      bestN = n;
      bestLen = c.length;
      best = c;
    }
  }
  return best;
}

/**
 * 主题词候选集合 (按强度降序: 强专名在前, 弱词在后)。
 * 复用判定需要**整个集合**而不只是最强的那个 —— 见 findTopicPage 的说明。
 */
export function topicCandidates(content: string, question?: string): string[] {
  const hay = question ? question + "\n" + content : content;
  const strong: string[] = [];
  for (const re of STRONG_PATTERNS) for (const m of hay.match(re) ?? []) strong.push(m.trim());
  const weak = (hay.match(WEAK_PATTERN) ?? []).filter((w) => !WEAK_STOP.has(w));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...strong.filter((x) => x.length >= 3), ...weak]) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= 8) break;
  }
  return out;
}

/** 路由: 决定一条事实进哪个目录、哪张页、哪个小节 (纯函数, 不读磁盘)。 */
export function route(content: string, cfg: WikiConfig, question?: string): RouteDecision {
  const hay = (question ? question + "\n" : "") + content;
  for (const rule of cfg.routing) {
    let re: RegExp;
    try {
      re = new RegExp(rule.when, "u");
    } catch {
      continue; // 坏规则不影响其它规则 (配置是业务侧输入)
    }
    if (re.test(hay)) {
      const domain = slug(rule.to);
      return {
        addr: { domain, page: slug(topicOf(content)), section: rule.section ?? defaultSection(cfg, domain) },
        why: "route:" + rule.when,
      };
    }
  }
  // 空 domains 必须走失败路径而不是崩溃 (旧实现用 cfg.domains[0]!.name 的非空断言,
  // 实测 domains: [] 直接抛 TypeError —— 配置是业务侧输入, 不能让它触发未捕获异常)。
  const fallback = cfg.domains.some((d) => slug(d.name) === "experiences")
    ? "experiences"
    : cfg.domains[0]
      ? slug(cfg.domains[0].name)
      : "experiences";
  return {
    addr: { domain: fallback, page: slug(topicOf(content)), section: defaultSection(cfg, fallback) },
    why: "route:fallback",
  };
}

/** 硬约束判定: 命中"进 rules"的规则时, 安全性优先于一切 (不受复用影响)。 */
function hardRuleAddr(content: string, cfg: WikiConfig, question?: string): RouteDecision | null {
  const hay = (question ? question + "\n" : "") + content;
  for (const rule of cfg.routing) {
    if (slug(rule.to) !== "rules") continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.when, "u");
    } catch {
      continue;
    }
    if (re.test(hay)) {
      return {
        addr: {
          domain: "rules",
          page: slug(topicOf(content)),
          section: rule.section ?? defaultSection(cfg, "rules"),
        },
        why: "route:" + rule.when,
      };
    }
  }
  return null;
}

/**
 * 主题页复用 (**reuse** 动作): 已有页在讲同一主题就并进去, 不再新开一页。
 *
 * 为什么它是范式的成败点: "一主题一页"要求同一实体收敛到同一处。只做 create 的话,
 * 每次写入都按当前内容的主题词新开页, 同一实体就会分裂成多张近义页 ——
 * 那恰好退回条目式 (相关性只能靠检索临时重建)。实测初版正是如此:
 * "alice 对花生过敏" 与 "alice 也在做 api-docs" 落到了两张页。
 *
 * 判据用**候选主题词集合**而不是单个主题词: 第二条内容的"最强主题词"是 api-docs (它出现更多),
 * 但 alice 也在集合里, 而 alice 页已存在 —— 用单点匹配必然漏掉这次复用。
 *
 * 保守性 (宁可不复用, 也不误并 —— 过度合并会退回单文件式, 是另一个极端):
 *   · 只按**主题词候选**匹配, 不做模糊语义相似 (那需要 LLM 裁决, 属 Dream);
 *   · 同一候选命中多张页时按**最近更新**取一张, 避免在两张近义页之间反复横跳。
 */
function findTopicPage(
  root: string,
  topicCandidates: readonly string[],
  now: string,
): { page: WikiPage; domain: string; pageName: string; how: string } | null {
  const keys = topicCandidates.map((t) => slug(t).toLowerCase()).filter((k) => k.length >= 3);
  if (!keys.length) return null;
  const hits: Array<{ page: WikiPage; domain: string; pageName: string; updated: string; how: string }> = [];
  for (const meta of listPages(root)) {
    const p = readPage(root, meta, now);
    if (!p) continue;
    const pageName = meta.page.toLowerCase();
    // 1) 页名相同 —— 最强信号 (地址就是主题本身), 无需看正文。
    const nameHit = keys.some((k) => pageName === k);
    if (nameHit) {
      hits.push({ page: p, domain: meta.domain, pageName: meta.page, updated: p.updated, how: "page-name" });
      continue;
    }
    // 2) 正文命中 —— 只认**词边界/整段相等**, 不再是裸子串。
    //    裸子串 (旧实现 body.includes(k)) 无 IDF、无边界: 实测 "order-service 的订单表新增 refunded"
    //    与 "user-service 依赖 order-service 的下单接口" 因共享 order-service 而被并成一页,
    //    而后者 route() 单独判它应去 projects —— 静默污染真值。同理 "a" 会命中任何含 a 的词。
    //    现在的判据: 候选词作为**完整行**出现, 或作为 ASCII 词的边界匹配 / 中文词被标点包围。
    const bodyText = p.sections.map((s) => s.body).join("\n");
    const bodyHit = keys.some((k) => segmentContains(bodyText, k));
    if (bodyHit) hits.push({ page: p, domain: meta.domain, pageName: meta.page, updated: p.updated, how: "body-token" });
  }
  if (!hits.length) return null;
  // 优先"页名命中"; 同类按最近更新取一张 (避免在两张近义页之间反复横跳)。
  hits.sort((a, b) => {
    if (a.how !== b.how) return a.how === "page-name" ? -1 : 1;
    return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.pageName < b.pageName ? -1 : 1;
  });
  const best = hits[0]!;
  return { page: best.page, domain: best.domain, pageName: best.pageName, how: best.how };
}

/**
 * 词级包含判定 (有边界, 取代裸子串)。
 *
 * 判据分两类:
 *   · 含非 ASCII (中文等): 用分隔符/标点/行边界包围 —— 不能靠 ^$ 词边界 (中文没有空格);
 *   · 纯 ASCII: 用词边界, 避免 "api" 命中 "rapid"。
 */
function segmentContains(text: string, key: string): boolean {
  const low = text.toLowerCase();
  const k = key.toLowerCase();
  if (!k) return false;
  if (/[^\x00-\x7f]/.test(k)) {
    let from = 0;
    for (;;) {
      const i = low.indexOf(k, from);
      if (i < 0) return false;
      const before = i === 0 ? "" : low[i - 1]!;
      const after = low[i + k.length] ?? "";
      const isBound = (ch: string): boolean => ch === "" || /[\s\p{P}\p{S}]/u.test(ch);
      if (isBound(before) && isBound(after)) return true;
      from = i + 1;
    }
  }
  return new RegExp("(^|[^a-z0-9])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)").test(low);
}

export interface CompileResult {
  addr: WikiAddress;
  action: "created" | "updated" | "reused" | "rejected";
  /** 拒绝原因 (治理策略拦下时给出, 不静默丢弃)。 */
  reason?: string;
  why: string;
}

/**
 * 编译一条事实进页面 (读 → 改 → 整体写回)。
 *
 * 决策顺序 (安全性 > 收敛 > 路由):
 *   1. 硬约束 → rules (红线永远进规则页, 不受复用影响);
 *   2. reuse → 已存在同主题页 (同一实体收敛, 这是"一主题一页"的落地);
 *   3. route → 按配置规则新建/定位页。
 * 治理策略在写入前生效: readonly 目录**不接受对话写入** (配置的硬规则, 不是提示词)。
 */
export function compileInto(
  root: string,
  cfg: WikiConfig,
  input: CompileInput,
  at: string,
): CompileResult {
  const topic = slug(topicOf(input.content));
  const candidates = topicCandidates(input.content, input.question);

  // 1) 硬约束优先。
  const hard = hardRuleAddr(input.content, cfg, input.question);
  let addr: WikiAddress;
  let why: string;
  let reusedPage: WikiPage | null = null;
  let action: CompileResult["action"] = "created";

  // 先算路由 —— **小节永远由路由决定**, 这是复用的前提条件 (见下方 A3 说明)。
  const decision = route(input.content, cfg, input.question);

  if (hard) {
    addr = hard.addr;
    why = hard.why;
  } else {
    // 2) 复用同主题页 (同一实体收敛到一处, 这是"一主题一页"的落地)。
    const found = findTopicPage(root, [topic, ...candidates], at);
    // 跨域复用的守卫 (2026-09-18 盲审发现的静默污染):
    //   旧实现对**任何**跨域命中都复用, 并把 section 无条件改写为 found 目录的默认小节 ——
    //   实测 "alice 对花生过敏" → people/alice#禁忌, 再写 "alice 负责的项目上线排期有阻塞"
    //   仍落进 people/alice#禁忌 (而 route() 单独判它应去 projects#目标)。
    //   项目事实被记进人物页的"禁忌"节 —— 语义错位且无人察觉。
    //   现在两条守卫同时生效:
    //     · 目录不同域时, 只在**页名精确命中** (主题就是这个页) 才复用 —— 正文词面巧合不足以跨域拉人;
    //     · section **一律取路由结果**, 不再用 defaultSection 覆盖。
    // 守卫必须用**主主题**(topic)而不是任意候选词: 候选集合里含次要实体, 用它做跨域复用会让
    // "user-service 依赖 order-service 的接口" 被并进 order-service 页 (实测)。
    // 现在: 同域可复用; 跨域则要求**该页的页名恰好等于本条的主主题**(即这条就是在讲这张页)。
    // 唯一判据: **该页的页名恰好等于本条的主主题** —— 即这条事实就是在讲这张页。
    // 不再用"同域即可复用": 同域里的错误合并同样会污染真值 (实测 user-service 事实被并入
    // 同属 experiences 的 order-service 页)。判据一刀切更可预测, 也更容易被测试钉住。
    const crossDomainSafe = found ? found.pageName.toLowerCase() === topic.toLowerCase() : false;
    if (found && crossDomainSafe && governanceOf(cfg, found.domain) !== "readonly") {
      addr = { domain: found.domain, page: found.pageName, section: decision.addr.section };
      why = "reuse:" + found.domain + "/" + found.pageName + " (" + found.how + ")";
      reusedPage = found.page;
      action = "reused";
    } else {
      addr = decision.addr;
      why = decision.why;
    }
  }

  const gov = governanceOf(cfg, addr.domain);
  if (gov === "readonly") {
    return { addr, action: "rejected", reason: "domain is readonly: " + addr.domain, why };
  }

  const existing = reusedPage ?? readPage(root, addr, at);
  const page =
    existing ??
    emptyPage(addr, cfg.pageTemplates[slug(addr.domain)] ?? [defaultSection(cfg, addr.domain)], at);
  const section = addr.section ?? defaultSection(cfg, addr.domain);
  const before = page.sections.find((s) => s.name === section)?.body ?? "";
  const updated = applySectionWrite(page, section, mergeBody(before, input.content), {
    sources: [input.source],
    action: before ? "updated" : "added",
    at,
    ...(input.question ? { note: "驱动问题: " + input.question.slice(0, 60) } : {}),
  });
  writePage(root, updated);
  return { addr, action: existing ? action : "created", why };
}

/**
 * 小节正文的合并策略: **追加而非覆盖**。
 *
 * 为什么: 同一主题的多条事实是**互补**的 (它们本应聚在一页) —— 覆盖会让后来的挤掉先前的,
 * 那正是单文件式"删哪条由长度决定"的老毛病。真正的"取代/冲突消解"属于 Dream 的合并决策,
 * 不在确定性编译层做 (本层只保证不丢信息)。
 */
function mergeBody(before: string, next: string): string {
  const prev = before.trim();
  const add = next.trim();
  if (!prev) return add;
  // 幂等判据必须是**整段相等**, 不能是单向 includes。
  // 反例 (2026-09-18 盲审实测): 写 "A" → 写 "A\nB" → 再写 "A", 单向 includes 会在
  // 第二次写入时判定 "A\nB".includes("A") 为真而跳过, 于是第三次写入 "A" 时
  // 正文变成 "A\nA\nB" —— "A" 出现 2 次。原单测只测"连续两次同内容",
  // 那恰好是唯一安全的序列 (测试盲区)。
  // **行级差量追加**: 整段追加会把它自己携带的"已存在行"再写一遍 ——
  // 实测 写"A" → 写"A\nB" 会让正文变成 "A\nA\nB" (第一次已写过的 "A" 被第二段带进来重复)。
  // 现在只并入尚未出现过的行: 既保持"追加而非覆盖"(不丢信息), 又保证幂等(不重复)。
  const lines = new Set(prev.split("\n").map((l) => l.trim()).filter(Boolean));
  const incoming = add.split("\n").map((l) => l.trim()).filter(Boolean);
  const fresh = incoming.filter((l) => !lines.has(l));
  if (!fresh.length) return prev;
  return prev + "\n" + fresh.join("\n");
}
