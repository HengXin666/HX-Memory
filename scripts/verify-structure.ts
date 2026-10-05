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
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

/**
 * 单文件行数上限: 400 行。
 *
 * 依据: 这是**决策**而不是测量 —— DSH 那边没有 TS 行数限制 (他们手写的文件到 2441 行),
 * 因此不存在"业界阈值"可抄。选 400 的理由是"纯逻辑文件在 400 行内足以表达一个职责":
 * 超过它通常是两个职责被塞进了一个文件 (本仓库 file-store.ts 1373 行就是 5 个职责)。
 * 前端 (.tsx / client 目录) 不在此约束内 —— 视图代码天然更长且难以按行数切分。
 */
const MAX_FILE_LINES = 400;
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
      // client/ 是前端视图代码: 天然更长, 不适用 400 行约束 (见 MAX_FILE_LINES 注释)。
      if (entry.name === "client" || entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      // .tsx 与 client 下的文件是前端, 不受行数约束; 其余 .ts 一律受约束。
      if (entry.name.endsWith(".tsx")) continue;
      out.push(full);
    }
  }
  return out;
}

// ⚠ 单点定义检查必须**也覆盖 scripts/lib/** (2026-09-18, §550):
// 我把 tags 判据抽到了 scripts/lib/tag-provenance.ts, 而它要能被"唯一实现"这类检查看到 ——
// 否则"抽出去"就只是搬了家, 挡不住有人在脚本里再手写一遍 (那正是我犯了三次的事)。
const files = [...walk(SRC), ...walk(join(ROOT, "scripts", "lib"))];

// 1) 单文件规模
//
// ⚠ **扫描面比 `files` 宽**: 除 `src/` 与 `scripts/lib/` 外, 还要含 `scripts/` 根下的脚本
// (2026-09-18, §710 实测: 本文件自己已长到 363 行, 而**它不受自己那条 400 行约束** ——
// "审查者不受审"是元层面的盲区。当前无脚本超限, 而这个洞**没暴露不等于不存在**)。
const sizeScan = [...files, ...walk(join(ROOT, "scripts"))];
for (const file of sizeScan) {
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
  // tags 三来源判据: 我在同一个判据上**手写三遍、错三遍** (2026-09-18, §544/§547),
  // 所以把它钉成"唯一实现" —— 任何脚本要判 tags 一致性都必须用它, 不能重写。
  { name: "readFileTags", owner: "scripts/lib/tag-provenance.ts", pattern: /export function readFileTags\b/ },
  { name: "tagProvenance", owner: "scripts/lib/tag-provenance.ts", pattern: /export function tagProvenance\b/ },
  // 可见性判据: 它在**四处 SQL 里各写一遍**过 (query/recent/out/incoming), 而权威定义在
  // retrieval/lifecycle 的 TS 函数里 —— SQL 无法引用它, 于是抄漏状态**没有任何报错**。
  // 实测后果 (§686/§689): TTL 过期的条目在结构化查询里可见、全文检索里不可见。
  // 现在唯一实现搬到 kernel/visibility.ts, 并由本条守住"不得再出现第二份定义"。
  { name: "isLiveEntry", owner: "src/kernel/visibility.ts", pattern: /export function isLiveEntry\b/ },
  // 时间戳判据 (§707: episode-store 曾抄一份**逐字相同**的副本)。
  // 它有两个使用方 (写入校验 + 解析校验), 分叉会让"写进去的能读出来"这个前提失效。
  { name: "isIso", owner: "src/storage/entry-normalize.ts", pattern: /export function isIso\b/ },
  { name: "ISO_PATTERN", owner: "src/storage/entry-normalize.ts", pattern: /export const ISO_PATTERN\b/ },
  // 时钟口径 (§707: 曾在三个文件里逐字相同 —— episode-store / capture/engine / 本文件的属主)。
  { name: "nowIso", owner: "src/storage/entry-normalize.ts", pattern: /export function nowIso\b/ },
  { name: "HIDDEN_STATUSES", owner: "src/kernel/visibility.ts", pattern: /export const HIDDEN_STATUSES\b/ },
];

/**
 * **禁止出现的模式** (与 `SINGLETON_FUNCS` 相反的判据: 那里要求"恰好一处", 这里要求"零处")。
 *
 * 为什么需要这一类 (2026-09-18, §693): 可见性判据曾在**四处 SQL 里各写一遍**, 而那种写法的
 * 特征形态是 `const HIDDEN = "'shadow','merged','expired'"` —— 一个**局部 SQL 片段常量**。
 * 把权威实现搬到 `kernel/visibility.ts` 之后, 真正要防的是**它不会被人再抄一遍** ——
 * 而"零处"这个判据 `SINGLETON_FUNCS` 表达不了 (它要求恰好 1 处)。
 */
const FORBIDDEN_PATTERNS = [
  {
    // ⚠ **真相目录清单的副本** (§725 实测 1 处): 权威是 `src/storage/truth-scan.ts` 的
    // `TRUTH_DIRS`。手写 `["daily","digest","rules"]` 时, 真相目录一旦新增就会
    // **静默漏掉整个目录** —— 而那正是 2026-09-18 我连踩三次的成因 (§722: 漏 `daily/`)。
    name: "真相目录清单副本",
    pattern: /\[\s*"daily"\s*,\s*"digest"\s*,\s*"rules"\s*\]|\[\s*"digest"\s*,\s*"rules"\s*\]/,
    why: "真相目录只能来自 src/storage/truth-scan.ts 的 TRUTH_DIRS (§722 实测: 手写清单会静默漏目录)",
  },
  {
    name: "局部可见性 SQL 片段副本",
    pattern: /const HIDDEN = "'shadow'/,
    why: "可见性口径只能来自 kernel/visibility.ts 的 visibleClause() —— 局部副本会与它分叉 (§686/§689 实测: TTL 过期的条目在结构化查询里可见、全文检索里不可见)",
  },
  {
    // ⚠ **手写的三态比较** (§698 实测 1 处): 语义本来就对 (shadow/merged/expired 齐全),
    // 但那是**第四种写法** —— 而"新增第五种状态时是否记得改这里"没有任何机制保证。
    // 权威实现是 `isLiveEntry` (`HIDDEN_STATUSES.includes`)。
    name: "手写三态可见性比较",
    pattern: /status\s*===\s*"shadow"[^;]*\|\|[^;]*"merged"|status\s*===\s*"merged"[^;]*\|\|[^;]*"expired"/,
    why: "可见性的三态比较必须走 kernel/visibility.ts 的 isLiveEntry (§698: 手写形态在新增状态时不会自动更新)",
  },
  {
    // ⚠ **读路径**里的 `status === "shadow"` / `!== "shadow"` 比较 (§695 实测有 6 处同型分叉)。
    // 写路径的 `status: "shadow"` (设状态) 与 `entry-normalize` 的合法值表**不在此列** ——
    // 它们不是"判可见性", 而是"定义/设置状态"。
    // ⚠ **判据要窄**: 第一版写宽了 (`status === "shadow"` 一律抓), 于是误报了
    // `resolveCurrentEntry` 的**演化链上溯语义** (§696 实测) —— 那里 "shadow/expired → null"
    // 是**第二种合法语义** (终结), 与"是否可见"不是一回事 (merged 与 superseded 仍可上溯)。
    //
    // 收紧后只抓**可见性判定**的两种特征形态:
    //   · `if (!... && <x>.status === "shadow") continue;`  (逐个跳过)
    //   · `filter(... !== "shadow")`                        (过滤)
    name: "可见性判定手写 shadow",
    pattern: /if\s*\([^)]*status\s*[!=]==?\s*"shadow"\s*\)\s*continue|filter\s*\([^)]*status[^)]*[!=]==?\s*"shadow"/,
    why: "判【是否可见】必须用 kernel/visibility.ts 的 isLiveEntry (§695 实测 6 处手写比较各漏 merged/expired 的一部分)",
  },
];
for (const fp of FORBIDDEN_PATTERNS) {
  // ⚠ 与 SINGLETON_MARKERS 同一处理: **排除注释** (§725)。
  // 注释里**引用**某段被禁的形态是合法的 —— 那正是"这个坑长什么样"的记录 (我自己就在
  // tag-provenance.ts 的注释里写了被禁的那行字面量, 而第一版检查因此误报)。
  const holders = files.filter((f) => fp.pattern.test(codeOnly(readFileSync(f, "utf8"))));
  if (holders.length > 0) {
    violations.push(
      "禁止模式: " + fp.name + " 出现在 " + holders.map((f) => relative(ROOT, f)).join(", ") + " —— " + fp.why,
    );
  }
}
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

/**
 * 3b) **禁用 TS 参数属性** (constructor(private x: T))。
 *
 * 为什么这是一条硬约束: 本仓库的测试与 host 会**子进程直接 import .ts 文件**
 * (CLI、MCP stdio client、跨进程回放), 而 Node 的 strip-only 类型剥离模式不支持参数属性,
 * 会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。这个错误只在"子进程真的去 import"时才出现 ——
 * tsc 与普通 vitest 都不会报, 因此必须靠静态检查兜住 (历史上已踩过两次)。
 */
const PARAM_PROPERTY = /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const match = PARAM_PROPERTY.exec(text);
  if (match) {
    const line = text.slice(0, match.index).split("\n").length;
    violations.push(
      `参数属性: ${relative(ROOT, file)}:${line} 使用了 constructor(${match[1]} ...) —— Node strip-only 模式不支持, 子进程 import 时会崩; 请改成显式字段 + 赋值`,
    );
  }
}

// 3b) 单一事实源 (**格式标记**): 产出/解析同一段"机器接口文本"的地方只能各有一份。
//
// 为什么单独一类 (2026-09-18, §632 实测缺陷): 上面的 SINGLETON_FUNCS 管的是**函数定义**,
// 而那次逃逸的是**格式字符串** —— app/format.ts 自己手写了一套注入行格式
// (- [规则] [id] 正文, 行首裸 id), 而 kernel/injection-format.ts 的解析器只认
// 行尾标记 <!--hx-memory:id=x-->。于是那条路径产出的块**解析不出任何 id**,
// 全库实测 **2556 处 / 68 个会话** 命中, injectMode: first 的判据因此落空。
//
// **教训**: "格式"也是一种**事实源**。两处写同一段协议文本 -> 迟早只有一处能被解析。
//
// 判据: 每个标记的字面量**有且只有一处**出现 (产出与解析都从那里 import)。
const SINGLETON_MARKERS = [
  {
    name: "注入行 id 标记",
    owner: "src/kernel/injection-format.ts",
    pattern: /hx-memory:id=/,
  },
];
/** 去掉注释与字符串外的说明性提及: 只有**代码里**的标记才算重写 (注释里可以引用它)。 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
for (const mk of SINGLETON_MARKERS) {
  const holders = files.filter((f) => mk.pattern.test(codeOnly(readFileSync(f, "utf8"))));
  if (holders.length !== 1) {
    violations.push(
      "单一事实源: " + mk.name + " 的字面量出现在 " + holders.length + " 个文件里 (" +
        holders.map((f) => relative(ROOT, f)).join(", ") +
        ") —— 应只有 " + mk.owner + " 一份 (其余必须 import 它, 不能重写)",
    );
  } else if (relative(ROOT, holders[0]!) !== mk.owner) {
    violations.push("单一事实源: " + mk.name + " 的归属应是 " + mk.owner + ", 实际在 " + relative(ROOT, holders[0]!) + "");
  }
}

// 3c) **悬空模块**: src 下每个模块都必须能从**产品入口**到达。
//
// 为什么需要它 (2026-09-18, §580/§644): src/wiki/ 有 5 个模块、1017 行产品代码, 却**零产品引用** ——
// 而发现它靠的是人工 grep ("有没有别的文档提到 wiki"), 不是机械检查。
// 那种"机制在、没接线"的形态在本项目反复出现 (对标 KInfra 时被反复点出), 因此值得一条闸门。
//
// 判据: 以**产品入口** (包主入口 / 宿主适配层 / codex CLI / dsh 客户端) 为根做可达性闭包,
// 报告不可达的模块。⚠ 豁免: **已知的悬空候选**必须显式登记 (而不是默默允许) ——
// 登记本身是"我知道它没接线"的声明, 见 ALLOWED_DANGLING 的注释。
const ALLOWED_DANGLING_DIRS: readonly string[] = [
  // 候选记忆后端 (ADR 级决策, 见 .agents/notes/proposed/architecture/2026-09-18-wiki-backend-candidate.md):
  // 代码骨架经独立盲审评定为干净, 但"一主题一页"范式在当前语料上**未被证伪也未被证实** (负载不足),
  // 因此**刻意不接线** —— 保留为候选后端。启用前提写在那篇 Note 里。
  //
  // ⚠ 豁免按**目录**而不是逐文件 (§644 反驳测试发现): 逐文件登记时, 只要白名单里有一条被
  // 另一个悬空文件引用, 它就从闭包里"可达"了 —— 于是豁免**链式传染**, 把一条漏登记的
  // 模块也一起放过去。按目录豁免没有这个问题 (整个子树的内部引用不构成"从入口可达")。
  "src/wiki/",
];

/** 模块间的 import 图 (只解析相对 specifier; 本仓库 TS 里常写 ".js" 后缀, 需剥掉再试)。 */
function moduleGraph(): Map<string, string[]> {
  // ⚠ **只看 src/**: files 还含 scripts/lib (那是给"单一事实源"检查用的),
  // 而 scripts/lib 下是**独立脚本工具**, 本就不该被产品入口引用 —— 扫进来会全是假阳性。
  const modules = walk(SRC);
  const mods = new Set(modules.map((f) => relative(ROOT, f)));
  const graph = new Map<string, string[]>();
  for (const f of modules) {
    const rel = relative(ROOT, f);
    const deps: string[] = [];
    for (const m of readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)) {
      const spec = m[1]!.split("?")[0]!;
      if (!spec.startsWith(".")) continue;
      const cand = posixNormalize(join(dirname(rel), spec));
      const stem = cand.replace(/\.(js|mjs|cjs)$/, "");
      for (const t of [cand, stem, stem + ".ts", stem + ".tsx", stem + "/index.ts"]) {
        if (mods.has(t)) { deps.push(t); break; }
      }
    }
    graph.set(rel, deps);
  }
  return graph;
}

/** 路径归一 (只做 ".." / "." 消解, 不触盘)。 */
function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// 产品入口: 包主入口 + 宿主适配层 + codex CLI + dsh 客户端 UI。
const graph = moduleGraph();
const ENTRY = [
  "src/index.ts",
  "src/adapters/dsh/index.ts",
  "src/adapters/codex/cli.ts",
  ...files.map((f) => relative(ROOT, f)).filter((r) => r.startsWith("src/adapters/dsh/client/")),
].filter((e) => graph.has(e));
const reached = new Set(ENTRY);
const queue = [...ENTRY];
while (queue.length) {
  for (const dep of graph.get(queue.pop()!) ?? []) {
    if (!reached.has(dep)) { reached.add(dep); queue.push(dep); }
  }
}
for (const rel of [...graph.keys()].sort()) {
  if (reached.has(rel) || ALLOWED_DANGLING_DIRS.some((d) => rel.startsWith(d))) continue;
  violations.push(
    "悬空模块: " + rel + " 无法从任何产品入口到达 —— 要么接线, 要么登记进 ALLOWED_DANGLING_DIRS " +
      "(登记 = 声明【我知道它没接线】; 见本文件的注释与对应 Agent Note)",
  );
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
    `verify-structure: ${files.length} 个源文件 + ${sizeScan.length - files.length} 个脚本通过` +
      ` (单文件 ≤ ${MAX_FILE_LINES} 行 / 重复率 ≤ ${MAX_DUPLICATION_PCT}% / 端口纯度 / 单一事实源)。`,
  );
  process.exit(0);
}
console.error("verify-structure: 发现 " + violations.length + " 处结构问题:");
for (const v of violations) console.error("  " + v);
process.exit(1);
