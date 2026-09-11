// src/storage/file-store.ts — FileBackend: 真相在文件, 索引在 SQLite (可重建).
//
// 本文件只做"真相 ↔ 索引"的**编排**与 SQL。布局、各文件职责边界、写入语义与全部不变量
// 见 src/storage/README.md (单一事实源) —— 拆成多文件的理由也记在那里。
// 最关键的一条不变量 (改任何写路径前先读): **陌生 frontmatter 键必须原样保留**,
// 否则"更新一条记忆"就等于静默丢掉当前代码不认识的字段, 迁移/整理都会变成破坏性操作。
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, MemoryEntryInput, Query } from "../kernel/types.ts";
import type {
  IndexableSource,
  MemoryStore,
  Rebuildable,
  RetrievalCapabilities,
  VerifyReport,
} from "../kernel/ports.ts";
import { FtsIndex } from "./fts-index.ts";
import {
  DAILY_DIR,
  DIGEST_DIR,
  FORMAT_VERSION,
  INDEX_NAME,
  RULES_DIR,
  entryId,
  fileFor,
  isConfirmed,
  normalizeEntry,
  nowIso,
} from "./entry-normalize.ts";
import { appendBlockToFile, removeBlockFromFile, upsertBlockInFile } from "./markdown-codec.ts";
import { IndexReader } from "./index-reader.ts";
import { initSchema } from "./index-schema.ts";
import { countTruthEntries, hasTruthFiles, scanTruth } from "./truth-scan.ts";
import { IndexWriter } from "./index-writer.ts";

export interface FileBackendConfig {
  root: string;
  /**
   * true = remove() 从真相文件里摘掉该块 (文件空了才删文件);
   * false (默认) = 在真相文件里写 status: shadow, 保留可审计的撤回记录。
   */
  allowTruthDelete?: boolean;
}

export class FileBackend implements MemoryStore, Rebuildable, IndexableSource {
  private readonly root: string;
  private readonly db: DatabaseSync;
  private readonly fts: FtsIndex;
  private readonly allowTruthDelete: boolean;
  /** 重建/解析过程中被跳过的条目 (fail-closed 的证据, 供测试与诊断读取)。 */
  private readonly skipped: string[] = [];
  /** 写版本号 (索引同步用; 稳态查询不触发重新扫描)。 */
  private writeRevision = 0;
  /**
   * 本进程内已经"由自己规范化写过"的真相文件。
   * 只有这些文件才允许走 O(1) 追加快路径 —— 外部手写文件里有前言, 必须先经通用路径归一化。
   */
  private readonly touchedFiles = new Set<string>();
  /** 派生索引的读取侧 (查询/投影/hydrate 都在那里; 本类只管写与编排)。 */
  private readonly reader: IndexReader;
  /** 索引写入侧 (SQL 行 + FTS 行; 治理闸门在那里, 见 index-writer.ts)。 */
  private readonly writer: IndexWriter;

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
    // WAL + synchronous=NORMAL: 批量写入从"每条一次 fsync"降到"每次提交一次"。
    // 权衡: 进程崩溃不丢已提交事务; 仅操作系统级崩溃可能丢最后一笔 (这正是 NORMAL 的定义)。
    // 本地记忆场景下这个取舍是划算的 —— 真相文件仍在, 索引可重建。
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    } catch {
      // 某些文件系统不支持 WAL (如部分网络盘): 退回默认模式, 不影响正确性。
    }
    this.initSchema();
    // 全文索引对象必须在 rebuildFromFiles() 之前建好 (重建路径会经 indexEntry 写索引)。
    this.fts = new FtsIndex(this.db);
    this.reader = new IndexReader(this.db, this.fts);
    this.writer = new IndexWriter(this.db, this.fts);
    // 索引丢了但真相还在 → 自动重建, 否则记忆会"静默消失"。
    const rows = this.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
    if (rows.n === 0 && this.hasTruthFiles()) this.rebuildFromFiles();

    // 全文索引: 建表 + 分词版本校验 + 缺失回填。
    // 版本不一致时 ensure() 会清表并返回 true —— 混用两种分词的索引 = 静默召回失真。
    const needsRebuild = this.fts.ensure(rows.n);
    if (this.fts.available && (needsRebuild || this.fts.count() !== this.countMemories())) {
      this.repopulateFts();
    }
  }

  /** memories 表行数 (含 shadow/merged/expired: 索引与真相必须一一对应)。 */
  private countMemories(): number {
    return this.reader.countMemories();
  }

  /**
   * 从 memories 表重建全文索引 (T1 级重建: 索引 → 索引)。
   * 上游仍然是真相文件 (memories 表本身可从文件重建), 所以这一步永远可重复执行。
   */
  repopulateFts(): number {
    return this.writer.repopulateFts(this.reader.allIds(), (id) => this.reader.get(id));
  }

  /**
   * 引擎能力自述 (RetrievalSource.capabilities): 检索层据此决定降级策略。
   * 注意 semantic:false 是**诚实**的 —— 目前没有 embedding 通道, 不要假装有语义检索。
   */
  capabilities(): RetrievalCapabilities {
    const s = this.ftsStatus();
    return {
      engine: s.available ? "sqlite-fts5+cjk" : "sqlite-like",
      fullText: s.available,
      cjk: s.available,
      semantic: false,
      graph: "relations",
      multiProcess: true,
    };
  }

  /**
   * 派生索引身份 (ADR-023): 真相文件格式 + 分词版本。
   * 任一变化都意味着"旧索引不可复用", 必须重建 (由构造函数与 rebuildFromTruth 保证)。
   */
  get schemaVersion(): string {
    return `format${FORMAT_VERSION}+tokenizer${this.fts.tokenizerVersion}`;
  }

  /** T1 级重建 (索引 ← 真相文件)。语义等价于 rebuildFromFiles(), 端口名是给引擎消费者的。 */
  rebuildFromTruth(): number {
    const n = this.rebuildFromFiles();
    this.writeRevision++;
    return n;
  }

  /**
   * 一致性自检: 索引行数必须等于真相文件里的条目数, 全文索引行数必须等于 memories 行数。
   * 不追求"逐字段 diff"(那是 conformance 的事), 只给运维一眼可见的"有没有漂移"。
   */
  verify(): VerifyReport {
    const problems: string[] = [];
    const truth = this.countTruthEntries();
    const index = this.countMemories();
    const fullText = this.fts.available ? this.fts.count() : undefined;
    if (truth !== index) {
      problems.push(`truth/index mismatch: ${truth} truth entries vs ${index} index rows`);
    }
    if (fullText !== undefined && fullText !== index) {
      problems.push(`index/fulltext mismatch: ${index} rows vs ${fullText} fulltext rows`);
    }
    for (const w of this.skipped.slice(0, 10)) problems.push("parse warning: " + w);
    return {
      ok: problems.length === 0,
      truth,
      index,
      ...(fullText === undefined ? {} : { fullText }),
      problems,
    };
  }

  /** 真相文件里的条目数 (不依赖索引; 解析警告会累加到 this.skipped)。 */
  private countTruthEntries(): number {
    return countTruthEntries(this.root, this.skipped);
  }

  /** 选择型候选的廉价投影 (不 hydrate; 实现见 IndexReader.entrySummaries)。 */
  entrySummaries() {
    return this.reader.entrySummaries();
  }

  /** 廉价全量投影 (不 hydrate; 实现见 IndexReader.indexDocs)。 */
  indexDocs() {
    return this.reader.indexDocs();
  }

  /**
   * 写版本号: 任何索引写入 (add/update/remove/rebuild) 都会 +1, 用于"变了才同步"。
   *
   * **跨进程**: 别的进程 (CLI / 另一个 host 实例) 写入时本进程的 writeRevision 不会动,
   * 于是内存派生索引 (向量) 会长期陈旧 —— 实测: 外部写入的条目 BM25 查得到、向量通道查不到。
   * `PRAGMA data_version` 会在**其它连接提交后**变化 (本连接自己的提交不变), 正好用来识别外部写入。
   * 两者合成一个复合版本号, 保证"任何来源的变更都能触发重新同步"。
   */
  revision(): number {
    return this.writeRevision * 1_000_000 + this.externalRevision();
  }

  /** 其它连接提交后的版本 (实现见 IndexReader.externalRevision)。 */
  private externalRevision(): number {
    return this.reader.externalRevision();
  }

  /** 检索能力自述 (降级必须可观测: 面板/日志/测试都能看到"现在是 LIKE 而不是 FTS")。 */
  ftsStatus(): { available: boolean; degraded: string | null; indexed: number; expected: number } {
    return {
      available: this.fts.available,
      degraded: this.fts.degradation,
      indexed: this.fts.count(),
      expected: this.countMemories(),
    };
  }

  /** 建表 + 补列 (DDL 与迁移策略见 index-schema.ts)。 */
  private initSchema(): void {
    initSchema(this.db);
  }

  /** 真相目录里是否存在 Markdown (实现见 truth-scan.hasTruthFiles)。 */
  private hasTruthFiles(): boolean {
    return hasTruthFiles(this.root);
  }

  /** 最近一次 rebuild/解析跳过的条目 (fail-closed 的可观测证据)。 */
  warnings(): readonly string[] {
    return this.skipped;
  }

  /**
   * 从文件重建索引 (真相 → 索引)。索引丢失后调用 (构造函数也会自动调用一次)。
   * 扫描与去重口径在 truth-scan.ts (与 verify 的自检共用, 避免"重建看到 N 条、自检看到 M 条")。
   */
  rebuildFromFiles(): number {
    this.skipped.length = 0;
    // 全文索引必须一起清掉: 只重建关系/标签会留下"已删条目的全文行", 召回出幽灵记忆。
    this.fts.clear();
    const { entries, skipped } = scanTruth(this.root);
    for (const reason of skipped) this.skipped.push(reason);
    this.writer.clearAll();
    let indexed = 0;
    for (const e of entries.values()) if (this.indexEntry(e)) indexed++;
    return indexed;
  }

  /** 写入索引; 未确认的 rule 一律拒绝 (与 add() 同一套闸门, 重建也不能绕过)。 */
  private indexEntry(e: MemoryEntry): boolean {
    const ok = this.writer.indexEntry(e, this.skipped);
    if (ok) this.writeRevision++;
    return ok;
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
    // 新条目 + 本进程已规范化写过的文件 → O(1) 追加 (块各自独立, 无需读整个文件再写回)。
    // 其它情况 (更新/搬移/首次碰外部手写文件) 走精确切片替换, 保持"不碰其它字节"的语义。
    if (previous === undefined && this.touchedFiles.has(relative)) {
      appendBlockToFile(file, entry);
    } else {
      upsertBlockInFile(file, entry);
      this.touchedFiles.add(relative);
    }
    this.writer.clearRelationsAndTags(entry.id);
    this.indexEntry(entry);
  }

  get(id: string): MemoryEntry | null {
    return this.reader.get(id);
  }

  /** 最近捕获的 N 条 (按 assertedAt 倒序), 附 tags。供知情权面板用。 */
  recent(limit = 20): MemoryEntry[] {
    return this.reader.recent(limit);
  }

  query(q: Query): MemoryEntry[] {
    return this.reader.query(q);
  }

  /**
   * 全文检索 (BM25 排序; 中文按 词 + bigram 双列, 见 kernel/cjk.ts)。
   * 与 query() 的分工: query() 是"结构化条件过滤", searchText() 是"和这段文本最相关"。
   * 降级: FTS5 不可用时退回 LIKE 宽召回 (仍可用, 但没有相关性排序; 见 ftsStatus())。
   */
  searchText(text: string, limit = 20, opts: { includeHidden?: boolean } = {}): MemoryEntry[] {
    return this.reader.searchText(text, limit, opts);
  }

  /** 全量条目 (不截断): warmUp/重建等需要完整集合的调用点。 */
  all(): MemoryEntry[] {
    return this.reader.all();
  }

  /** 关系遍历: 只返回存活 (非 shadow) 的邻居, 与 query 的可见性一致。 */
  traverse(fromId: string, relationType: string): MemoryEntry[] {
    return this.reader.traverse(fromId, relationType);
  }

  update(id: string, patch: Partial<MemoryEntry>): void {
    const existing = this.reader.get(id);
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
    const existing = this.reader.get(id);
    if (!existing) return;
    const file = join(this.root, fileFor(existing));
    if (this.allowTruthDelete) {
      if (existsSync(file)) removeBlockFromFile(file, id);
      this.writer.deleteEntry(id);
      return;
    }
    if (existing.status !== "shadow" && existsSync(file)) {
      upsertBlockInFile(file, { ...existing, status: "shadow" });
      this.touchedFiles.add(fileFor(existing));
    }
    this.writer.markShadow(id);
    this.writeRevision++;
    // 注意: shadow 条目的全文行**保留** —— FTS 行与 memories 行必须一一对应 (计数一致),
    // 可见性由 searchText 的 status 过滤决定。在这里删掉会让"计数一致性"自检每次打开都触发重建。
  }

  close(): void {
    this.db.close();
  }

  get indexFile(): string {
    return join(this.root, INDEX_NAME);
  }
}


