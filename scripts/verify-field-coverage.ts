// scripts/verify-field-coverage.ts — **沉睡字段**必须被显式登记。
//
// 为什么需要它 (2026-09-18, §771): §765/§768 修了 `importance`/`confidence` ——
// 它们**声明在 `MemoryEntry` 上、有排序/裁决的读者、却从未有任何一层产出过** (真库 475/475 null)。
//
// **⇒ 而那次修完我立刻想到**: 还有别的字段在沉睡吗?
// 真库实测 (477 条) 发现另外两个 **零填充**: `expires_at` / `merged_from`。
//
// | 字段 | 零填充的性质 | 处置 |
// | --- | --- | --- |
// | `importance` / `confidence` | **有读者却无产出点** ⇒ 判据恒不触发 | **§765 修** |
// | `expires_at` | 有**兜底路径** (没 TTL 也走衰减) | 不是缺陷 |
// | `merged_from` | `[计划]` S3 整合 | 不是缺陷 |
//
// **⇒ 本脚本守的是那条分界**: 一个"零填充"的字段**要么有明确理由, 否则必须红**。
// "有读者却无产出点"这类 (§765 那种) **必须被登记为已知问题**, 不能靠人记得。
//
// ⚠ 判据用的是**声明侧** (`types.ts` 的 `MemoryEntry` 字段) 而不是真库列 ——
// 真库可能为空 (CI), 而声明是权威。零填充的判定交给**人登记 + 复查**, 不是本脚本猜。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * **已知的零填充字段** → 理由。
 *
 * 每一条都必须说明"为什么它空着不是缺陷"。新增字段若空着而**不在此表**,
 * 由 §771 的普查发现 (真库填充率 = 0 ⇒ 停下来问"它该被谁写")。
 */
const KNOWN_EMPTY = new Map<string, string>([
  ["expiresAt", "有兜底: 无 TTL 也走衰减路径 (consolidate 的 ttlHit=false 分支)"],
  ["mergedFrom", "[计划] S3 整合 (衰减/过期/合并) —— 见 open-source-landscape 的路线图"],
]);

/** 从 `MemoryEntry` 的接口体里抽出可选字段名 (只看那一个接口)。 */
function declaredFields(): string[] {
  const src = readFileSync(join(ROOT, "src", "kernel", "types.ts"), "utf8");
  const start = src.indexOf("export interface MemoryEntry");
  if (start < 0) throw new Error("types.ts 里找不到 MemoryEntry");
  // 接口体结束: 第一个顶格 '}' 之后。
  const body = src.slice(start);
  const end = body.indexOf("\n}");
  const iface = body.slice(0, end < 0 ? body.length : end);
  const out = new Set<string>();
  for (const m of iface.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) out.add(m[1]!);
  return [...out].sort();
}

const known = KNOWN_EMPTY;
const fields = declaredFields();
console.log("verify-field-coverage: MemoryEntry 声明了 " + fields.length + " 个字段");
console.log("  已知零填充 (有理由): " + [...known.keys()].join(", "));

// ⚠ 这条检查**不猜**哪个字段空着 (那要真库); 它守的是**登记表本身的时效性**:
// 登记的理由里提到的机制必须仍然存在 —— 否则那条"理由"已经失效而字段仍空着。
// ⚠ **判据是反向的**: 理由里出现的**每个标识符**都必须能在被引用的文档/源码里找到。
//
// 为什么不能只查白名单 (§771 实测): 第一版写成 `if (!/^(consolidate|ttlHit|...)$/.test(sym)) continue;`
// ⇒ 它**只检查我预想到的词**, 理由改成别的符号时**完全跳过** ⇒ 那正是"**永远绿的检查**"。
// 反向判据没有这个洞: 写进去的每个名字都要能被复核。
const CITED_SOURCES = [
  join(ROOT, "src", "app", "consolidate.ts"),
  join(ROOT, "docs", "open-source-landscape.md"),
];
// ⚠ 引用的"可复核面"要含**路径本身** (理由里常写 `xxx.md` 这类文件名, 而那只出现在路径里)。
const cited =
  CITED_SOURCES.map((p) => p + "\n" + readFileSync(p, "utf8")).join("\n") +
  "\n" +
  CITED_SOURCES.map((p) => p.split("/").pop() ?? "").join("\n");
/** 理由里的标识符 (长度 >= 5, 排除纯英文虚词与常见类型名)。 */
const STOPWORDS = new Set(["false", "true", "undefined", "计划", "兜底"]);
const stale: string[] = [];
for (const [field, why] of known) {
  // ⚠ 标识符要含 `.`/`-`/`_` (否则 `open-source-landscape` 会被切成三段而误报)。
  for (const sym of why.match(/[a-zA-Z][a-zA-Z0-9_.-]{4,}/g) ?? []) {
    if (STOPWORDS.has(sym)) continue;
    if (!cited.includes(sym)) stale.push(field + " 的理由提到 " + sym + ", 而它在被引用的源码/文档里找不到");
  }
}

if (stale.length) {
  console.error("verify-field-coverage: **登记表过期** —— 理由里引用的机制已消失:");
  for (const s of stale) console.error("  " + s);
  process.exit(1);
}
console.log("verify-field-coverage: " + known.size + " 个已知零填充字段的理由都仍然成立");
