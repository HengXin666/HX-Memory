// storage/markdown-parse.ts — 真相文件的**解析**方向 (Markdown 块 → MemoryEntry)。
//
// 与 markdown-codec.ts 分成两个文件是因为职责与风险不同:
//   codec 负责"写出正确的块"(转义、前言保留、O(1) 追加);
//   parse 负责"从任何输入里安全地读出记忆"—— 它面对的是**可被外部编辑的文件**,
//   因此每一条校验都必须 fail-closed (坏块跳过并记 warning, 绝不让整批解析失败)。
//
// 解析的三层容错 (对应三种真实的坏输入):
//   1. 块级: 缺 frontmatter / id 非法 / kind/scope/status 越界 / 时间戳非 ISO → 整块跳过并记 warning;
//   2. 字段级: v2 可选字段 (importance/entities/时间戳) 坏值只丢该字段, 不让整条记忆消失;
//   3. 兼容级: 无 format 标记的旧文件允许 "## relations" 区段 (新格式一律走 frontmatter JSON)。
//
// **未知 frontmatter 键必须可被无损保留** (2026-09 补):
// 解析只认识当前代码里的键, 但文件可能由**更新版本**写过 (降级运行)、或被人手写。
// 此前写回是"整块重组", 于是更新一条记忆就把它身上所有陌生键静默吃掉 —— 任何迁移/整理
// 在那之前都是破坏性的。键级工具在 storage/frontmatter.ts (parse 与 codec 共用的单一事实源)。
import { readdirSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryKind, MemoryScope, MemoryStatus, Relation } from "../kernel/types.ts";
import { ID_PATTERN, KINDS, SCOPES, STATUSES, isIso, isRelation } from "./entry-normalize.ts";
import { normalizeFeedback } from "../kernel/feedback.ts";
import { frontmatterFields } from "./frontmatter.ts";
import { readFileParts, unescapeBody } from "./markdown-codec.ts";

/** Parse every frontmatter block in a file into entries (multi-entry files). */
export function parseEntryBlocks(path: string, skipped?: string[]): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const block of readFileParts(path, skipped).blocks) {
    const e = parseSingleBlock(block, path, skipped);
    if (e) out.push(e);
  }
  return out;
}

/** frontmatter 里的 JSON 字符串数组 (非法值 → undefined, 不抛)。 */
function parseStringArray(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // 与 parseTags 同一口径 (2026-09-18, §538): **不做强转**。
      // String(null)/String(1) 都是非空串, 会骗过 filter(Boolean) —— 而这里服务的是
      // entities/derivedFrom/mergedFrom 三个 id 数组, 垃圾值会进索引并参与 byEntities。
      const out = parsed.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
  } catch {
    // 落到 undefined
  }
  return undefined;
}

function parseOptionalNumber(
  raw: string | undefined,
  name: string,
  id: string,
  skipped?: string[],
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    skipped?.push("invalid " + name + " for " + id + ": " + JSON.stringify(raw));
    return undefined;
  }
  return n;
}

function parseOptionalIso(
  raw: string | undefined,
  name: string,
  id: string,
  skipped?: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (!isIso(raw)) {
    skipped?.push("invalid " + name + " for " + id + ": " + JSON.stringify(raw));
    return undefined;
  }
  return raw;
}

/** tags: 新格式是 JSON 数组; 旧格式是 "[a, b]" (逗号分隔, 含逗号的值会丢, 故新格式用 JSON)。 */
/**
 * tag 只能是**非空字符串** —— 强转会把垃圾写进索引。
 *
 * ⚠ 为什么必须显式判类型 (2026-09-18, §508 排查发现): 旧实现是 `parsed.map((t) => String(t))`。
 * 而 `String(undefined) === "undefined"`、`String(null) === "null"` —— 两者都是**非空字符串**,
 * 于是 `.filter(Boolean)` **放行**。真库实测已有受害者:
 *
 * ```text
 * [session:tool] tags=["r376080139","r406636358","undefined"]   ← 内部 id 与 "undefined" 混进 tag 字段
 * [session:tool] tags=["10"]                                    ← 数字被强转
 * ```
 *
 * 那些垃圾 tag 会进 `tags` 表, 而 `neighbors.ts:86` 会用它们**扩大演化裁决的候选面**
 * (并且 `testing` 那种高频 tag 已有 125 条, 超过候选面上限 36 而被截断) ——
 * 所以"标签错了"不只是元数据脏, 它会改变**与谁比较**。
 */
function isTagString(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const low = t.trim().toLowerCase();
  if (low === "" || low === "undefined" || low === "null") return false;
  // ⚠ 还要挡**合法字符串形态**的垃圾 (2026-09-18 实测真库 113 个 tag 里有 10 个是垃圾):
  //   · 纯数字 ("10"/"1"/"13"): 来源是数组里的数字被 String() 强转 —— 它们**是合法字符串**,
  //     所以类型判据与哨兵判据都拦不住。人为标签不会是纯数字 (中文/英文词才是)。
  //   · 内部 id (r + hex, 如 "r376080139"): 那是**规则条目 id** 被误当 tag 写入。
  //   · 单字母 ("i") 与通用词 ("tag"): 没有任何检索价值。
  // 为什么不能只靠类型判据: 上报的受害者里 6/10 是数值型。
  if (/^\d+$/.test(low)) return false;
  if (/^r[0-9a-f]{6,}$/.test(low)) return false;
  // ⚠ **刻意不拦单字母** (2026-09-18 权衡): 真库里单字母 tag 只有 "i" **一个**,
  // 而一条形态规则 (^[a-z]$) 会误伤测试数据与未来可能的合法单字母标签。
  // 判据只拦**有明确证据**是垃圾的形态 (数值型 6 例 / 内部 id 2 例 / 哨兵)。
  // ⚠ 也**不能按长度砍**: 实测真库有大量长度 2~3 的**真标签** (认证/换号/闸门/VPS/反检测)。
  return true;
}

export function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isTagString).map((t) => t.trim()).filter(Boolean);
  } catch {
    // 旧格式, 落到下面的逗号解析
  }
  const legacy = raw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return legacy.length ? legacy : undefined;
}

/** 解析旧格式 "## relations" 区段里的 "- type: toId (w=0.5)" 行 (向后兼容)。 */
function parseRelationLines(section: string): Relation[] {
  const out: Relation[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^- ([A-Za-z]+): (.+)$/);
    if (!m) continue;
    let toId = m[2]!;
    let weight: number | undefined;
    const wm = toId.match(/ \(w=([0-9.]+)\)$/);
    if (wm) {
      weight = Number(wm[1]);
      toId = toId.slice(0, wm.index);
    }
    out.push({ type: m[1] as Relation["type"], toId, ...(weight === undefined ? {} : { weight }) });
  }
  return out;
}

export function parseSingleBlock(
  block: string,
  path: string,
  skipped?: string[],
): MemoryEntry | null {
  const fm = block.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fm) {
    skipped?.push("missing frontmatter in " + path);
    return null;
  }
  const head = fm[1] ?? "";
  const fields = frontmatterFields(head);
  const field = (name: string): string | undefined => fields.get(name)?.[0];
  const id = field("id");
  const kind = field("kind") as MemoryKind | undefined;
  const source = field("source");
  const scope = field("scope") as MemoryScope | undefined;
  const valid = field("valid_at");
  const asserted = field("asserted_at");
  const status = field("status") as MemoryStatus | undefined;
  const cb = field("confirmed_by");
  const ca = field("confirmed_at");
  const project = field("project");
  const tagsRaw = field("tags");
  const structuredRaw = field("structured");
  const relationsRaw = field("relations");
  const entitiesRaw = field("entities");
  const importanceRaw = field("importance");
  const confidenceRaw = field("confidence");
  const reinforcementRaw = field("reinforcement");
  const lastHitRaw = field("last_hit_at");
  const expiresRaw = field("expires_at");
  const derivedFromRaw = field("derived_from");
  const mergedFromRaw = field("merged_from");
  const feedbackRaw = field("feedback");
  // format 标记: 新文件一定带 format → 正文永远不被当作元数据扫描;
  // 旧文件 (无标记) 才允许走 "## relations" 兼容分支。
  const format = field("format") === undefined ? undefined : Number(field("format"));
  const legacyFormat = format === undefined || !Number.isFinite(format) || format < 1;
  if (!id || !ID_PATTERN.test(id)) {
    skipped?.push("invalid or missing id in " + path + ": " + JSON.stringify(id));
    return null;
  }
  if (!kind || !KINDS.includes(kind)) {
    skipped?.push("invalid kind for " + id + ": " + JSON.stringify(kind));
    return null;
  }
  if (!scope || !SCOPES.includes(scope)) {
    skipped?.push("invalid scope for " + id + ": " + JSON.stringify(scope));
    return null;
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    skipped?.push("invalid status for " + id + ": " + JSON.stringify(status));
    return null;
  }
  if (!valid || !isIso(valid)) {
    skipped?.push("invalid valid_at for " + id + ": " + JSON.stringify(valid));
    return null;
  }
  if (!asserted || !isIso(asserted)) {
    skipped?.push("invalid asserted_at for " + id + ": " + JSON.stringify(asserted));
    return null;
  }
  if (source === undefined) {
    skipped?.push("missing source for " + id);
    return null;
  }

  let body = block.slice(fm[0].length);
  if (body.startsWith("\n")) body = body.slice(1);

  // relations: 新格式在 frontmatter (JSON); 旧格式的 "## relations" 区段继续兼容读取。
  let relations: Relation[] | undefined;
  if (relationsRaw) {
    try {
      const parsed = JSON.parse(relationsRaw) as unknown;
      if (Array.isArray(parsed)) relations = parsed.filter(isRelation);
    } catch {
      relations = undefined;
    }
  }
  if (legacyFormat && !relations?.length && body.startsWith("## relations\n")) {
    const end = body.indexOf("\n\n");
    const section =
      end === -1 ? body.slice("## relations\n".length) : body.slice("## relations\n".length, end);
    relations = parseRelationLines(section);
    body = end === -1 ? "" : body.slice(end + 2);
  }

  let structured: MemoryEntry["structured"];
  if (structuredRaw) {
    try {
      const parsed = JSON.parse(structuredRaw) as MemoryEntry["structured"];
      if (parsed && typeof parsed.summary === "string") structured = parsed;
    } catch {
      structured = undefined;
    }
  }

  // v2 可选字段: 单个坏值只丢弃该字段并记 warning (不让整条记忆消失);
  // 但状态/时间戳这类"语义开关"仍 fail-closed (上面已拒绝整条)。
  const entities = parseStringArray(entitiesRaw);
  const derivedFrom = parseStringArray(derivedFromRaw);
  const mergedFrom = parseStringArray(mergedFromRaw);
  const importance = parseOptionalNumber(importanceRaw, "importance", id, skipped);
  const confidence = parseOptionalNumber(confidenceRaw, "confidence", id, skipped);
  const reinforcement = parseOptionalNumber(reinforcementRaw, "reinforcement", id, skipped);
  const lastHitAt = parseOptionalIso(lastHitRaw, "last_hit_at", id, skipped);
  const expiresAt = parseOptionalIso(expiresRaw, "expires_at", id, skipped);
  const feedback = parseRecallFeedback(feedbackRaw, id, skipped);

  return {
    id,
    kind,
    content: unescapeBody(body),
    source,
    scope,
    status: status ?? "active",
    ts: { validAt: valid, assertedAt: asserted },
    ...(cb === undefined ? {} : { confirmedBy: cb }),
    ...(ca === undefined ? {} : { confirmedAt: ca }),
    ...(project === undefined ? {} : { project }),
    ...(relations?.length ? { relations } : {}),
    ...(structured === undefined ? {} : { structured }),
    ...(entities === undefined ? {} : { entities }),
    ...(importance === undefined ? {} : { importance }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(reinforcement === undefined ? {} : { reinforcement }),
    ...(lastHitAt === undefined ? {} : { lastHitAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
    ...(mergedFrom === undefined ? {} : { mergedFrom }),
    ...(feedback === undefined ? {} : { feedback }),
    tags: parseTags(tagsRaw),
  };
}


/** 解析 feedback frontmatter: 坏值只丢该字段并记 warning (不让整条记忆消失)。 */
function parseRecallFeedback(
  raw: string | undefined,
  id: string,
  skipped?: string[],
): MemoryEntry["feedback"] {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    skipped?.push("invalid feedback JSON for " + id);
    return undefined;
  }
  const normalized = normalizeFeedback(parsed);
  if (normalized === undefined) skipped?.push("empty feedback for " + id);
  return normalized;
}

/** 从目录递归收集 .md 文件 (路径拼接与遍历都在这里, 调用方不必自己拼)。 */
export function walkMd(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** 原子写的临时文件标记 (与 markdown-codec 的 writeFileAtomic 同源)。 */
const ATOMIC_TMP_MARK = ".tmp-";

/**
 * 清扫原子写留下的临时文件。
 *
 * 为什么需要它 (2026-09-18): 原子写是 `tmp + rename` —— 正常路径下 tmp 会被 rename 消费掉
 * (实测写 10 次残留 0), 但**进程在 rename 前崩溃**时会留下一个孤儿 tmp。
 * 文件名是 `<原文件>.tmp-<pid>-<时间戳>` (**在 .md 之后追加**), 因此:
 *   · **不会被 `walkMd` 读成真相文件** (它只收 `endsWith(".md")`) —— 所以**不影响正确性**;
 *   · 但它**会永久累积** (此前没有任何清理机制)。
 *
 * 判据必须是"文件名含 .tmp- 且**不是** .md 结尾" —— 只看后缀会误删合法文件 (虽然当前没有那种)。
 * 另外**只删超过 1 小时的**: 刚产生的 tmp 可能属于一个**正在进行的写入**,
 * 删掉它会让那次写入的 rename 失败。
 *
 * @returns 被删除的文件路径 (供调用方记录/审计)。
 */
export function sweepAtomicTemps(
  dir: string,
  opts: { olderThanMs?: number; delete?: boolean } = {},
): string[] {
  const removed: string[] = [];
  const cutoff = Date.now() - (opts.olderThanMs ?? 60 * 60 * 1000);
  const shouldDelete = opts.delete ?? true;
  const visit = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        visit(p);
        continue;
      }
      if (!e.name.includes(ATOMIC_TMP_MARK) || e.name.endsWith(".md")) continue;
      try {
        if (statSync(p).mtimeMs > cutoff) continue; // 太新: 可能是正在进行的写入
        if (shouldDelete) rmSync(p, { force: true });
        removed.push(p); // delete=false 时这个数组就是"待清扫清单"
      } catch {
        // 单个文件失败不影响其余 (清扫是尽力而为的维护动作, 不该抛)。
      }
    }
  };
  visit(dir);
  return removed;
}
