// external/store.ts — canonical 的落盘。一个 bank / 一个 corpus 各一个 JSON 文件。
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  CANONICAL_FORMAT,
  assertSafeId,
  parseBundle,
  parseCorpus,
  type CanonicalBundle,
  type CanonicalDoc,
  type CanonicalMemory,
  type CorpusBundle,
} from "./canonical.ts";
import { withFileLock } from "../storage/file-lock.ts";

/**
 * 文件即迁移单位。换引擎时读这份文件重放, 不从引擎里导出。
 */
export class CanonicalStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  listBanks(): string[] {
    return this.listDir("banks");
  }

  listCorpora(): string[] {
    return this.listDir("corpora");
  }

  listMemories(bankId: string): CanonicalMemory[] {
    return this.readBank(bankId).records;
  }

  getMemory(bankId: string, id: string): CanonicalMemory | null {
    return this.listMemories(bankId).find((row) => row.id === id) ?? null;
  }

  saveMemory(record: CanonicalMemory): CanonicalMemory {
    assertSafeId(record.bankId, "bankId");
    assertSafeId(record.id, "memory.id");
    // 读-改-写整段持锁 (REVIEW D1): 否则两个进程各读旧包、各写回, 后写者抹掉先写者。
    withFileLock(this.bankPath(record.bankId) + ".lock", () => {
      const bundle = this.readBank(record.bankId);
      const records = bundle.records.filter((row) => row.id !== record.id);
      records.push(record);
      this.writeBank({ ...bundle, records });
    });
    return record;
  }

  exportBank(bankId: string): CanonicalBundle {
    return this.readBank(bankId);
  }

  /** 整包替换。调用方负责随后 reindex, 这里不碰引擎。 */
  importBank(bundle: CanonicalBundle): void {
    const parsed = parseBundle(bundle);
    withFileLock(this.bankPath(parsed.bankId) + ".lock", () => this.writeBank(parsed));
  }

  listDocs(corpusId: string): CanonicalDoc[] {
    return this.readCorpus(corpusId).docs;
  }

  saveDoc(doc: CanonicalDoc): CanonicalDoc {
    assertSafeId(doc.corpusId, "corpusId");
    assertSafeId(doc.id, "doc.id");
    withFileLock(this.corpusPath(doc.corpusId) + ".lock", () => {
      const bundle = this.readCorpus(doc.corpusId);
      const docs = bundle.docs.filter((row) => row.id !== doc.id);
      docs.push(doc);
      this.writeCorpus({ ...bundle, docs });
    });
    return doc;
  }

  exportCorpus(corpusId: string): CorpusBundle {
    return this.readCorpus(corpusId);
  }

  importCorpus(bundle: CorpusBundle): void {
    const parsed = parseCorpus(bundle);
    withFileLock(this.corpusPath(parsed.corpusId) + ".lock", () => this.writeCorpus(parsed));
  }

  private readBank(bankId: string): CanonicalBundle {
    assertSafeId(bankId, "bankId");
    const path = this.bankPath(bankId);
    if (!existsSync(path)) return { format: CANONICAL_FORMAT, bankId, records: [] };
    return parseBundle(JSON.parse(readFileSync(path, "utf8")));
  }

  private writeBank(bundle: CanonicalBundle): void {
    this.writeAtomic(this.bankPath(bundle.bankId), bundle);
  }

  private readCorpus(corpusId: string): CorpusBundle {
    assertSafeId(corpusId, "corpusId");
    const path = this.corpusPath(corpusId);
    if (!existsSync(path)) return { format: CANONICAL_FORMAT, corpusId, docs: [] };
    return parseCorpus(JSON.parse(readFileSync(path, "utf8")));
  }

  private writeCorpus(bundle: CorpusBundle): void {
    this.writeAtomic(this.corpusPath(bundle.corpusId), bundle);
  }

  private bankPath(bankId: string): string {
    return join(this.root, "banks", bankId, "bundle.json");
  }

  private corpusPath(corpusId: string): string {
    return join(this.root, "corpora", corpusId, "bundle.json");
  }

  private listDir(kind: "banks" | "corpora"): string[] {
    const dir = join(this.root, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dir, name, "bundle.json")))
      .sort();
  }

  private writeAtomic(path: string, value: unknown): void {
    // 临时名带 pid + 随机 (此前固定为 path + ".tmp", 两个进程会截断、交错写同一个临时文件);
    // fsync 后再 rename, 断电不会得到空文件。临时文件以 ".tmp-" 结尾, 不会被 listDir 当成 bundle。
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = path + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(value, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}
