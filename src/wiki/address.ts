// src/wiki/address.ts — Wiki 记忆的三级地址模型 (目录, 页面, 小节)。
//
// 依据: docs/kinfra-wiki-spec.md §2/§9.1 (KInfra Memory 的存储规格)。
// 三条硬约束 (缺一不可, 它们不是并列功能而是一条链):
//   1. 一主题一页 —— 物理聚合, 一次读取就是一个完整判断, 不靠相似度拼碎片;
//   2. 读写共用同一个地址 —— 写入定下的位置, 读取回到同一个位置;
//   3. 页是可整体重写的单元 —— 独立预算/时间线/演化史/重写风险边界 (页级重构的前提)。
//
// 语法与词汇的边界 (本文件是**语法**侧, 不可由业务改):
//   语法 = 三级地址、一主题一页、读写共用地址、证据链与演化记录
//   词汇 = 有哪些目录、页面模板、路由规则、注入与治理策略 → 见 wiki/config.ts
//
// 边界: 纯函数 + 类型, 无 IO、无宿主依赖 (与 kernel/ 同一约束)。
import { createHash } from "node:crypto";

/** 目录名: 业务可配的"词汇"。默认目录见 DEFAULT_DOMAINS。 */
export type DomainName = string;

/** 页面名: 一主题一页。用 slug 形态, 保证可作文件名。 */
export type PageName = string;

/** 小节名: 页内的结构单元,**证据与 blame 的最小粒度**。 */
export type SectionName = string;

/** 三级地址。读写共用这一个值 —— 它是"可寻址"的唯一载体。 */
export interface WikiAddress {
  domain: DomainName;
  page: PageName;
  /** 缺省表示"整页" (读整页, 或写入时由路由决定小节)。 */
  section?: SectionName;
}

/** 默认目录 (通用助理形态)。业务可从默认增量扩展, 不必从零设计。 */
export const DEFAULT_DOMAINS = [
  "people",
  "projects",
  "preferences",
  "rules",
  "experiences",
] as const;

export const WIKI_DIR = "wiki";

/**
 * slug 归一: 把一个主题名变成可作文件名、可稳定比较的键。
 *
 * 为什么必须归一: 地址要"读写共用", 同一个主题两种写法 (大小写/空格/全角) 会让两次写入
 * 落到两张页上 —— 那恰好退化成条目式 (相关性只能靠检索临时重建)。归一化就是这一条的保证。
 * 中文不做转写 (保留原字), 只统一分隔符与大小写: 主题名的可读性对人和模型都重要。
 */
export function slug(value: string): string {
  const s = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "unnamed";
}

/** 地址的规范字符串形式 (稳定键; 用于去重、索引与调试输出)。 */
export function addressKey(addr: WikiAddress): string {
  // 各段先 slug 归一: 地址是**唯一可寻址键**, 必须只有一种写法。
  // 不归一时 domain 里的 "/" 会与分隔符混淆 —— addressKey({domain:"a/b",page:"p"}) 得 "a/b/p",
  // 再解析回来是 {domain:"a", page:"b/p"} (静默错位, 盲审实测)。归一后 slug("a/b")="a-b",
  // 于是 parseAddressKey 的往返自校验能真正发现歧义并返回 null。
  const d = slug(addr.domain);
  const p = slug(addr.page);
  return addr.section ? d + "/" + p + "#" + addr.section : d + "/" + p;
}

/** 页面相对路径 (相对 root)。页面文件形态见 docs/kinfra-wiki-spec.md §9.2。 */
export function pagePath(addr: Pick<WikiAddress, "domain" | "page">): string {
  return WIKI_DIR + "/" + slug(addr.domain) + "/" + slug(addr.page) + ".md";
}

/**
 * 页 id: 由地址**内容寻址**, 而不是随机值。
 *
 * 为什么不用随机 id: 页面是可整体重写的单元, 它的身份必须由"它是什么页"决定,
 * 否则重写一次就换一次身份, 链接与证据链全部断裂。与条目 id (随机) 的取舍相反 ——
 * 条目是"一次断言", 页面是"一个主题"; 前者要不可变引用, 后者要稳定地址。
 */
export function pageId(addr: Pick<WikiAddress, "domain" | "page">): string {
  const canonical = slug(addr.domain) + "/" + slug(addr.page);
  return "w" + createHash("sha256").update(canonical).digest("hex").slice(0, 15);
}

/** 解析地址键 ("domain/page#section") 回结构体。解析失败返回 null (不做猜测)。 */
export function parseAddressKey(key: string): WikiAddress | null {
  const m = key.match(/^([^/#]+)\/([^#]+)(?:#(.+))?$/);
  if (!m) return null;
  const parsed: WikiAddress = {
    domain: m[1]!,
    page: m[2]!,
    ...(m[3] ? { section: m[3] } : {}),
  };
  // 往返自校验 (2026-09-18 盲审发现): domain 含 "/" 时 ("a/b/p") 旧实现会**静默**解析成
  // {domain:"a", page:"b/p"} —— 号称"解析失败返回 null (不做猜测)", 却给出错误结构体。
  // 判据改为: 解析结果必须能重构出原键, 否则视为失败。地址是读写共用键, 静默错位会让
  // 后续写入落到另一张页上, 而这正是条目式的病。
  return addressKey(parsed) === key ? parsed : null;
}
