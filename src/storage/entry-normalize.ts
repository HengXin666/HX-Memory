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
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error("invalid " + name + ": " + JSON.stringify(value));
  return Math.min(max, Math.max(min, n));
}

/** 字符串数组字段: 单行化 + 去重, 顺序即语义顺序。 */
export function stringList(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const out: string[] = [];
  for (const v of value) {
    const s = singleLine(String(v));
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : undefined;
}

/** 新条目的默认 id (m + 16 位十六进制)。 */
export function entryId(): string {
  return "m" + randomUUID().replace(/-/g, "").slice(0, 16);
}

/** 正文里的标签抽取 (无显式 tags 时的兜底)。 */
export function extractTags(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g)) out.push(m[1]!);
  return out;
}

/** 索引列里的 JSON 字符串数组 → string[] (坏值丢弃: 索引是派生物, 真相文件里仍在)。 */
export function jsonStrings(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const out = parsed.map((v) => String(v)).filter(Boolean);
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
  if (input.tags?.length) entry.tags = input.tags.map((t) => singleLine(String(t))).filter(Boolean);
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
