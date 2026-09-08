// src/storage/file-store.ts — FileBackend: 真相在文件, 索引在 SQLite (可重建).
// 布局:
//   <root>/daily/YYYY-MM-DD.md      每日捕获 (原始, 人可读, git 可 diff)
//   <root>/digest/YYYY-MM-DD.md     整理后知识 (lesson/pattern/context)
//   <root>/rules/<id>.md            推广后的跨项目规则 (人工确认后才落盘, 一文件一条)
//   <root>/index.sqlite             派生索引 (memories/relations/tags 三表), 删除可重建
//
// 文件格式 (format: 2):
//   多个条目 = 若干块用空行分隔; 每块是 frontmatter + 空行 + 正文;
//   正文里"看起来像块边界"的行会被转义 (反斜杠前缀), 反斜杠本身也加倍 ——
//   因此正文无法伪造块, 且往返无损。
//   时间戳字段 (valid_at/asserted_at) 必须是 Z 结尾的 ISO 串 (YYYY-MM-DDTHH:mm:ss(.sss)Z):
//   它们参与文件名与时间切片, 不合法就 fail-closed 拒绝/跳过并记 warning。
//   第一个块之前的文本是"手写前言", 原样保留 (写入时会 trimEnd 归一化尾部空白);
//   最后一个块之后的文本属于该条目正文 (没有块结束标记, 无法与正文区分)。
//   块间分隔符规范写法是空行; 读取容忍单换行, 但此时"正文以换行结尾"会丢一个换行 (歧义)。
//   注意: 旧索引里若存在非法 relation 行 (早期解析器不校验), 对该条目 update() 会抛错,
//   先 rebuildFromFiles() 即可恢复。
//
// 不变量:
//   1. 真相在文件, 索引可重建且**无损**: relations/tags/structured 全部写进文件并可读回。
//   2. 双时态 validAt/assertedAt 每条必带, 且必须是 ISO 时间戳 (防换行注入伪造字段)。
//   3. kind:"rule" 必须带确认记录才允许入库 —— add() 与 rebuildFromFiles() 同一套闸门。
//   4. 正文不能伪造块边界 (写入转义), 所有 frontmatter 值都不能含换行。
//   5. 撤回 (remove) 在真相文件里写 status: shadow —— 只改索引的话, 重建会让它复活。
//   6. 并发打开同一个 index.sqlite 不能直接炸: 打开后立刻设 busy_timeout。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import type {
  MemoryEntry,
  MemoryEntryInput,
  MemoryKind,
  MemoryStatus,
  MemoryScope,
  Query,
  Relation,
  RelationType,
} from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";

const DAILY_DIR = "daily";
const DIGEST_DIR = "digest";
const RULES_DIR = "rules";
const INDEX_NAME = "index.sqlite";
const FORMAT_VERSION = 2;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "event",
  "decision",
  "lesson",
  "rule",
  "pattern",
  "context",
];
const SCOPES: readonly MemoryScope[] = ["project", "agent", "global"];
const STATUSES: readonly MemoryStatus[] = ["active", "superseded", "shadow"];
const RELATION_TYPES: readonly RelationType[] = [
  "relates",
  "supersedes",
  "supersededBy",
  "generalizes",
  "appliesTo",
  "source",
];

function nowIso(): string {
  return new Date().toISOString();
}

function entryId(): string {
  return "m" + randomUUID().replace(/-/g, "").slice(0, 16);
}

function kindToDir(kind: MemoryKind): string {
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

/** 单行 frontmatter 值: 换行会伪造后续字段 (甚至伪造整块), 一律压平。 */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function isIso(value: string): boolean {
  return ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** Relative file path for an entry inside its kind dir (id/日期都做字符集校验, 防路径穿越)。 */
function fileFor(entry: MemoryEntry): string {
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
function normalizeEntry(input: MemoryEntryInput & { id: string }): MemoryEntry {
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

export interface FileBackendConfig {
  root: string;
  /**
   * true = remove() 从真相文件里摘掉该块 (文件空了才删文件);
   * false (默认) = 在真相文件里写 status: shadow, 保留可审计的撤回记录。
   */
  allowTruthDelete?: boolean;
}

interface RowLike {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  scope: MemoryScope;
  valid_at: string;
  asserted_at: string;
  status: MemoryStatus;
  confirmed_by: string | null;
  confirmed_at: string | null;
  project: string | null;
  structured: string | null;
  file: string;
}

export class FileBackend implements MemoryStore {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly allowTruthDelete: boolean;
  /** 重建/解析过程中被跳过的条目 (fail-closed 的证据, 供测试与诊断读取)。 */
  private readonly skipped: string[] = [];

  constructor(config: FileBackendConfig) {
    this.root = config.root;
    this.allowTruthDelete = config.allowTruthDelete ?? false;
    for (const d of [
      this.root,
      join(this.root, DAILY_DIR),
      join(this.root, DIGEST_DIR),
      join(this.root, RULES_DIR),
    ]) {
      mkdirSync(d, { recursive: true });
    }
    this.db = new DatabaseSync(join(this.root, INDEX_NAME));
    // 多进程 (web host + CLI / 两个 dsh 实例) 共享同一份索引时必须等待而不是直接失败。
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();
    // 索引丢了但真相还在 → 自动重建, 否则记忆会"静默消失"。
    const rows = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    if (rows.n === 0 && this.hasTruthFiles()) this.rebuildFromFiles();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        scope TEXT NOT NULL,
        valid_at TEXT NOT NULL,
        asserted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        confirmed_by TEXT,
        confirmed_at TEXT,
        project TEXT,
        structured TEXT,
        file TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relations (
        from_id TEXT NOT NULL,
        type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        weight REAL,
        PRIMARY KEY (from_id, type, to_id)
      );
      CREATE TABLE IF NOT EXISTS tags (
        memory_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (memory_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);
    `);
    // 迁移: 老库没有 structured 列 (索引是派生物, 加列不丢真相)。
    // check-then-ALTER 非原子: 并发打开时可能撞 duplicate column, 这里吞掉该错误。
    const columns = this.db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "structured")) {
      try {
        this.db.exec("ALTER TABLE memories ADD COLUMN structured TEXT");
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
  }

  /** 真相目录里是否存在 Markdown (用于判断"索引为空"是首次使用还是索引丢失)。 */
  private hasTruthFiles(): boolean {
    for (const dir of [DAILY_DIR, DIGEST_DIR, RULES_DIR]) {
      const base = join(this.root, dir);
      if (existsSync(base) && walkMd(base).length > 0) return true;
    }
    return false;
  }

  /** 最近一次 rebuild/解析跳过的条目 (fail-closed 的可观测证据)。 */
  warnings(): readonly string[] {
    return this.skipped;
  }

  /** 从文件重建索引 (真相 → 索引)。索引丢失后调用 (构造函数也会自动调用一次)。 */
  rebuildFromFiles(): number {
    this.skipped.length = 0;
    const seen = new Map<string, MemoryEntry>();
    for (const dir of [DAILY_DIR, DIGEST_DIR, RULES_DIR]) {
      const base = join(this.root, dir);
      if (!existsSync(base)) continue;
      for (const f of walkMd(base)) {
        for (const parsed of parseEntryBlocks(f, this.skipped)) {
          const previous = seen.get(parsed.id);
          // 同一 id 出现在多个文件 (kind/日期变更的残留): 取 assertedAt 较新的, 不依赖遍历顺序。
          if (previous === undefined || parsed.ts.assertedAt > previous.ts.assertedAt) {
            seen.set(parsed.id, parsed);
            if (previous !== undefined) {
              this.skipped.push("duplicate id " + parsed.id + " in " + f + " (kept newer)");
            }
          } else {
            this.skipped.push("duplicate id " + parsed.id + " in " + f + " (kept newer)");
          }
        }
      }
    }
    this.db.exec("DELETE FROM memories; DELETE FROM relations; DELETE FROM tags;");
    let indexed = 0;
    for (const e of seen.values()) if (this.indexEntry(e)) indexed++;
    return indexed;
  }

  /** 写入索引; 未确认的 rule 一律拒绝 (与 add() 同一套闸门, 重建也不能绕过)。 */
  private indexEntry(e: MemoryEntry): boolean {
    if (e.kind === "rule" && !isConfirmed(e)) {
      this.skipped.push("unconfirmed rule " + e.id + " rejected at index time");
      return false;
    }
    let file: string;
    try {
      file = fileFor(e);
    } catch (error) {
      this.skipped.push(String(error));
      return false;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories (id, kind, content, source, scope, valid_at, asserted_at, status, confirmed_by, confirmed_at, project, structured, file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.kind,
        e.content,
        e.source,
        e.scope,
        e.ts.validAt,
        e.ts.assertedAt,
        e.status ?? "active",
        e.confirmedBy ?? null,
        e.confirmedAt ?? null,
        e.project ?? null,
        e.structured ? JSON.stringify(e.structured) : null,
        file,
      );
    for (const rel of e.relations ?? []) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO relations (from_id, type, to_id, weight) VALUES (?, ?, ?, ?)",
        )
        .run(e.id, rel.type, rel.toId, rel.weight ?? null);
    }
    for (const tag of e.tags?.length ? e.tags : extractTags(e.content)) {
      this.db.prepare("INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)").run(e.id, tag);
    }
    return true;
  }

  /** 写真相文件 (upsert) + 建索引。rule 必须已确认。 */
  add(entry: MemoryEntryInput): MemoryEntry {
    const full = normalizeEntry({
      ...entry,
      id: entry.id ?? entryId(),
      ts: {
        validAt: entry.ts?.validAt ?? nowIso(),
        assertedAt: entry.ts?.assertedAt ?? nowIso(),
      },
    });
    if (full.kind === "rule" && !isConfirmed(full)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    this.writeEntry(full);
    return full;
  }

  /**
   * 写真相文件 + 索引 (add/update 共用的唯一写路径)。
   * 若同一 id 之前落在别的文件 (kind/日期变了), 先把旧块摘掉, 避免重建时同 id 两份。
   */
  private writeEntry(entry: MemoryEntry): void {
    const relative = fileFor(entry);
    const file = join(this.root, relative);
    const previous = this.db.prepare("SELECT file FROM memories WHERE id = ?").get(entry.id) as
      { file: string } | undefined;
    // 索引里存的是相对路径, 必须与相对路径比较 —— 否则每次 update 都会误判"换了文件",
    // 先把块摘掉再追加 (条目被挪到文件末尾 + 中间崩溃窗口)。
    if (previous && previous.file !== relative) {
      const oldFile = join(this.root, previous.file);
      if (existsSync(oldFile)) removeBlockFromFile(oldFile, entry.id);
    }
    upsertBlockInFile(file, entry);
    this.db.prepare("DELETE FROM relations WHERE from_id = ?").run(entry.id);
    this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(entry.id);
    this.indexEntry(entry);
  }

  get(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      RowLike | undefined;
    return row ? this.hydrate(row) : null;
  }

  /** 最近捕获的 N 条 (按 assertedAt 倒序), 附 tags。供知情权面板用。 */
  recent(limit = 20): MemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE status != 'shadow' ORDER BY asserted_at DESC, rowid DESC LIMIT ?",
      )
      .all(limit) as unknown as RowLike[];
    return rows.map((r) => this.hydrate(r));
  }

  query(q: Query): MemoryEntry[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (!q.includeShadow) clauses.push("status != 'shadow'");
    if (q.kind) {
      clauses.push("kind = ?");
      params.push(q.kind);
    }
    if (q.scope) {
      clauses.push("scope = ?");
      params.push(q.scope);
    }
    if (q.tag) {
      clauses.push("id IN (SELECT memory_id FROM tags WHERE tag = ?)");
      params.push(q.tag);
    }
    if (q.text) {
      // LIKE 元字符转义: 否则 query({text:"_"}) 会命中全部。
      const escaped = q.text.replace(/[\\%_]/g, (ch) => "\\" + ch);
      clauses.push("(content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')");
      params.push("%" + escaped + "%", "%" + escaped + "%");
    }
    if (q.at) {
      clauses.push("valid_at <= ?");
      params.push(q.at);
    }
    if (q.project) {
      clauses.push("project = ?");
      params.push(q.project);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const limit = q.limit ?? 50;
    const rows = this.db
      .prepare("SELECT * FROM memories" + where + " ORDER BY valid_at DESC, rowid DESC LIMIT ?")
      .all(...params, limit) as unknown[];
    return (rows as RowLike[]).map((r) => this.hydrate(r));
  }

  /** 全量条目 (不截断): warmUp/重建等需要完整集合的调用点。 */
  all(): MemoryEntry[] {
    return this.query({ limit: Number.MAX_SAFE_INTEGER });
  }

  /** 关系遍历: 只返回存活 (非 shadow) 的邻居, 与 query 的可见性一致。 */
  traverse(fromId: string, relationType: string): MemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT m.* FROM memories m JOIN relations r ON r.to_id = m.id WHERE r.from_id = ? AND r.type = ? AND m.status != 'shadow'",
      )
      .all(fromId, relationType) as unknown[];
    return (rows as RowLike[]).map((r) => this.hydrate(r));
  }

  update(id: string, patch: Partial<MemoryEntry>): void {
    const existing = this.get(id);
    if (!existing) throw new Error("not found: " + id);
    const merged = normalizeEntry({
      ...existing,
      ...patch,
      id,
      ts: patch.ts ?? existing.ts,
      relations: patch.relations ?? existing.relations,
      tags: patch.tags ?? existing.tags,
    });
    if (merged.kind === "rule" && !isConfirmed(merged)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    this.writeEntry(merged);
  }

  /**
   * 移除条目。
   * - allowTruthDelete=true: 从真相文件里摘掉该块 (同日其他条目不受影响), 索引行删除;
   * - 默认: 真相文件写 status: shadow (可审计), 索引置 shadow —— 重建不会复活。
   * 两种情况都保留关系/标签行: 对方的真相文件里仍声明着指向它的关系, 删行会让索引与真相互不一致。
   */
  remove(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    const file = join(this.root, fileFor(existing));
    if (this.allowTruthDelete) {
      if (existsSync(file)) removeBlockFromFile(file, id);
      this.db.prepare("DELETE FROM relations WHERE from_id = ?").run(id);
      this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      return;
    }
    if (existing.status !== "shadow" && existsSync(file)) {
      upsertBlockInFile(file, { ...existing, status: "shadow" });
    }
    this.db.prepare("UPDATE memories SET status='shadow' WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  get indexFile(): string {
    return join(this.root, INDEX_NAME);
  }

  /** 行 → 完整条目 (含 relations/tags), 避免调用方拿到"半个记忆"。 */
  private hydrate(row: RowLike): MemoryEntry {
    const e = rowToEntry(row);
    const rels = this.db
      .prepare("SELECT type, to_id, weight FROM relations WHERE from_id = ?")
      .all(row.id) as Array<{ type: RelationType; to_id: string; weight: number | null }>;
    if (rels.length) {
      e.relations = rels.map((r) => ({
        type: r.type,
        toId: r.to_id,
        ...(r.weight === null ? {} : { weight: r.weight }),
      }));
    }
    const tags = this.db.prepare("SELECT tag FROM tags WHERE memory_id = ?").all(row.id) as Array<{
      tag: string;
    }>;
    if (tags.length) e.tags = tags.map((t) => t.tag);
    return e;
  }
}

// ---------- helpers ----------

function rowToEntry(row: RowLike): MemoryEntry {
  let structured: MemoryEntry["structured"];
  if (row.structured) {
    try {
      const parsed = JSON.parse(row.structured) as MemoryEntry["structured"];
      if (parsed && typeof parsed.summary === "string") structured = parsed;
    } catch {
      structured = undefined;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    scope: row.scope,
    ts: { validAt: row.valid_at, assertedAt: row.asserted_at },
    status: row.status,
    confirmedBy: row.confirmed_by ?? undefined,
    confirmedAt: row.confirmed_at ?? undefined,
    project: row.project ?? undefined,
    ...(structured === undefined ? {} : { structured }),
  };
}

/** 块头: 每个块的 frontmatter 第一行必须是 id (写入与解析都依赖这个前缀)。 */
function blockHeader(id: string): string {
  return "---\nid: " + id + "\n";
}

/** 一个真相文件的解析结果: 块序列 + 第一个块之前的手写前言。 */
interface FileParts {
  /** 第一个块之前的原文 (手写笔记), 原样保留。 */
  preamble: string;
  blocks: string[];
}

/**
 * 读取文件结构 (未解析成条目的原始文本)。
 * 归一化: 去 BOM、CRLF/CR→LF、去掉写入时追加的结尾换行。
 * 切分容忍单个换行的块间分隔符 (手写/旧文件), 并保留第一个块之前的前言 ——
 * 否则"人可编辑的真相文件"会在下一次写入时被静默删掉块外内容。
 */
function readFileParts(file: string, skipped?: string[]): FileParts {
  if (!existsSync(file)) return { preamble: "", blocks: [] };
  const text = readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const payload = text.endsWith("\n") ? text.slice(0, -1) : text;
  const first = payload.search(/(^|\n)---\nid: /);
  if (first === -1) {
    if (payload.trim() !== "") skipped?.push("no entry block in " + file);
    return { preamble: payload, blocks: [] };
  }
  const preamble = payload.slice(0, first).replace(/\n+$/, "");
  const rest = payload.slice(first).replace(/^\n/, "");
  const pieces = rest.split(/\n(?=---\nid: )/);
  const blocks: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    // 块间分隔符: 规范写法是空行, 但单个换行也要容忍 —— 每个非末块恰好去掉一个分隔换行。
    let piece = pieces[i]!;
    if (i < pieces.length - 1 && piece.endsWith("\n")) piece = piece.slice(0, -1);
    if (!piece.startsWith("---\n")) {
      skipped?.push("unparsable block in " + file + ": " + JSON.stringify(piece.slice(0, 40)));
      continue;
    }
    blocks.push(piece);
  }
  return { preamble, blocks };
}

/** 写回文件结构 (没有块也没有前言 → 删除文件)。 */
function writeFileParts(file: string, parts: FileParts): void {
  const segments = [parts.preamble.trimEnd(), parts.blocks.join("\n\n")].filter(
    (s) => s.length > 0,
  );
  if (!segments.length) {
    if (existsSync(file)) rmSync(file);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, segments.join("\n\n") + "\n", "utf8");
}

/** 新增或替换某 id 的块 (按块数组重写, 不碰其它块与前言的字节)。 */
function upsertBlockInFile(file: string, e: MemoryEntry): void {
  const block = entryToMarkdown(e);
  const parts = readFileParts(file);
  const header = blockHeader(e.id);
  const index = parts.blocks.findIndex((b) => b.startsWith(header));
  if (index >= 0) parts.blocks[index] = block;
  else parts.blocks.push(block);
  writeFileParts(file, parts);
}

/** 摘掉某 id 的块 (文件不存在或无该块时是 no-op)。 */
function removeBlockFromFile(file: string, id: string): void {
  const parts = readFileParts(file);
  const header = blockHeader(id);
  const next = parts.blocks.filter((b) => !b.startsWith(header));
  if (next.length === parts.blocks.length) return;
  writeFileParts(file, { ...parts, blocks: next });
}

/** Parse every frontmatter block in a file into entries (multi-entry files). */
function parseEntryBlocks(path: string, skipped?: string[]): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const block of readFileParts(path, skipped).blocks) {
    const e = parseSingleBlock(block, path, skipped);
    if (e) out.push(e);
  }
  return out;
}

function parseSingleBlock(block: string, path: string, skipped?: string[]): MemoryEntry | null {
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
    tags: parseTags(tagsRaw),
  };
}

/** tags: 新格式是 JSON 数组; 旧格式是 "[a, b]" (逗号分隔, 含逗号的值会丢, 故新格式用 JSON)。 */
function parseTags(raw: string | undefined): string[] | undefined {
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

/** 关系字段守卫 (文件是外部可编辑的真相, 解析必须 fail-closed)。 */
function isRelation(value: unknown): value is Relation {
  if (typeof value !== "object" || value === null) return false;
  const r = value as { type?: unknown; toId?: unknown; weight?: unknown };
  return (
    typeof r.type === "string" &&
    RELATION_TYPES.includes(r.type as RelationType) &&
    typeof r.toId === "string" &&
    (r.weight === undefined || typeof r.weight === "number")
  );
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
    out.push({ type: m[1] as RelationType, toId, ...(weight === undefined ? {} : { weight }) });
  }
  return out;
}

function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/**
 * 正文转义 (可逆, 单射):
 *   1) 所有反斜杠加倍;
 *   2) 行首的 "---\nid: " 前加一个反斜杠。
 * 读取时逆序还原。这样正文永远无法伪造块边界, 且任意反斜杠组合都能逐字往返。
 */
function escapeBody(content: string): string {
  // 1) 反斜杠加倍 2) 真块边界前加一个反斜杠
  return content.replace(/\\/g, "\\\\").replace(/(^|\n)---\n(?=id: )/g, "$1\\---\n");
}

function unescapeBody(body: string): string {
  // 逆序还原: 先还原边界, 再把加倍的反斜杠折半
  return body.replace(/(^|\n)\\---\n(?=id: )/g, "$1---\n").replace(/\\\\/g, "\\");
}

function entryToMarkdown(e: MemoryEntry): string {
  const lines = [
    "---",
    "id: " + e.id,
    "kind: " + e.kind,
    "source: " + e.source,
    "scope: " + e.scope,
    "valid_at: " + e.ts.validAt,
    "asserted_at: " + e.ts.assertedAt,
    "status: " + (e.status ?? "active"),
    "format: " + FORMAT_VERSION,
  ];
  if (e.confirmedBy) lines.push("confirmed_by: " + e.confirmedBy);
  if (e.confirmedAt) lines.push("confirmed_at: " + e.confirmedAt);
  if (e.project) lines.push("project: " + e.project);
  if (e.tags?.length) lines.push("tags: " + JSON.stringify(e.tags));
  if (e.structured) lines.push("structured: " + JSON.stringify(e.structured));
  // relations 也放 frontmatter (JSON): 正文保持纯净, 避免"正文以 ## relations 开头"被误解析。
  if (e.relations?.length) lines.push("relations: " + JSON.stringify(e.relations));
  lines.push("---");
  lines.push("");
  lines.push(escapeBody(e.content));
  return lines.join("\n");
}

function extractTags(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g)) out.push(m[1]!);
  return out;
}

/** 确认记录口径与写入/解析一致 (空白串不算确认)。 */
function isConfirmed(e: MemoryEntry): boolean {
  return Boolean(singleLine(e.confirmedBy ?? "") && singleLine(e.confirmedAt ?? ""));
}
