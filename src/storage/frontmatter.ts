// storage/frontmatter.ts — frontmatter 的**键级**工具 (解析与写回共用的单一事实源)。
//
// 为什么独立成文件: 解析 (markdown-parse) 与写回 (markdown-codec) 都需要"按行取键"的同一套口径。
// 此前两边各自用正则全文扫 (parse 的 field()) 或干脆不认识陌生键 (codec 整块重组) ——
// 后者会让**更新一条记忆 = 静默丢掉所有当前代码不认识的字段**(降级运行/手写字段/未来版本字段)。
// 迁移与整理必须以"不丢字段"为前提, 所以这把尺子必须先存在。
//
// 边界: 只处理**行形态**的 frontmatter (`key: value`), 与本仓库写入格式一致。
// 手写的多行 YAML 块能保住原始行, 但不做结构解析 (那需要引入 YAML 解析器, 收益不抵成本)。

/**
 * frontmatter 里的所有顶层 `key: value` 行。
 * 同名多次出现按顺序保留 —— 取值时取第一条, 与旧的"正则取首个匹配"语义逐字一致。
 */
export function frontmatterFields(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of head.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*): (.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const list = out.get(key);
    if (list) list.push(m[2] ?? "");
    else out.set(key, [m[2] ?? ""]);
  }
  return out;
}

/** 当前代码认识的 frontmatter 键 (写回时据此判定"陌生键"并原样保留)。 */
export const KNOWN_FRONTMATTER_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "source",
  "scope",
  "valid_at",
  "asserted_at",
  "status",
  "format",
  "confirmed_by",
  "confirmed_at",
  "project",
  "tags",
  "structured",
  "entities",
  "importance",
  "confidence",
  "reinforcement",
  "last_hit_at",
  "expires_at",
  "derived_from",
  "merged_from",
  "feedback",
  "relations",
]);

/**
 * 陌生键的原始行 (含其缩进/续行), 供写回时原样带回。
 * 判定"续行"的方式: 上一个键是陌生的, 且本行不是新键、也不是 frontmatter 结束标记。
 */
export function unknownFrontmatterLines(
  head: string,
  known: ReadonlySet<string> = KNOWN_FRONTMATTER_KEYS,
): string[] {
  const out: string[] = [];
  let carryUnknown = false;
  for (const line of head.split("\n")) {
    if (line === "") continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*): /);
    if (m) {
      carryUnknown = !known.has(m[1]!);
      if (carryUnknown) out.push(line);
      continue;
    }
    if (carryUnknown && !line.startsWith("---")) out.push(line);
  }
  return out;
}

/** 一个块的 frontmatter 原文 (无 frontmatter → null)。 */
export function frontmatterHeadOf(block: string): string | null {
  const fm = block.match(/^---\n([\s\S]*?)\n---\n?/);
  return fm ? (fm[1] ?? "") : null;
}

/** 一个块声明的磁盘格式版本 (无标记或非法 → undefined, 即 legacy)。 */
export function blockFormat(block: string): number | undefined {
  const head = frontmatterHeadOf(block);
  if (head === null) return undefined;
  const raw = frontmatterFields(head).get("format")?.[0];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
