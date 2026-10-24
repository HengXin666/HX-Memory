// external/canonical.ts — 迁移用的唯一数据形状。引擎私有字段不准进这里。
import { createHash, randomBytes } from "node:crypto";

/** 包格式。不认识的版本直接拒绝, 以免静默读错。 */
export const CANONICAL_FORMAT = "hx-canonical/1" as const;

export type MemoryKind = "decision" | "correction" | "preference" | "episode";
export type MemoryStatus = "active" | "invalidated";
export type IndexState = "pending" | "indexed";

/**
 * 一条记忆。正文、种类、实体、取代关系都属于我们。
 * 引擎内部的 uuid、向量、图节点 id 不在此列。
 */
export interface CanonicalMemory {
  id: string;
  bankId: string;
  kind: MemoryKind;
  text: string;
  entities: string[];
  supersedes: string[];
  status: MemoryStatus;
  createdAt: string;
  indexState: IndexState;
}

/** 一份文档。图片只作为该文档引用的附件, 不单独变成记忆。 */
export interface CanonicalAsset {
  path: string;
  caption?: string;
  mediaType?: string;
  /** 可选原图。没有字节时, 召回至少还能用 caption。 */
  bytesBase64?: string;
}

export interface CanonicalDoc {
  id: string;
  corpusId: string;
  path: string;
  markdown: string;
  assets: CanonicalAsset[];
  sha256: string;
  updatedAt: string;
  indexState: IndexState;
}

export interface CanonicalBundle {
  format: typeof CANONICAL_FORMAT;
  bankId: string;
  records: CanonicalMemory[];
}

export interface CorpusBundle {
  format: typeof CANONICAL_FORMAT;
  corpusId: string;
  docs: CanonicalDoc[];
}

/** 工作区 bank。优先 git remote, 否则用绝对路径。不同仓库不会撞车。 */
export function workspaceBankId(root: string, remote?: string): string {
  const key = (remote?.trim() || root.trim()).replace(/\/+$/, "");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return "ws_" + digest;
}

export function newCanonicalId(): string {
  return "hx_" + randomBytes(12).toString("hex");
}

export function docSha(doc: Pick<CanonicalDoc, "markdown" | "assets">): string {
  const extra = doc.assets.map((a) => a.path + "\0" + (a.caption ?? "")).join("\n");
  return createHash("sha256").update(doc.markdown + "\n" + extra).digest("hex");
}

export function assertSafeId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new Error(label + " 含有不能作为路径的字符: " + id);
  }
}

export function parseBundle(raw: unknown): CanonicalBundle {
  const obj = asRecord(raw);
  if (obj.format !== CANONICAL_FORMAT) {
    throw new Error("不认识的记忆包格式: " + String(obj.format));
  }
  if (typeof obj.bankId !== "string") throw new Error("记忆包缺少 bankId");
  assertSafeId(obj.bankId, "bankId");
  if (!Array.isArray(obj.records)) throw new Error("记忆包缺少 records");
  const records = obj.records.map((row) => parseMemory(row, obj.bankId as string));
  return { format: CANONICAL_FORMAT, bankId: obj.bankId, records };
}

export function parseCorpus(raw: unknown): CorpusBundle {
  const obj = asRecord(raw);
  if (obj.format !== CANONICAL_FORMAT) {
    throw new Error("不认识的文档包格式: " + String(obj.format));
  }
  if (typeof obj.corpusId !== "string") throw new Error("文档包缺少 corpusId");
  assertSafeId(obj.corpusId, "corpusId");
  if (!Array.isArray(obj.docs)) throw new Error("文档包缺少 docs");
  const docs = obj.docs.map((row) => parseDoc(row, obj.corpusId as string));
  return { format: CANONICAL_FORMAT, corpusId: obj.corpusId, docs };
}

function parseMemory(raw: unknown, bankId: string): CanonicalMemory {
  const row = asRecord(raw);
  const id = requiredString(row, "id");
  assertSafeId(id, "memory.id");
  if (row.bankId !== bankId) throw new Error("记忆 " + id + " 的 bankId 与包不一致");
  const kind = row.kind;
  if (kind !== "decision" && kind !== "correction" && kind !== "preference" && kind !== "episode") {
    throw new Error("记忆 " + id + " 的 kind 不合法");
  }
  const status = row.status === "invalidated" ? "invalidated" : "active";
  const indexState = row.indexState === "indexed" ? "indexed" : "pending";
  return {
    id,
    bankId,
    kind,
    text: requiredString(row, "text"),
    entities: stringList(row.entities),
    supersedes: stringList(row.supersedes),
    status,
    createdAt: requiredString(row, "createdAt"),
    indexState,
  };
}

function parseDoc(raw: unknown, corpusId: string): CanonicalDoc {
  const row = asRecord(raw);
  const id = requiredString(row, "id");
  assertSafeId(id, "doc.id");
  if (row.corpusId !== corpusId) throw new Error("文档 " + id + " 的 corpusId 与包不一致");
  const assets = Array.isArray(row.assets) ? row.assets.map(parseAsset) : [];
  const markdown = requiredString(row, "markdown");
  const doc: CanonicalDoc = {
    id,
    corpusId,
    path: requiredString(row, "path"),
    markdown,
    assets,
    sha256: typeof row.sha256 === "string" ? row.sha256 : "",
    updatedAt: requiredString(row, "updatedAt"),
    indexState: row.indexState === "indexed" ? "indexed" : "pending",
  };
  doc.sha256 = doc.sha256 || docSha(doc);
  return doc;
}

function parseAsset(raw: unknown): CanonicalAsset {
  const row = asRecord(raw);
  const asset: CanonicalAsset = { path: requiredString(row, "path") };
  if (typeof row.caption === "string") asset.caption = row.caption;
  if (typeof row.mediaType === "string") asset.mediaType = row.mediaType;
  if (typeof row.bytesBase64 === "string") asset.bytesBase64 = row.bytesBase64;
  return asset;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("canonical 条目不是对象");
  return raw as Record<string, unknown>;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) throw new Error("缺少字段 " + key);
  return value;
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}
