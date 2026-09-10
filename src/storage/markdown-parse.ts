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
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryKind, MemoryScope, MemoryStatus, Relation } from "../kernel/types.ts";
import { ID_PATTERN, KINDS, SCOPES, STATUSES, isIso, isRelation } from "./entry-normalize.ts";
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
      const out = parsed.map((v) => String(v)).filter(Boolean);
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
export function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map((t) => String(t)).filter(Boolean);
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
  const field = (name: string): string | undefined =>
    head.match(new RegExp("^" + name + ": (.*)$", "m"))?.[1];
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
  // format 标记: 新文件一定带 format → 正文永远不被当作元数据扫描;
  // 旧文件 (无标记) 才允许走 "## relations" 兼容分支。
  const legacyFormat = field("format") === undefined;
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
    tags: parseTags(tagsRaw),
  };
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
