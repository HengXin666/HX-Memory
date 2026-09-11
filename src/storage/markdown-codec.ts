// storage/markdown-codec.ts — 真相文件的编解码 (Markdown ↔ MemoryEntry), 纯函数 + 文件 IO。
//
// 这是"真相在文件"这条不变量落地的地方: 一条记忆 ↔ 一个块; 文件是 git 可 diff 的文本。
// 设计要点 (每一条都对应一个踩过的坑):
//   1. **正文不可伪造块边界**: 正文里形如 "---\nid: " 的行写入时转义 (反斜杠前缀),
//      读取时逆序还原 —— 否则一条普通记忆能在重建后"长出"一个假条目。
//   2. **前言原样保留**: 第一个块之前的手写笔记不参与解析, 写回时原样保留。
//   3. **时间戳必须 ISO (Z 结尾)**: 它们参与文件名与时间切片, 不合法就 fail-closed 跳过。
//   4. **块间分隔容忍单换行**: 手写/旧文件可能不是空行; 但此时"正文以换行结尾"会丢一个换行
//      (歧义), 这是格式的已知边界, 已在 file-store 顶部注释里写明。
//   5. **追加是 O(1)**: 新条目只 truncate 掉文件终止换行再 append, 不重写整个文件
//      (批量导入 10k 条从分钟级降到秒级); 但这要求内容与 readFileParts 的产物逐字节等价。
//   6. **未知 frontmatter 键原样带回**: 写回是"整块重组", 若不显式搬运, 更新一条记忆就会
//      把它身上当前代码不认识的键 (更新版本写的 / 手写的) 静默吃掉 —— 见 frontmatter.ts。
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { MemoryEntry } from "../kernel/types.ts";
import { FORMAT_VERSION } from "./entry-normalize.ts";
import { frontmatterHeadOf, unknownFrontmatterLines } from "./frontmatter.ts";

/** 一个真相文件的解析结果: 块序列 + 第一个块之前的手写前言。 */
export interface FileParts {
  /** 第一个块之前的原文 (手写笔记), 原样保留。 */
  preamble: string;
  blocks: string[];
}

/** 块头: 每个块的 frontmatter 第一行必须是 id (写入与解析都依赖这个前缀)。 */
export function blockHeader(id: string): string {
  return "---\nid: " + id + "\n";
}

/** 正文转义 (可逆, 单射): 反斜杠加倍 + 真块边界前加反斜杠。 */
export function escapeBody(content: string): string {
  return content.replace(/\\/g, "\\\\").replace(/(^|\n)---\n(?=id: )/g, "$1\\---\n");
}

export function unescapeBody(body: string): string {
  return body.replace(/(^|\n)\\---\n(?=id: )/g, "$1---\n").replace(/\\\\/g, "\\");
}

/**
 * 一条记忆 → 一个 Markdown 块 (frontmatter + 空行 + 正文)。
 *
 * @param unknown 该条目**原有块**里当前代码不认识的 frontmatter 行 (原样带回, 保证无损)。
 */
export function entryToMarkdown(e: MemoryEntry, unknown: readonly string[] = []): string {
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
  // v2 字段: 全部写进 frontmatter —— 否则重建 (删索引/换引擎) 会静默丢掉关联性与衰减状态。
  if (e.entities?.length) lines.push("entities: " + JSON.stringify(e.entities));
  if (e.importance !== undefined) lines.push("importance: " + String(e.importance));
  if (e.confidence !== undefined) lines.push("confidence: " + String(e.confidence));
  if (e.reinforcement !== undefined) lines.push("reinforcement: " + String(e.reinforcement));
  if (e.lastHitAt) lines.push("last_hit_at: " + e.lastHitAt);
  if (e.expiresAt) lines.push("expires_at: " + e.expiresAt);
  if (e.derivedFrom?.length) lines.push("derived_from: " + JSON.stringify(e.derivedFrom));
  if (e.mergedFrom?.length) lines.push("merged_from: " + JSON.stringify(e.mergedFrom));
  // relations 也放 frontmatter (JSON): 正文保持纯净, 避免"正文以 ## relations 开头"被误解析。
  if (e.relations?.length) lines.push("relations: " + JSON.stringify(e.relations));
  // 陌生键原样附在末尾: 位置变了但内容与语义不变 (键级 frontmatter 无顺序语义)。
  for (const line of unknown) lines.push(line);
  lines.push("---");
  lines.push("");
  lines.push(escapeBody(e.content));
  return lines.join("\n");
}

/**
 * 读取文件结构 (未解析成条目的原始文本)。
 * 归一化: 去 BOM、CRLF/CR→LF、去掉写入时追加的结尾换行。
 */
export function readFileParts(file: string, skipped?: string[]): FileParts {
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
export function writeFileParts(file: string, parts: FileParts): void {
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

/**
 * 新增或替换某 id 的块 (按块数组重写, 不碰其它块与前言的字节)。
 *
 * 替换时会先把**旧块里的陌生 frontmatter 键**搬运到新块 (见 frontmatter.ts) ——
 * 这是"无损"的落点: 升级/整理/普通更新都走这条路径, 必须先保证不丢字段。
 */
export function upsertBlockInFile(file: string, e: MemoryEntry): void {
  const parts = readFileParts(file);
  const header = blockHeader(e.id);
  const index = parts.blocks.findIndex((b) => b.startsWith(header));
  if (index >= 0) {
    const head = frontmatterHeadOf(parts.blocks[index]!);
    const unknown = head === null ? [] : unknownFrontmatterLines(head);
    parts.blocks[index] = entryToMarkdown(e, unknown);
  } else {
    parts.blocks.push(entryToMarkdown(e));
  }
  writeFileParts(file, parts);
}

/** 摘掉某 id 的块 (文件不存在或无该块时是 no-op)。 */
export function removeBlockFromFile(file: string, id: string): void {
  const parts = readFileParts(file);
  const header = blockHeader(id);
  const next = parts.blocks.filter((b) => !b.startsWith(header));
  if (next.length === parts.blocks.length) return;
  writeFileParts(file, { ...parts, blocks: next });
}

/** 读文件末尾 N 字节 (用于 O(1) 判断结尾换行形态)。 */
function readTail(file: string, count: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(count, size);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 追加一个新块 (新条目专用快路径)。
 * O(1) 追加: 只把"文件终止换行"这一个字节截掉, 再补 "空行 + 新块 + 终止换行"。
 * 与 writeFileParts 的产物逐字节等价 (含"上一条正文自带尾部空行"的歧义情况) —— 有回归测试钉住。
 */
export function appendBlockToFile(file: string, e: MemoryEntry): void {
  const block = entryToMarkdown(e);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    writeFileSync(file, block + "\n", "utf8");
    return;
  }
  const size = statSync(file).size;
  const tail = readTail(file, 1);
  if (tail === "\n" && size > 0) truncateSync(file, size - 1);
  appendFileSync(file, "\n\n" + block + "\n", "utf8");
}
