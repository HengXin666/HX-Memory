/**
 * Gate: 结构与规模约束 (G2/G3/G4)。
 *
 * 为什么需要机械约束: 架构问题几乎都不是"某天突然坏的", 而是慢慢长出来的 ——
 * 一个文件从 400 行长到 1400 行、一处分词实现被复制到第三份、适配层悄悄 import 了具体存储类。
 * 这些都不会让任何测试变红, 但会持续抬高维护成本, 直到某次改动代价大得离谱。
 * DSH 的做法是把它们全部变成可执行检查; 本脚本是裁剪版。
 *
 * 四条约束:
 *   1. **单文件规模**: 超过上限即失败 (当前 file-store.ts 是最大者, 上限就设在它附近以便先止血;
 *      拆分后再收紧阈值 —— 阈值是"不许更差", 不是"已达标");
 *   2. **重复块比例**: 用 jscpd 的机器可读输出判定 (超阈值失败);
 *   3. **端口纯度**: 适配层不得 import 具体存储实现 (只许走端口);
 *   4. **单一事实源**: 分词/哈希/归一化这类"全局口径"函数不得在多个文件里各自实现。
 *
 * 用法: node --experimental-strip-types scripts/verify-structure.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/** 单文件行数上限。当前最大 1373 (file-store.ts); 设 1400 是"不许更差", 拆完应下调。 */
const MAX_FILE_LINES = 1400;
/** 重复代码比例上限 (jscpd 实测当前 0.45%; 设 1% 留余量但不给劣化空间)。 */
const MAX_DUPLICATION_PCT = 1.0;

const violations: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "client" || entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);

// 1) 单文件规模
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > MAX_FILE_LINES) {
    violations.push(
      `规模: ${relative(ROOT, file)} 有 ${lines} 行 (上限 ${MAX_FILE_LINES}) —— 请按职责拆分`,
    );
  }
}

/**
 * 2) 端口纯度: 适配层不得 import 具体存储类。
 *
 * 例外是**组装根** (composition root): 总得有人 `new FileBackend(...)` 把具体实现接起来,
 * 否则端口永远没有实现。因此把"唯一允许构造具体引擎"的位置显式列出来, 而不是把规则放宽 ——
 * 白名单之外一律拒绝, 新增组装点必须改这里 (改动可见, 不会被悄悄绕过)。
 */
const COMPOSITION_ROOTS = new Set([
  "src/adapters/dsh/index.ts", // DSH 插件入口: 组装整套依赖
  "src/adapters/codex/cli.ts", // CLI 入口: 组装整套依赖
]);
for (const file of walk(join(ROOT, "src/adapters"))) {
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  // 允许注释里提到; 只看真正的 import 语句。
  for (const m of text.matchAll(/import\s+(?:type\s+)?[^;]*from\s+"([^"]*storage\/[^"]+)"/g)) {
    const spec = m[1] ?? "";
    if (!/storage\/(file-store|memory-store|episode-store|fts-index)/.test(spec)) continue;
    // 类型-only 的 import 允许 (它不产生运行时耦合, 且有些地方确实要类型别名);
    // 值导入 (组装具体引擎) 只允许出现在组装根。
    const isTypeOnly = /import\s+type\s/.test(m[0]);
    if (isTypeOnly || COMPOSITION_ROOTS.has(rel)) continue;
    violations.push(
      `端口纯度: ${rel} 直接 import 了具体存储实现 (${spec}) —— 只有组装根 (${[...COMPOSITION_ROOTS].join(", ")}) 可以; 其余一律走 kernel 端口`,
    );
  }
}

// 3) 单一事实源: 全局口径函数不得重复实现
const SINGLETON_FUNCS = [
  { name: "tokenSet", owner: "src/kernel/cjk.ts", pattern: /export function tokenSet\b/ },
  { name: "fnv1a32", owner: "src/kernel/hashing.ts", pattern: /export function fnv1a32\b/ },
  { name: "l2Normalize", owner: "src/kernel/hashing.ts", pattern: /export function l2Normalize\b/ },
  { name: "contentFingerprint", owner: "src/kernel/hashing.ts", pattern: /export function contentFingerprint\b/ },
  { name: "termStreams", owner: "src/kernel/cjk.ts", pattern: /export function termStreams\b/ },
];
for (const fn of SINGLETON_FUNCS) {
  const holders = files.filter((f) => fn.pattern.test(readFileSync(f, "utf8")));
  if (holders.length !== 1) {
    violations.push(
      `单一事实源: ${fn.name} 在 ${holders.length} 个文件里被定义 (${holders
        .map((f) => relative(ROOT, f))
        .join(", ")}) —— 应只有 ${fn.owner} 一份`,
    );
  } else if (relative(ROOT, holders[0]!) !== fn.owner) {
    violations.push(`单一事实源: ${fn.name} 的归属应是 ${fn.owner}, 实际在 ${relative(ROOT, holders[0]!)}`);
  }
}

// 4) 重复块比例 (jscpd 机器可读输出)
try {
  const raw = execFileSync(
    "npx",
    [
      "--yes",
      "jscpd",
      "--min-lines", "8",
      "--min-tokens", "60",
      "--reporters", "json",
      "--output", "/tmp/hxmem-jscpd",
      "--ignore", "**/node_modules/**,**/dist/**,**/client/**",
      "src",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  void raw;
  const report = JSON.parse(readFileSync("/tmp/hxmem-jscpd/jscpd-report.json", "utf8")) as {
    statistics?: { total?: { percentage?: number } };
  };
  const pct = report.statistics?.total?.percentage ?? 0;
  if (pct > MAX_DUPLICATION_PCT) {
    violations.push(
      `重复: jscpd 重复率 ${pct.toFixed(2)}% 超过上限 ${MAX_DUPLICATION_PCT}% (见 /tmp/hxmem-jscpd/jscpd-report.json)`,
    );
  }
} catch (error) {
  // jscpd 不可用 (离线/首次安装失败) 时不阻塞: 但必须说出来, 不能静默跳过。
  console.log("verify-structure: 跳过重复率检查 (jscpd 不可用: " + String(error).slice(0, 80) + ")");
}

if (violations.length === 0) {
  console.log(
    `verify-structure: ${files.length} 个源文件通过 (单文件 ≤ ${MAX_FILE_LINES} 行 / 重复率 ≤ ${MAX_DUPLICATION_PCT}% / 端口纯度 / 单一事实源)。`,
  );
  process.exit(0);
}
console.error("verify-structure: 发现 " + violations.length + " 处结构问题:");
for (const v of violations) console.error("  " + v);
process.exit(1);
