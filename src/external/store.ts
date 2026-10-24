// external/store.ts — canonical 的落盘。一个 bank / 一个 corpus 各一个 JSON 文件。
import { mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, existsSync } from "node:fs";
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
    const bundle = this.readBank(record.bankId);
    const records = bundle.records.filter((row) => row.id !== record.id);
    records.push(record);
    this.writeBank({ ...bundle, records });
    return record;
  }

  exportBank(bankId: string): CanonicalBundle {
    return this.readBank(bankId);
  }

  /** 整包替换。调用方负责随后 reindex, 这里不碰引擎。 */
  importBank(bundle: CanonicalBundle): void {
    const parsed = parseBundle(bundle);
    this.writeBank(parsed);
  }

  listDocs(corpusId: string): CanonicalDoc[] {
    return this.readCorpus(corpusId).docs;
  }

  saveDoc(doc: CanonicalDoc): CanonicalDoc {
    assertSafeId(doc.corpusId, "corpusId");
    assertSafeId(doc.id, "doc.id");
    const bundle = this.readCorpus(doc.corpusId);
    const docs = bundle.docs.filter((row) => row.id !== doc.id);
    docs.push(doc);
    this.writeCorpus({ ...bundle, docs });
    return doc;
  }

  exportCorpus(corpusId: string): CorpusBundle {
    return this.readCorpus(corpusId);
  }

  importCorpus(bundle: CorpusBundle): void {
    this.writeCorpus(parseCorpus(bundle));
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
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, path);
  }
}
