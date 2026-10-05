// scripts/verify-rpc-coverage.ts — 每个 `@Remote` 端点都必须在**某个验证面**上出现过。
//
// 为什么需要它 (2026-09-18, §756): §753 我核端点覆盖时, 判据**只搜了 `tests/`** ——
// 于是把 6 个**已在真机 smoke 里被真的调用**的端点报成"零测试"。
//
// **⇒ 那次错误的形态是"虚报缺陷"**: 我差点据此去补 6 份不需要的测试。
// **⇒ 根因**: 只搜了一个面, 而结论是"**全都没有**"。
//
// 本脚本把那条规则机械化: **判据必须同时搜两层, 且把搜过的面打进输出** ——
// 那样"零覆盖"这个结论**可复核** (读输出就知道它搜了哪里)。
//
// ⚠ 它**不是**"覆盖率检查" (不要求每个端点有专门测试) —— 它守的是:
//   **"没有任何验证面提到过这个端点"这件事不会悄悄发生**。
//   端点被删/改名时, 这一条会红 (而不是等面板上出现空白)。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 搜过的**面** (每一步都出现在输出里 —— 否则结论不可复核)。 */
const SURFACES: ReadonlyArray<{ label: string; collect: () => Array<{ path: string; text: string }> }> = [
  { label: "tests/", collect: () => walkTextFiles(join(ROOT, "tests"), ".ts") },
  { label: "scripts/smoke-dsh.sh", collect: () => [readOne(join(ROOT, "scripts", "smoke-dsh.sh"))] },
];

function readOne(path: string): { path: string; text: string } {
  return { path: relative(ROOT, path), text: readFileSync(path, "utf8") };
}

function walkTextFiles(dir: string, suffix: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTextFiles(full, suffix));
    else if (name.endsWith(suffix)) out.push(readOne(full));
  }
  return out;
}

/** 从适配层源码里抽出全部 `@Remote("xxx")` 端点名。 */
function declaredEndpoints(): string[] {
  const out = new Set<string>();
  for (const f of walkTextFiles(join(ROOT, "src", "adapters", "dsh"), ".ts")) {
    for (const m of f.text.matchAll(/@Remote\("([a-zA-Z]+)"\)/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

const endpoints = declaredEndpoints();
const surfaces = SURFACES.map((s) => ({ label: s.label, files: s.collect() }));

console.log("verify-rpc-coverage: " + endpoints.length + " 个 @Remote 端点");
console.log("  搜过的面: " + surfaces.map((s) => s.label + " (" + s.files.length + " 文件)").join(", "));

const missing: string[] = [];
for (const ep of endpoints) {
  const re = new RegExp("\\b" + ep + "\\b");
  const hit = surfaces.find((s) => s.files.some((f) => re.test(f.text)));
  if (!hit) missing.push(ep);
}

if (missing.length) {
  console.error(
    "verify-rpc-coverage: **" + missing.length + " 个端点在上列所有面里都没出现过** " +
      "(删了端点却留下引用? 或新增端点但没进任何验证面):",
  );
  for (const m of missing) console.error("  " + m);
  console.error("  ⇒ 补一次引用 (测试或 smoke), 或在上面加一个该端点的真实使用面。");
  process.exit(1);
}
console.log("verify-rpc-coverage: 全部 " + endpoints.length + " 个端点都能在上列某个面里找到");
