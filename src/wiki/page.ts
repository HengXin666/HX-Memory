// src/wiki/page.ts — 页面文件的读写 (Markdown 形态, 真相在文件)。
//
// 依据: docs/kinfra-wiki-spec.md §3 (六要素) 与 §9.2 (文件形态)。
// 一张记忆页的六要素: 目录 / 小节 / 适用范围与来源 / 双向链接 / 时间线与证据入口 / 编辑入口。
//
// 与既有 truth-in-files (ADR-002) 的关系: 页面同样是**文件真值** —— git 可 diff、可人读、
// 索引可重建。本文件不引入任何数据库容器。
//
// 不变量:
//   1. 小节是证据与 blame 的最小粒度 —— 每次写入都在**小节**粒度落账 (新增/删除分别记);
//   2. 双向链接存一次两边可达 —— A→B 的链接写在 A 的「链接」区, 反向由 B 的链接区承载;
//   3. 页面可整体重写 —— 因此身份由地址决定 (pageId), 不由内容决定;
//   4. 正文不可伪造结构 —— 正文里形如 "## " 或 "---" 的行必须转义 (同 markdown-codec 的坑)。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pageId, pagePath, slug, WIKI_DIR, type WikiAddress } from "./address.ts";

/** 页内一个小节 (正文 + 来源/适用范围/时间线)。 */
export interface WikiSection {
  name: string;
  /** 该小节当前认为成立的结论正文 (可能多行)。 */
  body: string;
  /** 来源: 驱动本小节写入的原始对话 / 条目引用 (证据入口)。 */
  sources: string[];
  /** 适用范围: 这条结论在什么条件下成立。 */
  scope?: string;
  /** 时间线: 新增 / 改写 / 退役记录 (演化史)。 */
  timeline: string[];
}

/** 一条双向链接 (跨主题关系; 存一次两边可达)。 */
export interface WikiLink {
  to: string;
  /** 为什么相关 (可审计)。 */
  why?: string;
}

export interface WikiPage {
  id: string;
  domain: string;
  page: string;
  sections: WikiSection[];
  links: WikiLink[];
  updated: string;
}

const LINKS_HEADING = "链接";

/**
 * 正文转义: 防止正文伪造页结构。
 *
 * 三类必须挡住 (每一类都对应一个被实测证实的伪造通道):
 *   1. 小节标题 "## " —— 否则一条记忆能在重建后长出假小节;
 *   2. 页边界 "---" —— 否则能伪造 frontmatter;
 *   3. **元数据行** "- 来源: / - 时间线: / - 适用范围: " —— 这是 2026-09-18 盲审发现的通道:
 *      解析器把这些行从正文里摘出来当元数据 [page.ts 解析段], 于是正文里写
 *      "- 来源: 伪造证据" 会让 getEvidence 返回并不存在的证据引用, 直接击穿
 *      "摘要不得当原话引用" 这条硬规则 (recall.ts 的 searchDialogue 依赖 sources 可信)。
 *      只转义前两类是不够的 —— 当时的单测也只覆盖了 "## " 那一类 (测试盲区)。
 */
export function escapeBody(text: string): string {
  return text
    .replace(/^(#{2,6} )/gm, "\\$1")
    .replace(/^---$/gm, "\\---")
    .replace(/^- (适用范围|来源|时间线): /gm, "\\- $1: ");
}

export function unescapeBody(text: string): string {
  return text
    .replace(/^\\(#{2,6} )/gm, "$1")
    .replace(/^\\---$/gm, "---")
    .replace(/^\\- (适用范围|来源|时间线): /gm, "- $1: ");
}

/** 新页骨架 (含页面模板给出的固定小节)。 */
export function emptyPage(
  addr: Pick<WikiAddress, "domain" | "page">,
  templateSections: readonly string[],
  now: string,
): WikiPage {
  return {
    id: pageId(addr),
    domain: slug(addr.domain),
    page: slug(addr.page),
    sections: templateSections.map((name) => ({ name, body: "", sources: [], timeline: [] })),
    links: [],
    updated: now,
  };
}

/** 页面 → Markdown (纯函数; 形态见 spec §9.2)。 */
export function renderPage(p: WikiPage): string {
  const head = [
    "---",
    "page: " + p.page,
    "domain: " + p.domain,
    "id: " + p.id,
    "updated: " + p.updated,
    "---",
    "",
  ].join("\n");
  const body: string[] = [];
  for (const s of p.sections) {
    body.push("## " + s.name, "");
    // 空正文就输出空行, **不用哨兵**: 旧实现用 "(空)" 作占位, 而正文恰好是字面量 "(空)"
    // 的事实往返后会被吞成空字符串 (2026-09-18 盲审实测)。空行本身已能表达"无正文"。
    body.push(escapeBody(s.body).trim(), "");
    // scope 单行化: 含换行时第二行会被解析器当正文行吸进 body (实测污染正文)。
    if (s.scope) body.push("- 适用范围: " + s.scope.replace(/\s*\n\s*/g, " "));
    for (const src of s.sources) body.push("- 来源: " + String(src).replace(/\s*\n\s*/g, " "));
    for (const t of s.timeline) body.push("- 时间线: " + String(t).replace(/\s*\n\s*/g, " "));
    body.push("");
  }
  body.push("## " + LINKS_HEADING, "");
  if (p.links.length === 0) body.push("(无)");
  for (const l of p.links) body.push("- [[" + l.to + "]]" + (l.why ? " — " + l.why : ""));
  body.push("");
  return head + body.join("\n");
}

/** Markdown → 页面 (解析失败返回 null; 不做猜测式修复)。 */
export function parsePage(text: string, addr: Pick<WikiAddress, "domain" | "page">, now: string): WikiPage | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return null;
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*): (.*)$/);
    if (kv) fields.set(kv[1]!, kv[2] ?? "");
  }
  const rest = text.slice(m[0].length);
  const page: WikiPage = {
    id: fields.get("id") ?? pageId(addr),
    domain: fields.get("domain") ?? slug(addr.domain),
    page: fields.get("page") ?? slug(addr.page),
    sections: [],
    links: [],
    updated: fields.get("updated") ?? now,
  };
  // 按 "## " 切小节。
  const chunks = rest.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const name = (nl >= 0 ? chunk.slice(0, nl) : chunk).trim();
    const content = nl >= 0 ? chunk.slice(nl + 1) : "";
    if (name === LINKS_HEADING) {
      for (const line of content.split("\n")) {
        const lm = line.match(/^- \[\[([^\]]+)\]\](?: — (.*))?$/);
        if (lm) page.links.push({ to: lm[1]!, ...(lm[2] ? { why: lm[2] } : {}) });
      }
      continue;
    }
    const bodyLines: string[] = [];
    const sources: string[] = [];
    const timeline: string[] = [];
    let scope: string | undefined;
    for (const line of content.split("\n")) {
      const meta = line.match(/^- (适用范围|来源|时间线): (.*)$/);
      if (meta) {
        const v = meta[2] ?? "";
        if (meta[1] === "来源") sources.push(v);
        else if (meta[1] === "时间线") timeline.push(v);
        else scope = v;
        continue;
      }
      bodyLines.push(line);
    }
    const body = unescapeBody(bodyLines.join("\n")).trim();
    page.sections.push({
      name,
      body,
      sources,
      timeline,
      ...(scope ? { scope } : {}),
    });
  }
  return page;
}

/** 读取页面 (不存在返回 null)。 */
export function readPage(root: string, addr: Pick<WikiAddress, "domain" | "page">, now: string): WikiPage | null {
  const file = join(root, pagePath(addr));
  if (!existsSync(file)) return null;
  return parsePage(readFileSync(file, "utf8"), addr, now);
}

/** 写入页面 (创建目录; 整体重写该页 —— 页正是"可整体重写的单元")。 */
export function writePage(root: string, p: WikiPage): void {
  const file = join(root, pagePath(p));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPage(p), "utf8");
}

/** 删除页面文件 (退役到墓碑页时用; 墓碑页本身由调用方写入)。 */
export function deletePageFile(root: string, addr: Pick<WikiAddress, "domain" | "page">): void {
  const file = join(root, pagePath(addr));
  if (existsSync(file)) rmSync(file, { force: true });
}

/** 列出所有页面地址 (按 domain 分组; 供分层工具与 Dream 扫描)。 */
export function listPages(root: string): Array<{ domain: string; page: string; file: string }> {
  const base = join(root, WIKI_DIR);
  if (!existsSync(base)) return [];
  const out: Array<{ domain: string; page: string; file: string }> = [];
  for (const d of readdirSync(base, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(base, d.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      out.push({ domain: d.name, page: f.name.replace(/\.md$/, ""), file: join(base, d.name, f.name) });
    }
  }
  return out.sort((a, b) => (a.domain + "/" + a.page < b.domain + "/" + b.page ? -1 : 1));
}

/**
 * 在某页上按**小节**落一次写入账 (新增/改写/退役), 返回新页。
 *
 * 为什么账落在小节而不是页: 小节是证据与 blame 的最小粒度 ——
 * 只有落到小节, "这句话是怎么来的"才回答得了 (spec §6.3)。
 */
export function applySectionWrite(
  page: WikiPage,
  section: string,
  body: string,
  opts: { sources?: string[]; scope?: string; action: "added" | "updated"; at: string; note?: string },
): WikiPage {
  const sections = page.sections.map((s) => ({ ...s, sources: [...s.sources], timeline: [...s.timeline] }));
  let target = sections.find((s) => s.name === section);
  if (!target) {
    target = { name: section, body: "", sources: [], timeline: [] };
    sections.push(target);
  }
  const before = target.body;
  target.body = body;
  for (const src of opts.sources ?? []) if (!target.sources.includes(src)) target.sources.push(src);
  if (opts.scope) target.scope = opts.scope;
  const delta =
    opts.action === "added"
      ? "新增"
      : before === body
        ? "无改动"
        : "改写 (" + before.length + "→" + body.length + " 字)";
  target.timeline.push(opts.at + " " + delta + (opts.note ? " · " + opts.note : ""));
  return { ...page, sections, updated: opts.at };
}
