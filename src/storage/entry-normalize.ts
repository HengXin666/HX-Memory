// storage/entry-normalize.ts — 入库边界的**归一化与校验** (纯函数, 无 IO)。
//
// 为什么独立成文件: 这些函数定义了"什么算合法的一条记忆"(枚举值域、ISO 时间戳、单行字段、
// 关系形状)。它们必须在写入**之前**执行, 且写入路径与重建路径共用同一套 ——
// 否则真相文件里的值与索引里的值会不一致, 表现为"重建后数据变了"这类极难排查的问题。
//
// 拆出来的直接收益: file-store.ts 从 1373 行降到可控规模, 而"什么合法"这条规则只有一处。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeFeedback } from "../kernel/feedback.ts";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  Relation,
  RelationType,
} from "../kernel/types.ts";

export const DAILY_DIR = "daily";
export const DIGEST_DIR = "digest";
export const RULES_DIR = "rules";
export const INDEX_NAME = "index.sqlite";
/** 真相文件格式版本 (新增可选 frontmatter 字段后递增)。 */
export const FORMAT_VERSION = 2;

export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "event",
  "decision",
  "lesson",
  "rule",
  "pattern",
  "context",
  // 知识库切片 (§795): 由外部 Markdown 导入, 不参与保底注入 (见 always-on 的显式排除)。
  "doc",
];
export const SCOPES: readonly MemoryScope[] = ["project", "agent", "global"];
export const STATUSES: readonly MemoryStatus[] = [
  "active",
  "superseded",
  "merged",
  "expired",
  "shadow",
];
export const RELATION_TYPES: readonly RelationType[] = [
  "relates",
  "supersedes",
  "supersededBy",
  "generalizes",
  "appliesTo",
  "source",
  // v2 关联性 (LinkService/EvolutionService 写入; 值域与运行时校验同一份真相)
  "mentions",
  "contradicts",
  "sameAs",
  "instanceOf",
  "derivedFrom",
];

export function nowIso(): string {
  return new Date().toISOString();
}

/** 单行 frontmatter 值: 换行会伪造后续字段 (甚至伪造整块), 一律压平。 */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function isIso(value: string): boolean {
  return ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** 可选数值字段: 非有限值 fail-closed 抛错, 越界收敛到值域 (v2 字段共用)。 */
export function numberField(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  // ⚠ **拒收 boolean** (§768 实测): `Number(true)` 是 **1**, 而 1 恰好落在 `importance` 的
  // 合法区间内 ⇒ 一个 `{"importance": true}` (LLM 常见的坏输出) 会**静默落成"最不重要"**,
  // 语义完全相反且无任何告警。`false` 同样落成 1。
  //
  // 为什么保留字符串数字 (`"9"`): LLM 把数字写成字符串是**无害的表示差异**, 而语义明确 ——
  // 拒收它会让本该成功的写入失败。判据是"**有没有确定的数值含义**", 而不是"类型是否 strict"。
  if (typeof value === "boolean") {
    throw new Error("invalid " + name + ": " + JSON.stringify(value) + " (期望数字, 收到布尔值)");
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error("invalid " + name + ": " + JSON.stringify(value));
  return Math.min(max, Math.max(min, n));
}

/** 字符串数组字段: 单行化 + 去重, 顺序即语义顺序。 */
export function stringList(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const out: string[] = [];
  for (const v of value) {
    // 与 parseTags/jsonStrings 同一口径 (2026-09-18, §538): 只接受真字符串。
    // TS 签名是 `readonly string[]`, 但**运行时**不保证 —— 而 `String(null) === "null"`
    // 会静默产生一个假值。若要防御, 就防到底 (而不是防一半)。
    if (typeof v !== "string") continue;
    const s = singleLine(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : undefined;
}

/** 新条目的默认 id (m + 16 位十六进制)。 */
export function entryId(): string {
  return "m" + randomUUID().replace(/-/g, "").slice(0, 16);
}

/** 正文里的标签抽取 (无显式 tags 时的兜底)。 */
/**
 * 从正文里抽 \`#tag\` 形式的标签 (缺 tags 字段时的兜底)。
 *
 * ⚠ **必须排除"编号引用"** (2026-09-18, §520 追到根因): 旧实现只做 \`/#(\\w+)/\` 匹配, 于是
 * 中文技术写作里**大量出现的 \`#1\`/\`#412\`/\`#9被挡\`** (章节或条目编号) 被当成标签写进索引。
 * 实测真库 14 个 \`#\` 片段里 **6 个是纯数字编号**, 另有 \`#undefined\`(字符串化) 与 \`#r376080139\`
 * (内部 id) —— 它们会进 \`tags\` 表, 而 \`neighbors.ts\` 用 tag **扩大演化裁决的候选面**。
 *
 * 判据只拦**有明确形态证据**的 (与 \`parseTags\` 的 \`isTagString\` 同一口径):
 *   · 纯数字 (\`#1\`/\`#412\`) 与**数字开头带中英文后缀** (\`#9被挡\`/\`#3a\`) —— 编号引用;
 *   · 哨兵 \`undefined\`/\`null\`;
 *   · 内部 id (\`r\` + 长十六进制)。
 * 而 \`#ppt\`/\`#ff88ff\` 这类**保留** —— 它们是真正的手写标签。
 */
export function extractTags(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g)) {
    const tag = m[1]!;
    const low = tag.toLowerCase();
    // ⚠ 只拦**纯数字** (\u00231/\u0023412) —— 不能拦"数字开头" (2026-09-18, §520 我自己踩的):
    // 真库里有 **\u0023401回归** 这种**真标签** (讲 401 回归测试), 而 `^\d` 会误杀它。
    // 而 `\u00239被挡` (数字+中文编号) 仍需拦 —— 所以判据是"纯数字 或 数字开头的编号式后缀"。
    if (/^\d+$/.test(tag)) continue;
    if (/^\d+[\u4e00-\u9fa5]+$/.test(tag) && tag.length <= 6) continue;  // \u00239被挡 这类短编号
    if (low === "undefined" || low === "null") continue;
    if (/^r[0-9a-f]{6,}$/.test(low)) continue;
    // ⚠ **占位符形态** (2026-09-18, §541 由真库验收脚本抓到):
    // 我在**记录这个缺陷本身**时, 正文里用 \`#N\`/\`#xxx\` 指代"任意标签" —— 它们被抽了出来。
    // 那暴露了判据的一个盲区: **单字母 (N/i) 与占位词 (xxx/tag)** 既不是编号也不是哨兵。
    // 判据: 单字母 ASCII 一律不抽 (中文单字仍是真标签, 不受影响) + 占位词黑名单。
    // 为什么单字母可以在这里拦、而 parseTags 里刻意不拦: 两处**证据不同** ——
    // parseTags 服务的是**用户显式写的 tags 字段** (那里出现单字母更像真标签), 而这里是**正文兜底抽取**
    // (正文里 "#i" 更可能是引用符号)。
    if (/^[a-z]$/.test(low)) continue;
    if (low === "xxx" || low === "yyy" || low === "zzz" || low === "tag" || low === "tags") continue;
    out.push(tag);
  }
  return out;
}

/**
 * 索引列里的 JSON 字符串数组 → string[] (坏值丢弃: 索引是派生物, 真相文件里仍在)。
 *
 * ⚠ **不做强转** (2026-09-18, §538 横向排查): 旧实现是 `parsed.map((v) => String(v)).filter(Boolean)`,
 * 而 `String(null) === "null"`、`String(1) === "1"` 都是**非空字符串** ⇒ `filter(Boolean)` 放行。
 * 这与 `parseTags` (§511) 是**完全同型的缺陷**, 服务的是 `entities`/`derivedFrom`/`mergedFrom`
 * 三个 id 数组 —— 而 `"null"`/`"undefined"`/`"1"` **不是实体键也不是 id**, 一旦进索引就会
 * 参与 `byEntities` 反查。
 *
 * 实测真库这三个字段目前**干净** (0 垃圾), 所以这是**加固**而不是修既有数据。
 */
function isStringItem(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const low = v.trim().toLowerCase();
  return low !== "" && low !== "undefined" && low !== "null";
}

export function jsonStrings(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const out = parsed.filter(isStringItem).map((v) => v.trim()).filter(Boolean);
      return out.length ? out : undefined;
    }
  } catch {
    // 索引损坏不该影响读取其它字段
  }
  return undefined;
}

/** 索引列里的可空数值 → number | undefined (NaN/Infinity 视为缺失)。 */
export function finiteOrUndefined(raw: number | null | undefined): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** 关系字段守卫 (文件是外部可编辑的真相, 解析必须 fail-closed)。 */
export function isRelation(value: unknown): value is Relation {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { type?: unknown; toId?: unknown; weight?: unknown };
  return (
    typeof r.type === "string" &&
    RELATION_TYPES.includes(r.type as RelationType) &&
    typeof r.toId === "string" &&
    (r.weight === undefined || typeof r.weight === "number")
  );
}

export function kindToDir(kind: MemoryKind): string {
  switch (kind) {
    case "rule":
      return RULES_DIR;
    case "lesson":
    case "pattern":
    case "context":
      return DIGEST_DIR;
    default:
      return DAILY_DIR;
  }
}

/** Relative file path for an entry inside its kind dir (id/日期都做字符集校验, 防路径穿越)。 */
export function fileFor(entry: MemoryEntry): string {
  if (!ID_PATTERN.test(entry.id)) {
    throw new Error("invalid memory id: " + JSON.stringify(entry.id));
  }
  if (entry.kind === "rule") return join(RULES_DIR, entry.id + ".md");
  const day = entry.ts.validAt.slice(0, 10);
  if (!DAY_PATTERN.test(day)) {
    throw new Error("invalid validAt day: " + JSON.stringify(entry.ts.validAt));
  }
  return join(kindToDir(entry.kind), day + ".md");
}

/**
 * 入库边界归一化: 枚举值域、ISO 时间戳、单行字段、标签/关系形状。
 * 必须在写入**之前**做, 这样索引与真相文件里的值完全一致 (否则重建后数据会"变")。
 */
export function normalizeEntry(input: MemoryEntryInput & { id: string }): MemoryEntry {
  if (!ID_PATTERN.test(input.id)) throw new Error("invalid memory id: " + JSON.stringify(input.id));
  if (!KINDS.includes(input.kind)) throw new Error("invalid kind: " + JSON.stringify(input.kind));
  if (!SCOPES.includes(input.scope))
    throw new Error("invalid scope: " + JSON.stringify(input.scope));
  const status = input.status ?? "active";
  if (!STATUSES.includes(status)) throw new Error("invalid status: " + JSON.stringify(status));
  const validAt = input.ts?.validAt ?? nowIso();
  const assertedAt = input.ts?.assertedAt ?? nowIso();
  if (!isIso(validAt)) throw new Error("invalid validAt: " + JSON.stringify(validAt));
  if (!isIso(assertedAt)) throw new Error("invalid assertedAt: " + JSON.stringify(assertedAt));

  const entry: MemoryEntry = {
    id: input.id,
    kind: input.kind,
    // 正文统一 LF: CRLF 会让整份文件解析不出条目 (自动重建会把"解析不出"放大成"记忆消失")
    content: (input.content ?? "").replace(/\r\n?/g, "\n"),
    source: singleLine(input.source ?? ""),
    scope: input.scope,
    ts: { validAt, assertedAt },
    status,
  };
  if (input.project !== undefined) entry.project = singleLine(input.project);
  if (input.confirmedBy !== undefined) entry.confirmedBy = singleLine(input.confirmedBy);
  if (input.confirmedAt !== undefined) entry.confirmedAt = singleLine(input.confirmedAt);
  // 同上: 不做强转 (null 会被 String() 变成 "null" 而 filter(Boolean) 放行)。
  if (input.tags?.length) {
    entry.tags = input.tags.filter((t): t is string => typeof t === "string").map((t) => singleLine(t)).filter(Boolean);
  }
  if (input.structured) entry.structured = input.structured;

  // ---- v2 字段: 归一化口径与索引/真相文件完全一致 (否则重建后数据会"变") ----
  const entities = stringList(input.entities);
  if (entities) entry.entities = entities;
  const importance = numberField(input.importance, "importance", 1, 10);
  if (importance !== undefined) entry.importance = importance;
  const confidence = numberField(input.confidence, "confidence", 0, 1);
  if (confidence !== undefined) entry.confidence = confidence;
  const reinforcement = numberField(input.reinforcement, "reinforcement", 0, 1_000_000);
  if (reinforcement !== undefined) entry.reinforcement = Math.floor(reinforcement);
  if (input.lastHitAt !== undefined) {
    if (!isIso(input.lastHitAt))
      throw new Error("invalid lastHitAt: " + JSON.stringify(input.lastHitAt));
    entry.lastHitAt = input.lastHitAt;
  }
  if (input.expiresAt !== undefined) {
    if (!isIso(input.expiresAt))
      throw new Error("invalid expiresAt: " + JSON.stringify(input.expiresAt));
    entry.expiresAt = input.expiresAt;
  }
  const derivedFrom = stringList(input.derivedFrom);
  if (derivedFrom) entry.derivedFrom = derivedFrom;
  const mergedFrom = stringList(input.mergedFrom);
  if (mergedFrom) entry.mergedFrom = mergedFrom;
  const feedback = normalizeFeedback(input.feedback);
  if (feedback !== undefined) entry.feedback = feedback;
  if (input.relations?.length) {
    // fail-closed: 非法关系不能静默丢弃 (否则索引与真相都少一条链, 且无人知道)。
    entry.relations = input.relations.map((r) => {
      if (!isRelation(r)) throw new Error("invalid relation: " + JSON.stringify(r));
      return {
        type: r.type,
        toId: singleLine(r.toId),
        ...(r.weight === undefined ? {} : { weight: r.weight }),
      };
    });
  }
  return entry;
}

/** 确认记录口径与写入/解析一致 (空白串不算确认)。 */
export function isConfirmed(e: MemoryEntry): boolean {
  return Boolean(singleLine(e.confirmedBy ?? "") && singleLine(e.confirmedAt ?? ""));
}
