// src/storage/file-store.ts — FileBackend: 真相在文件, 索引在 SQLite (可重建).
// 布局:
//   <root>/daily/YYYY-MM-DD.md      每日捕获 (原始, 人可读, git 可 diff)
//   <root>/digest/<topic>.md        整理后知识 (wikilink 双链)
//   <root>/rules/<id>.md            推广后的跨项目规则 (人工确认后才落盘)
//   <root>/index.sqlite             派生索引 (memories/relations/tags 三表), 删除可重建
//
// 不变量:
//   1. 真相在文件, 索引可重建: 删 index.sqlite 不影响记忆。
//   2. 双时态 validAt/assertedAt 每条必带。
//   3. kind:"rule" 必须带确认记录 (confirmedBy/confirmedAt) 才允许落盘。
//   4. 同一文件可含多条 entry (frontmatter 块串联), add/update 按 id upsert, 不互相覆盖。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { MemoryEntry, MemoryKind, MemoryStatus, MemoryScope, Query } from "../kernel/types.ts";

const DAILY_DIR = "daily";
const DIGEST_DIR = "digest";
const RULES_DIR = "rules";
const INDEX_NAME = "index.sqlite";

function nowIso(): string {
  return new Date().toISOString();
}

function entryId(): string {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

/** Relative file path for an entry inside its kind dir. */
function fileFor(entry: MemoryEntry): string {
  if (entry.kind === "rule") return join(RULES_DIR, entry.id + ".md");
  const day = entry.ts.validAt.slice(0, 10);
  return join(kindToDir(entry.kind), day + ".md");
}

export interface FileBackendConfig {
  root: string;
  /** true = remove() deletes the truth file; false = index-mark only. */
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
}

export class FileBackend {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly allowTruthDelete: boolean;

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
    this.initSchema();
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
  }

  /** 从文件重建索引 (真相 → 索引)。索引丢失后调用。 */
  rebuildFromFiles(): number {
    const seen = new Map<string, MemoryEntry>();
    for (const dir of [DAILY_DIR, DIGEST_DIR, RULES_DIR]) {
      const base = join(this.root, dir);
      if (!existsSync(base)) continue;
      for (const f of walkMd(base)) {
        for (const parsed of parseEntryBlocks(f)) {
          if (parsed) seen.set(parsed.id, parsed);
        }
      }
    }
    this.db.exec("DELETE FROM memories; DELETE FROM relations; DELETE FROM tags;");
    for (const e of seen.values()) this.indexEntry(e);
    return seen.size;
  }

  private indexEntry(e: MemoryEntry): void {
    const file = fileFor(e);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories (id, kind, content, source, scope, valid_at, asserted_at, status, confirmed_by, confirmed_at, project, file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        file,
      );
    for (const rel of e.relations ?? []) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO relations (from_id, type, to_id, weight) VALUES (?, ?, ?, ?)",
        )
        .run(e.id, rel.type, rel.toId, rel.weight ?? null);
    }
    for (const tag of extractTags(e.content)) {
      this.db.prepare("INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)").run(e.id, tag);
    }
  }

  /** 写真相文件 (upsert) + 建索引。rule 必须已确认。 */
  add(
    entry: Omit<MemoryEntry, "id" | "ts"> & { id?: string; ts?: Partial<MemoryEntry["ts"]> },
  ): MemoryEntry {
    const full: MemoryEntry = {
      ...entry,
      id: entry.id ?? entryId(),
      ts: {
        validAt: entry.ts?.validAt ?? nowIso(),
        assertedAt: entry.ts?.assertedAt ?? nowIso(),
      },
      status: entry.status ?? "active",
    };
    if (full.kind === "rule" && !isConfirmed(full)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    const file = join(this.root, fileFor(full));
    mkdirSync(dirname(file), { recursive: true });
    upsertInFile(file, full);
    this.indexEntry(full);
    return full;
  }

  get(id: string): MemoryEntry | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      RowLike | undefined;
    return row ? rowToEntry(row) : null;
  }

  query(q: Query): MemoryEntry[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
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
      clauses.push("(content LIKE ? OR source LIKE ?)");
      params.push("%" + q.text + "%", "%" + q.text + "%");
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
      .prepare("SELECT * FROM memories" + where + " ORDER BY valid_at DESC LIMIT ?")
      .all(...params, limit) as unknown[];
    return (rows as RowLike[]).map(rowToEntry);
  }

  traverse(fromId: string, relationType: string): MemoryEntry[] {
    const rows = this.db
      .prepare(
        "SELECT m.* FROM memories m JOIN relations r ON r.to_id = m.id WHERE r.from_id = ? AND r.type = ?",
      )
      .all(fromId, relationType) as unknown[];
    return (rows as RowLike[]).map(rowToEntry);
  }

  update(id: string, patch: Partial<MemoryEntry>): void {
    const existing = this.get(id);
    if (!existing) throw new Error("not found: " + id);
    const merged: MemoryEntry = {
      ...existing,
      ...patch,
      id,
      relations: patch.relations ?? existing.relations,
    };
    if (merged.kind === "rule" && !isConfirmed(merged)) {
      throw new Error("rule entries must carry a confirmation record (confirmedBy/confirmedAt)");
    }
    const file = join(this.root, fileFor(merged));
    mkdirSync(dirname(file), { recursive: true });
    upsertInFile(file, merged);
    this.db.prepare("DELETE FROM relations WHERE from_id = ?").run(id);
    this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
    this.db
      .prepare(
        "UPDATE memories SET kind=?, content=?, source=?, scope=?, valid_at=?, asserted_at=?, status=?, confirmed_by=?, confirmed_at=?, project=? WHERE id=?",
      )
      .run(
        merged.kind,
        merged.content,
        merged.source,
        merged.scope,
        merged.ts.validAt,
        merged.ts.assertedAt,
        merged.status ?? "active",
        merged.confirmedBy ?? null,
        merged.confirmedAt ?? null,
        merged.project ?? null,
        id,
      );
    for (const rel of merged.relations ?? []) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO relations (from_id, type, to_id, weight) VALUES (?, ?, ?, ?)",
        )
        .run(id, rel.type, rel.toId, rel.weight ?? null);
    }
    for (const tag of extractTags(merged.content)) {
      this.db.prepare("INSERT OR IGNORE INTO tags (memory_id, tag) VALUES (?, ?)").run(id, tag);
    }
  }

  /** 移除条目: allowTruthDelete 才删真相文件; 否则索引置 shadow。 */
  remove(id: string): void {
    const existing = this.get(id);
    if (!existing) return;
    if (this.allowTruthDelete) {
      const file = join(this.root, fileFor(existing));
      if (existsSync(file)) rmSync(file);
    }
    this.db.prepare("DELETE FROM relations WHERE from_id = ? OR to_id = ?").run(id, id);
    this.db.prepare("DELETE FROM tags WHERE memory_id = ?").run(id);
    this.db.prepare("UPDATE memories SET status='shadow' WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  get indexFile(): string {
    return join(this.root, INDEX_NAME);
  }
}

// ---------- helpers ----------

function rowToEntry(row: RowLike): MemoryEntry {
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
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append-or-replace one entry inside a (possibly multi-entry) Markdown file.
 * Each entry is a frontmatter block (--- ... ---\ncontent). Same id → replace in place;
 * otherwise append. Preserves "truth in files": same-day entries coexist.
 */
function upsertInFile(file: string, e: MemoryEntry): void {
  const block = entryToMarkdown(e);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const re = new RegExp(
    "(^|\\n)---\\nid: " + escapeRe(e.id) + "\\n[\\s\\S]*?(?=\\n---\\nid: |\\n---\\s*$|$)",
    "m",
  );
  let out: string;
  if (re.test(existing)) {
    out = existing.replace(re, "$1" + block);
  } else {
    out = existing.trimEnd() ? existing.trimEnd() + "\n\n" + block : block;
  }
  writeFileSync(file, out + "\n", "utf8");
}

/** Parse every frontmatter block in a file into entries (multi-entry files). */
function parseEntryBlocks(path: string): MemoryEntry[] {
  const text = readFileSync(path, "utf8");
  const out: MemoryEntry[] = [];
  const blocks = text.split(/\n(?=---\nid: )/);
  for (const b of blocks) {
    const e = parseSingleBlock(b);
    if (e) out.push(e);
  }
  return out;
}

function parseSingleBlock(block: string): MemoryEntry | null {
  const m = block.match(/^id: (.*)$/m);
  const kind = block.match(/^kind: (.*)$/m)?.[1] as MemoryKind | undefined;
  const source = block.match(/^source: (.*)$/m)?.[1];
  const scope = block.match(/^scope: (.*)$/m)?.[1] as MemoryScope | undefined;
  const valid = block.match(/^valid_at: (.*)$/m)?.[1];
  const asserted = block.match(/^asserted_at: (.*)$/m)?.[1];
  const status = block.match(/^status: (.*)$/m)?.[1] as MemoryStatus | undefined;
  const cb = block.match(/^confirmed_by: (.*)$/m)?.[1];
  const ca = block.match(/^confirmed_at: (.*)$/m)?.[1];
  const project = block.match(/^project: (.*)$/m)?.[1];
  if (!m || !kind || !source || !scope || !valid || !asserted) return null;
  const content = block.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return {
    id: m[1]!,
    kind,
    content: content.trim(),
    source,
    scope,
    status: status ?? "active",
    ts: { validAt: valid!, assertedAt: asserted! },
    confirmedBy: cb,
    confirmedAt: ca,
  };
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
  ];
  if (e.confirmedBy) lines.push("confirmed_by: " + e.confirmedBy);
  if (e.confirmedAt) lines.push("confirmed_at: " + e.confirmedAt);
  if (e.project) lines.push("project: " + e.project);
  lines.push("---");
  if (e.relations?.length) {
    lines.push("");
    lines.push("## relations");
    for (const r of e.relations)
      lines.push(
        "- " + r.type + ": " + r.toId + (r.weight !== undefined ? " (w=" + r.weight + ")" : ""),
      );
  }
  lines.push("");
  lines.push(e.content);
  return lines.join("\n");
}

function extractTags(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/#([a-zA-Z0-9_\u4e00-\u9fa5-]+)/g)) out.push(m[1]!);
  return out;
}

function isConfirmed(e: MemoryEntry): boolean {
  return Boolean(e.confirmedBy && e.confirmedAt);
}
