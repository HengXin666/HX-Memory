// app/transfer.ts — 记忆的导出/导入 (迁移与备份)。
//
// 为什么需要它: 真相在文件的好处是"可 diff、可审计", 但"换一台机器 / 换一个引擎 / 备份到别处"
// 需要一条不依赖具体存储实现的通路。导出/导入就是那条通路 —— 它只认 `MemoryEntry` 这个领域类型,
// 因此 **A 引擎导出、B 引擎导入**永远可行 (这正是"存储层可插拔"要兑现的承诺)。
//
// 两种格式的分工:
//   - `jsonl`: 机器格式, 逐字段无损, 用于迁移与备份 (默认);
//   - `markdown`: 人可读格式, 用于审计与手工检查; 同样可被导入 (不要求二进制级无损, 但要求闭环)。
//
// 不变量:
//   1. **幂等**: 重复导入同一份数据不产生重复条目 (按 id + 内容比对);
//   2. **不绕过治理**: rule 没有确认记录时, 导入必须被拒绝并记入 errors (与 add() 同一套闸门);
//   3. **坏行不毁全场**: 单行损坏只跳过并记 errors, 其余照常导入 (fail-closed 但不抛断整批)。
import type { MemoryEntry, MemoryEntryInput } from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";

export type ExportFormat = "jsonl" | "markdown";

export interface TransferReport {
  scanned: number;
  imported: number;
  /** 已存在同 id 且内容相同 → 跳过 (幂等证据)。 */
  unchanged: number;
  errors: string[];
}

/** 稳定序列化: 键序固定, 便于 diff 与 hash 比对。 */
function stableJson(entry: MemoryEntry): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(entry).sort()) {
    const value = (entry as unknown as Record<string, unknown>)[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/** 把全部记忆导出为行流。jsonl 每行一条; markdown 每条一个带 frontmatter 的块。 */
export async function* exportMemory(
  entries: readonly MemoryEntry[],
  format: ExportFormat = "jsonl",
): AsyncIterable<string> {
  for (const entry of entries) {
    if (format === "jsonl") {
      yield stableJson(entry) + "\n";
      continue;
    }
    yield toMarkdownBlock(entry);
  }
}

/** Human-readable Markdown block (frontmatter + body). 可被 importMemory 读回。 */
function toMarkdownBlock(entry: MemoryEntry): string {
  const lines = [
    "---",
    "id: " + entry.id,
    "kind: " + entry.kind,
    "source: " + entry.source,
    "scope: " + entry.scope,
    ...(entry.project ? ["project: " + entry.project] : []),
    "valid_at: " + entry.ts.validAt,
    "asserted_at: " + entry.ts.assertedAt,
    "status: " + (entry.status ?? "active"),
    ...(entry.confirmedBy ? ["confirmed_by: " + entry.confirmedBy] : []),
    ...(entry.confirmedAt ? ["confirmed_at: " + entry.confirmedAt] : []),
    ...(entry.tags?.length ? ["tags: " + JSON.stringify(entry.tags)] : []),
    ...(entry.relations?.length ? ["relations: " + JSON.stringify(entry.relations)] : []),
    ...(entry.structured ? ["structured: " + JSON.stringify(entry.structured)] : []),
    ...(entry.entities?.length ? ["entities: " + JSON.stringify(entry.entities)] : []),
    ...(entry.importance === undefined ? [] : ["importance: " + String(entry.importance)]),
    ...(entry.confidence === undefined ? [] : ["confidence: " + String(entry.confidence)]),
    ...(entry.reinforcement === undefined ? [] : ["reinforcement: " + String(entry.reinforcement)]),
    ...(entry.lastHitAt ? ["last_hit_at: " + entry.lastHitAt] : []),
    ...(entry.expiresAt ? ["expires_at: " + entry.expiresAt] : []),
    ...(entry.derivedFrom?.length ? ["derived_from: " + JSON.stringify(entry.derivedFrom)] : []),
    ...(entry.mergedFrom?.length ? ["merged_from: " + JSON.stringify(entry.mergedFrom)] : []),
    "---",
    "",
    entry.content,
    "",
  ];
  return lines.join("\n");
}

/**
 * 解析 markdown 块 (与 file-store 的 frontmatter 形状一致的最小子集)。
 * 逐行切分而不是用正则: 正文里可能出现 "---" 或 "id: " 之类的行,
 * 用贪婪/非贪婪正则切都会切错 (写这个解析器时真实踩过)。
 */
function parseMarkdownBlock(block: string): MemoryEntryInput | null {
  const lines = block.split("\n");
  if (lines[0] !== "---") return null;
  const closeIndex = lines.indexOf("---", 1);
  if (closeIndex < 0) return null;
  const head = lines.slice(1, closeIndex).join("\n");
  // 正文 = 结束分隔符之后的所有行 (去掉紧邻的一个空行), 保留内部换行。
  const bodyLines = lines.slice(closeIndex + 1);
  if (bodyLines[0] === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  const body = bodyLines.join("\n");
  const field = (name: string): string | undefined =>
    head.match(new RegExp("^" + name + ": (.*)$", "m"))?.[1];
  const id = field("id");
  const kind = field("kind");
  const source = field("source");
  const scope = field("scope");
  const validAt = field("valid_at");
  const assertedAt = field("asserted_at");
  if (!id || !kind || !source || !scope || !validAt || !assertedAt) return null;
  const parseJson = <T>(raw: string | undefined): T | undefined => {
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const entry: MemoryEntryInput = {
    id,
    kind: kind as MemoryEntryInput["kind"],
    content: body,
    source,
    scope: scope as MemoryEntryInput["scope"],
    ts: { validAt, assertedAt },
    status: (field("status") ?? "active") as MemoryEntryInput["status"],
    ...(field("project") ? { project: field("project")! } : {}),
    ...(field("confirmed_by") ? { confirmedBy: field("confirmed_by")! } : {}),
    ...(field("confirmed_at") ? { confirmedAt: field("confirmed_at")! } : {}),
    ...(parseJson<string[]>(field("tags")) ? { tags: parseJson<string[]>(field("tags"))! } : {}),
    ...(parseJson<MemoryEntryInput["relations"]>(field("relations"))
      ? { relations: parseJson<MemoryEntryInput["relations"]>(field("relations"))! }
      : {}),
    ...(parseJson<MemoryEntryInput["structured"]>(field("structured"))
      ? { structured: parseJson<MemoryEntryInput["structured"]>(field("structured"))! }
      : {}),
    ...(parseJson<string[]>(field("entities"))
      ? { entities: parseJson<string[]>(field("entities"))! }
      : {}),
    ...(parseJson<string[]>(field("derived_from"))
      ? { derivedFrom: parseJson<string[]>(field("derived_from"))! }
      : {}),
    ...(parseJson<string[]>(field("merged_from"))
      ? { mergedFrom: parseJson<string[]>(field("merged_from"))! }
      : {}),
    ...(num(field("importance")) === undefined ? {} : { importance: num(field("importance"))! }),
    ...(num(field("confidence")) === undefined ? {} : { confidence: num(field("confidence"))! }),
    ...(num(field("reinforcement")) === undefined
      ? {}
      : { reinforcement: num(field("reinforcement"))! }),
    ...(field("last_hit_at") ? { lastHitAt: field("last_hit_at")! } : {}),
    ...(field("expires_at") ? { expiresAt: field("expires_at")! } : {}),
  };
  return entry;
}

/** 把行流切成条目 (jsonl 逐行; markdown 按 "---" 块)。 */
async function* parseStream(
  lines: AsyncIterable<string>,
  format: ExportFormat,
  report: TransferReport,
): AsyncIterable<MemoryEntryInput> {
  let buffer = "";
  for await (const chunk of lines) {
    buffer += chunk;
    if (format === "jsonl") {
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        report.scanned++;
        try {
          const parsed = JSON.parse(line) as MemoryEntryInput;
          if (!parsed.id || !parsed.kind || !parsed.content) {
            report.errors.push("缺字段 (id/kind/content): " + line.slice(0, 60));
            continue;
          }
          yield parsed;
        } catch {
          report.errors.push("非法 JSON: " + line.slice(0, 60));
        }
      }
    }
  }
  if (format === "markdown") {
    // markdown: 按 "块起始" 切分。块起始 = 行首的 "---" 且**其后紧跟 id:** —— 不能用裸 "---",
    // 因为正文里完全可能出现 "---" (分隔线), 那样会把一个条目切成两块 (真实踩过)。
    const lines = buffer.split("\n");
    const blocks: string[] = [];
    let current: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const startsBlock = lines[i] === "---" && (lines[i + 1] ?? "").startsWith("id: ");
      if (startsBlock && current.length) {
        blocks.push(current.join("\n"));
        current = [];
      }
      current.push(lines[i] ?? "");
    }
    if (current.length) blocks.push(current.join("\n"));
    for (const block of blocks) {
      report.scanned++;
      const parsed = parseMarkdownBlock(block);
      if (!parsed) {
        report.errors.push("markdown 块无法解析: " + block.slice(0, 60));
        continue;
      }
      yield parsed;
    }
    return;
  }
  if (buffer.trim()) {
    // 末行没有换行结尾
    report.scanned++;
    try {
      const parsed = JSON.parse(buffer.trim()) as MemoryEntryInput;
      if (parsed.id && parsed.kind && parsed.content) yield parsed;
      else report.errors.push("缺字段 (id/kind/content): " + buffer.slice(0, 60));
    } catch {
      report.errors.push("非法 JSON: " + buffer.slice(0, 60));
    }
  }
}

/**
 * 从行流导入。幂等: 同 id 且内容相同 → unchanged, 不重复写入。
 * 治理: rule 缺确认记录 → 被 store.add 拒绝, 计入 errors 且不中断整批。
 */
export async function importMemory(
  store: Pick<MemoryStore, "add" | "get">,
  lines: AsyncIterable<string>,
  opts: { format?: ExportFormat } = {},
): Promise<TransferReport> {
  const report: TransferReport = { scanned: 0, imported: 0, unchanged: 0, errors: [] };
  for await (const input of parseStream(lines, opts.format ?? "jsonl", report)) {
    try {
      const existing = await store.get(input.id!);
      if (existing) {
        // 幂等判定: id 存在且内容一致 → 跳过; 内容不同 → 覆盖式更新 (迁移语义)。
        if (existing.content === input.content) {
          report.unchanged++;
          continue;
        }
      }
      await store.add(input);
      report.imported++;
    } catch (error) {
      // 治理闸门 (未确认 rule) 与其它写入错误都在这里被记账, 不中断整批。
      report.errors.push(input.id + ": " + String(error instanceof Error ? error.message : error));
    }
  }
  return report;
}
