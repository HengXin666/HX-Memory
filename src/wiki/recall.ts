// src/wiki/recall.ts — 读取侧**分层下钻**五级工具链 + 页面级检索。
//
// 依据: docs/kinfra-wiki-spec.md §5 (取: Agent 自己决定要查多深)。
// 它取代的不是"检索算法", 而是**一次到底的 top-k 形态**。三个固有问题 (原文):
//   一次性 (拿到结果而非线索, 没法追问) / 不可审计 (漏了什么看不出来) / 成本恒定
//   (问"我喜欢什么咖啡"和问"这条规则什么时候改的"付一样的代价)。
//
// 分层链 (前两级覆盖绝大多数请求, 后三级按需下钻):
//   matchPage → getPage → getEvidence → getEvolution → searchDialogue
//
// 硬规则 (原文): **摘要只用于定位"哪段对话", 不能被当作用户原话引用**。
// 因此 getEvidence 返回的是**引用** (定位), 不是摘要式断言; 原话必须回到原始对话。
//
// 边界: 本层只读。写入在 compile.ts。两者共用同一套地址 (读写共用地址是硬约束)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pagePath, slug, type WikiAddress } from "./address.ts";
import { listPages, readPage, type WikiPage, type WikiSection } from "./page.ts";
import { queryTerms } from "../retrieval/channels.ts";

/** 页面命中的一层 (为什么它被选中 —— 可审计)。 */
export interface PageMatch {
  domain: string;
  page: string;
  score: number;
  why: string;
}

/** 页面级词面打分 (BM25 同族思路, 但作用于"页"这一粒度)。 */
function scorePage(p: WikiPage, terms: string[]): { score: number; hitTerms: string[] } {
  const body = p.sections.map((s) => s.name + "\n" + s.body).join("\n").toLowerCase();
  const title = (p.domain + "/" + p.page).toLowerCase();
  let score = 0;
  const hitTerms: string[] = [];
  for (const t of terms) {
    const lt = t.toLowerCase();
    if (!lt) continue;
    const inTitle = title.includes(lt);
    const lower = body.split(lt).length - 1;
    if (inTitle || lower > 0) hitTerms.push(t);
    score += (inTitle ? 3 : 0) + Math.min(lower, 4);
  }
  // 命中词种类数是主导项: 覆盖多个查询词比单个词反复出现更能说明"这页就是讲它"。
  return { score: score + hitTerms.length * 2, hitTerms };
}

/** 第 1 级: matchPage —— 定位主题页 (绝大多数问题从这里开始)。 */
export function matchPage(root: string, query: string, limit = 5): PageMatch[] {
  // 用 weighted (已剔虚词与单字碎片) 而不是 terms: "的/用/一个"这类词在每张页里都出现,
  // 计入打分会让 page 匹配退化成"谁的正文长谁赢"(该判据的实测依据见 retrieval/channels.ts)。
  const terms = queryTerms(query).weighted;
  const out: PageMatch[] = [];
  for (const meta of listPages(root)) {
    const p = readPage(root, meta, "1970-01-01T00:00:00Z");
    if (!p) continue;
    const { score, hitTerms } = scorePage(p, terms);
    if (score <= 0) continue;
    out.push({
      domain: meta.domain,
      page: meta.page,
      score,
      why: "terms:" + hitTerms.slice(0, 6).join(","),
    });
  }
  return out.sort((a, b) => b.score - a.score || (a.page < b.page ? -1 : 1)).slice(0, limit);
}

/** 第 2 级: getPage —— 当前有效结论 (绝大多数问题在这里结束)。 */
export function getPage(
  root: string,
  addr: Pick<WikiAddress, "domain" | "page">,
  section?: string,
): WikiPage | null {
  const p = readPage(root, addr, "1970-01-01T00:00:00Z");
  if (!p) return null;
  if (!section) return p;
  const only = p.sections.filter((s) => slug(s.name) === slug(section));
  return only.length ? { ...p, sections: only } : { ...p, sections: [] };
}

/** 第 3 级: getEvidence —— 这条结论来自哪几轮对话 (引用, 不是摘要)。 */
export function getEvidence(
  root: string,
  addr: WikiAddress,
): Array<{ section: string; sources: string[]; body: string }> {
  const p = readPage(root, addr, "1970-01-01T00:00:00Z");
  if (!p) return [];
  const sections = addr.section ? p.sections.filter((s) => slug(s.name) === slug(addr.section!)) : p.sections;
  return sections.map((s) => ({ section: s.name, sources: [...s.sources], body: s.body }));
}

/** 第 4 级: getEvolution —— 它何时新增、被谁改写、为什么变。 */
export function getEvolution(
  root: string,
  addr: WikiAddress,
): Array<{ section: string; timeline: string[] }> {
  const p = readPage(root, addr, "1970-01-01T00:00:00Z");
  if (!p) return [];
  const sections = addr.section ? p.sections.filter((s) => slug(s.name) === slug(addr.section!)) : p.sections;
  return sections.map((s) => ({ section: s.name, timeline: [...s.timeline] }));
}

/** 第 5 级: searchDialogue —— 未经改写的原始对话 (原话的唯一来源)。 */
export interface DialogueStore {
  /** 按 session/turn 或 id 取原始轮次文本; 找不到返回 null。 */
  raw(idOrRef: string): string | null;
}

/**
 * 从来源引用里取出原始对话原文。
 *
 * 硬规则: 摘要**永不**被当作原话引用 —— 因此这里只接受**原始来源引用**,
 * 找不到就如实返回 null (不退回用小节正文冒充原话)。
 */
export function searchDialogue(store: DialogueStore, refs: readonly string[]): Array<{ ref: string; text: string }> {
  const out: Array<{ ref: string; text: string }> = [];
  for (const ref of refs) {
    const text = store.raw(ref);
    if (text !== null) out.push({ ref, text });
  }
  return out;
}

/** 注入用的页面正文拼装 (常驻 / 按需两档)。 */
export function renderForInjection(pages: readonly WikiPage[]): string {
  const out: string[] = [];
  for (const p of pages) {
    out.push("# " + p.domain + "/" + p.page);
    for (const s of p.sections) {
      if (!s.body.trim()) continue;
      out.push("## " + s.name);
      out.push(s.body.trim());
      for (const src of s.sources) out.push("- 来源: " + src);
    }
  }
  return out.join("\n");
}

/** 常驻页选择: 按配置的 resident 模式 (域名/页名通配)。 */
export function selectResident(root: string, resident: readonly string[]): WikiPage[] {
  const out: WikiPage[] = [];
  for (const meta of listPages(root)) {
    const full = meta.domain + "/" + meta.page;
    const hit = resident.some((pat) => {
      if (pat.endsWith("/*")) return slug(pat.slice(0, -2)) === slug(meta.domain);
      return slug(pat) === slug(full) || slug(pat) === slug(meta.page);
    });
    if (!hit) continue;
    const p = readPage(root, meta, "1970-01-01T00:00:00Z");
    if (p) out.push(p);
  }
  return out;
}

/** 页面是否存在 (供工具层判断"要不要下钻")。 */
export function pageExists(root: string, addr: Pick<WikiAddress, "domain" | "page">): boolean {
  return existsSync(join(root, pagePath(addr)));
}

export type { WikiPage, WikiSection };
export { readFileSync };
