// scripts/verify-checks-can-fail.ts — **检查器自身的元验证**: 每个判定项都必须能真的失败。
//
// 为什么需要它 (2026-09-18, §716): `verify-structure.ts` 里现在有 16 个判定项
// (12 个 `SINGLETON_FUNCS` + 4 个 `FORBIDDEN_PATTERNS`)。而**一个永远不触发的检查等于没有** ——
// pattern 写错一个字符、属主路径改了、正则的引号层级不对, 它就会**静默地永远通过**。
//
// 本脚本对**每一项**做一次反驳: 在某个文件里注入该判据的"违规形态", 跑检查, 看它是否报出来,
// **无论结果如何立刻还原**。任何一项没被抓住就以非 0 退出。
//
// ⚠ **它必须只读地跑** (注入→检查→还原都在 finally 里), 且**只改一个文件一次** ——
// 与 `mutation-probe` 同一种"故意破坏看它红不红"的思路, 只是对象换成了**检查器自己**。
//
// 用法: node --experimental-strip-types scripts/verify-checks-can-fail.ts [--list]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Probe {
  /** 被验证的判定项名 (要与 verify-structure 的输出里那一段对得上)。 */
  name: string;
  /** 往哪个文件注入违规形态 (选一个**不在扫描面之外**的普通源文件)。 */
  file: string;
  /** 注入的内容 (该判据的"违规形态")。 */
  inject: string;
}

/** 每一项都对应 `verify-structure.ts` 里的一条判定。 */
const PROBES: readonly Probe[] = [
  // ---- SINGLETON_FUNCS (12) ----
  { name: "tokenSet", file: "src/storage/memory-store.ts", inject: "export function tokenSet() { return new Set(); }" },
  { name: "fnv1a32", file: "src/storage/memory-store.ts", inject: "export function fnv1a32(s: string) { return s.length; }" },
  { name: "l2Normalize", file: "src/storage/memory-store.ts", inject: "export function l2Normalize(v: number[]) { return v; }" },
  { name: "contentFingerprint", file: "src/storage/memory-store.ts", inject: "export function contentFingerprint(s: string) { return s; }" },
  { name: "termStreams", file: "src/storage/memory-store.ts", inject: "export function termStreams(s: string) { return s; }" },
  { name: "readFileTags", file: "src/storage/memory-store.ts", inject: "export function readFileTags(p: string) { return p; }" },
  { name: "tagProvenance", file: "src/storage/memory-store.ts", inject: "export function tagProvenance(e: unknown) { return e; }" },
  { name: "isLiveEntry", file: "src/storage/memory-store.ts", inject: "export function isLiveEntry(e: { status?: string }) { return true; }" },
  { name: "isIso", file: "src/storage/memory-store.ts", inject: "export function isIso(s: string) { return true; }" },
  { name: "ISO_PATTERN", file: "src/storage/memory-store.ts", inject: "export const ISO_PATTERN = /x/;" },
  { name: "nowIso", file: "src/storage/memory-store.ts", inject: "export function nowIso() { return ''; }" },
  { name: "HIDDEN_STATUSES", file: "src/storage/memory-store.ts", inject: "export const HIDDEN_STATUSES = [];" },
  // ---- FORBIDDEN_PATTERNS (4) ----
  { name: "注入行 id 标记", file: "src/storage/memory-store.ts", inject: 'const X = "hx-memory:id=";' },
  {
    name: "局部可见性 SQL 片段副本",
    file: "src/storage/memory-store.ts",
    inject: "const HIDDEN = " + String.fromCharCode(34) + "'shadow'" + String.fromCharCode(34) + ";",
  },
  {
    name: "可见性判定手写 shadow",
    file: "src/storage/memory-store.ts",
    inject: 'export function f(e: { status?: string }): number { for (const x of [e]) { if (x.status === "shadow") continue; } return 0; }',
  },
  {
    name: "真相目录清单副本",
    file: "src/storage/memory-store.ts",
    inject:
      "const DIRS = [" +
      String.fromCharCode(34) + "daily" + String.fromCharCode(34) + ", " +
      String.fromCharCode(34) + "digest" + String.fromCharCode(34) + ", " +
      String.fromCharCode(34) + "rules" + String.fromCharCode(34) + "];",
  },
  {
    name: "手写三态可见性比较",
    file: "src/storage/memory-store.ts",
    inject: 'export function g(e: { status?: string }) { return e.status === "shadow" || e.status === "merged" || e.status === "expired"; }',
  },
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const p of PROBES) console.log("  " + p.name);
  process.exit(0);
}

// ⚠ **先核对清单是否与 verify-structure 对齐** (2026-09-18, §725 实测: 我加了新判定项
// 却忘了在这里加探针 ⇒ **元验证静默少探一项**, 而它自己是绿的)。
// 判据: 从 `verify-structure.ts` 的源码里数出它声明了几个判定项 (SINGLETON + FORBIDDEN),
// 与 PROBES 数比对 —— 少了就报错。**一个"永远比被验证对象少一项"的元验证等于漏网。**
{
  const vsSrc = readFileSync(join(ROOT, "scripts", "verify-structure.ts"), "utf8");
  // ⚠ 计数要按**三类判据的声明总数**: 用 `{ name: "` 会漏掉 SINGLETON_MARKERS 的缩进形态
  // (它在数组元素里另起一行) —— 第一版就漏了它, 于是报"12 vs 17"的假不同步。
  const declared = (vsSrc.match(/^\s*\{?\s*name: "/gm) ?? []).length;
  if (declared !== PROBES.length) {
    console.error(
      "verify-checks-can-fail: **清单不同步** —— verify-structure 声明了 " +
        declared + " 个判定项, 而本脚本只探 " + PROBES.length + " 个。",
    );
    console.error("  ⇒ 补上缺失的探针, 否则那个判定项**从未被证明能失败**。");
    process.exit(1);
  }
}

console.log("verify-checks-can-fail: " + PROBES.length + " 个判定项");
const missed: string[] = [];
for (const p of PROBES) {
  const abs = join(ROOT, p.file);
  if (!existsSync(abs)) { console.log("  SKIP (文件不存在): " + p.name); missed.push(p.name + " (文件不存在)"); continue; }
  const backup = abs + ".checkscan-backup";
  let caught = false;
  try {
    copyFileSync(abs, backup);
    writeFileSync(abs, readFileSync(abs, "utf8") + "\n" + p.inject + "\n");
    try {
      execFileSync("pnpm", ["run", "verify-structure"], { cwd: ROOT, stdio: "pipe", timeout: 300_000 });
      caught = false; // 全绿 ⇒ 没报出来
    } catch (e) {
      const out = String((e as { stdout?: Buffer }).stdout ?? "") + String((e as { stderr?: Buffer }).stderr ?? "");
      caught = out.includes(p.name);
    }
  } finally {
    if (existsSync(backup)) { copyFileSync(backup, abs); unlinkSync(backup); }
  }
  console.log((caught ? "  CAUGHT  " : "  MISS    ") + p.name);
  if (!caught) missed.push(p.name);
}

if (missed.length) {
  console.error("verify-checks-can-fail: **" + missed.length + " 个判定项抓不到它该抓的东西** —— pattern 写错或属主变了:");
  for (const m of missed) console.error("  " + m);
  process.exit(1);
}
console.log("verify-checks-can-fail: 全部 " + PROBES.length + " 个判定项都能真的失败 (检查不是摆设)");
