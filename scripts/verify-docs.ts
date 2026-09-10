/**
 * Gate: 文档同步 (学习 deepseek-harness 的 doc-sync, 按本仓库规模裁剪到轻量版)。
 *
 * 为什么需要: 文档最常见的失效不是"写得不好", 而是**写得对但指的路径已经不存在** ——
 * 重命名文件、挪动目录、删掉脚本之后, 文档里的引用静默变成谎言, 而没人会发现。
 * DSH 用一整套 (verify-doc-refs / verify-doc-budgets / verify-translation-pairing …) 解决;
 * 本仓库不需要双语配对与生成式目录, 因此只保留最有效的两条:
 *
 *   1. **引用可达性**: 文档里出现的仓库内路径必须真实存在 (解析顺序见 resolveRef);
 *   2. **结构合规**: docs/ 下每份文档必须声明"目的 / 边界 / 与代码的关系", 且不留 TODO/FIXME。
 *
 * 引用解析顺序 (按宽松到严格, 避免把"提到文件名"误判成坏引用):
 *   a. 相对于该文档所在目录; b. 相对于仓库根; c. 相对于 `src/` (文档里常写 kernel/foo.ts 这种 src 内相对路径);
 *   d. 无路径分隔符时, 按**文件名**在仓库内检索 (文档常见写法: `prestep.ts`)。
 *
 * 站外引用 (上游仓库、运行时数据目录) 用行末 HTML 注释显式放行: `<!-- verify-docs:allow -->`。
 * 之所以要显式: 让"这是外部引用"成为作者的有意声明, 而不是 gate 猜出来的豁免。
 *
 * 不做的事 (明确边界): 不检查措辞、不做字数预算 (本仓库文档规模小且变动频繁, 预算会变噪声)、
 * 不校验外部 URL (网络抖动会让 gate 变成 flaky —— 那是 CI 诅咒)。
 *
 * 用法: node --experimental-strip-types scripts/verify-docs.ts
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOC_DIRS = ["docs"];
const DOC_ROOT_FILES = ["README.md", "CONTRIBUTING.md", "AGENTS.md"];

/**
 * 文档里不要出现的过程痕迹。
 * 只看"标记形状" (TODO: / TODO( / // TODO / - TODO) —— 散文里讨论"不留 TODO"不该被判违规
 * (实测踩过: CONTRIBUTING 里"无 TODO/emoji"这句被旧版规则误伤)。
 */
const FORBIDDEN = [/(?:^|[\s(`/])TODO\s*[:(()]/, /(?:^|[\s(`/])FIXME\s*[:(()]/];
/** docs/ 下必须声明的三要素 (与 .agents/rules/docs.md 一致)。 */
const REQUIRED_SECTIONS = ["目的", "边界", "与代码的关系"];
/** 行末放行标记 (站外引用 / 运行时路径)。 */
const ALLOW_MARKER = "verify-docs:allow";

interface Violation {
  file: string;
  line: number;
  detail: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** 仓库内文件名索引 (用于"只写了文件名"的引用解析), 排除 node_modules/dist/.git。 */
const NAME_INDEX = new Set<string>();
(function buildIndex(dir: string, depth = 0): void {
  if (depth > 8) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) buildIndex(full, depth + 1);
    else NAME_INDEX.add(entry.name);
  }
})(ROOT);

function docs(): string[] {
  const files: string[] = [];
  for (const dir of DOC_DIRS) files.push(...walk(resolve(ROOT, dir)));
  for (const name of DOC_ROOT_FILES) {
    const full = resolve(ROOT, name);
    if (existsSync(full)) files.push(full);
  }
  return files.sort();
}

/** 从一行里抽出"指向文件"的路径 (markdown 链接 + 行内代码里的带扩展名路径)。 */
function repoPathsIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\]\(([^)]+)\)/g)) {
    const target = (m[1] ?? "").trim();
    if (!target || /^(https?:|mailto:|#|data:)/.test(target)) continue;
    out.push((target.split("#")[0] ?? target).trim());
  }
  for (const m of line.matchAll(/`([A-Za-z0-9_.@/-]+\.(?:ts|tsx|mjs|js|json|md|sh|yml|yaml))`/g)) {
    out.push((m[1] ?? "").trim());
  }
  return out.filter((p) => p.length > 0 && !p.startsWith("http"));
}

/** 解析一个引用: 任一候选存在即视为可达。返回 null 表示可达, 否则返回失败说明。 */
function resolveRef(fromFile: string, raw: string): string | null {
  const candidates = [
    resolve(dirname(fromFile), raw),
    resolve(ROOT, raw),
    resolve(ROOT, "src", raw),
  ];
  for (const candidate of candidates) {
    try {
      statSync(candidate);
      return null;
    } catch {
      // 继续尝试下一个根
    }
  }
  // 只写了文件名 (没有路径分隔符) → 按文件名索引判断。
  if (!raw.includes("/") && NAME_INDEX.has(basename(raw))) return null;
  return raw;
}

const files = docs();
const violations: Violation[] = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const lines = readFileSync(file, "utf8").split("\n");
  const text = lines.join("\n");

  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return; // 作者显式声明为站外引用
    const missing = repoPathsIn(line)
      .map((raw) => resolveRef(file, raw))
      .filter((x): x is string => x !== null);
    for (const raw of missing) {
      violations.push({ file: rel, line: index + 1, detail: "引用不存在: " + raw });
    }
    for (const re of FORBIDDEN) {
      if (re.test(line)) {
        violations.push({
          file: rel,
          line: index + 1,
          detail: "残留过程标记: " + line.trim().slice(0, 60),
        });
      }
    }
  });

  if (rel.startsWith("docs/")) {
    const missingSections = REQUIRED_SECTIONS.filter((section) => !text.includes(section));
    if (missingSections.length) {
      violations.push({
        file: rel,
        line: 1,
        detail:
          "缺少文档声明: " +
          missingSections.join(" / ") +
          " (docs 规则要求每份文档声明目的/边界/与代码的关系)",
      });
    }
  }
}

if (violations.length === 0) {
  console.log("verify-docs: 检查 " + files.length + " 份文档, 引用可达、结构合规。");
  process.exit(0);
}
console.error("verify-docs: 发现 " + violations.length + " 处问题:");
for (const v of violations) console.error("  " + v.file + ":" + v.line + "  " + v.detail);
process.exit(1);
