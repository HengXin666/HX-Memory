// scripts/verify-gate-evidence.ts — 门禁**每一步**都必须有"它能失败"的证据。
//
// 为什么需要它 (2026-09-18, §759): §716 我建了 `verify-checks-can-fail` —— 但它只守
// `verify-structure` 的 17 条**判定项**。而门禁有 **15 步**, 每步是**各自独立**的检查脚本:
//
//   build / static×2 / tests / notes×2 / lint / structure / client-contract /
//   mutation / checks / docs / rpc-coverage / real-library / bench
//
// **⇒ 而"某一步从来没红过"是查不出来的** —— 它每次都打印 OK, 与"真的检查过"长得一样。
//
// §759 实测: `verify-bench-snapshot` 在归档里**提及 0 次** ⇒ 它从未被证明能失败
// (而我手动改坏 `bench/snapshot.json` 一次, 它立刻报了"指标漂移"并退出 1 ⇒ 它其实是好的)。
//
// **⇒ 本脚本把那张"证据账"变成可机械核对的**: 每步必须在 `docs/capture-audit.md` 里
// 有**至少一处**"该步失败被拦"的记录 (由人名/脚本名 + 失败语义构成)。
//
// ⚠ **它不是"跑一遍各步"** (那是 `verify.sh` 干的事) —— 它核的是**证据是否存在**,
// 且**证据的载体是归档** (那正是"教训落地"的地方)。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * 门禁每一步 → 它在归档里的**证据形式**。
 *
 * `mustMention`: 归档里必须出现这些串里的**任意一个**。
 *   · 用一个列表而不是单个串: 因为同一件事在不同轮次里写法不同 (脚本名 / npm script 名 / 中文步名)。
 * `why`: 该步"能失败"的具体证据是什么 —— 写在代码里, 使这条账**自解释**。
 */
const GATE_EVIDENCE: ReadonlyArray<{ step: string; mustMention: readonly string[]; why: string }> = [
  { step: "build", mustMention: ["tsc"], why: "tsc 报错即红 (多次)" },
  { step: "static(kernel)", mustMention: ["tsc --noEmit"], why: "同上, 分两个 tsconfig" },
  { step: "static(client)", mustMention: ["tsc --noEmit"], why: "同上" },
  { step: "tests", mustMention: ["vitest", "Tests  "], why: "每次变异探针都靠它红" },
  { step: "notes:classification", mustMention: ["verify-agent-note-classification"], why: "§580 实测抓到过我" },
  { step: "notes:format", mustMention: ["verify-agent-note-format", "缺少必需章节"], why: "§580 实测抓到过我" },
  { step: "lint", mustMention: ["oxlint", "no-unused-vars"], why: "§704 实测抓到 3 个未使用项" },
  { step: "structure", mustMention: ["verify-structure"], why: "§686/§725 多次 (行数/单一事实源/禁止模式)" },
  { step: "client-contract", mustMention: ["verify-client-contract"], why: "§568 建立时验过" },
  { step: "mutation", mustMention: ["mutation-probe", "变异探针"], why: "§653/§728" },
  { step: "checks(元验证)", mustMention: ["verify-checks-can-fail"], why: "§716" },
  { step: "docs", mustMention: ["verify-docs"], why: "多次" },
  { step: "rpc-coverage", mustMention: ["verify-rpc-coverage"], why: "§756" },
  { step: "real-library", mustMention: ["verify-real-library"], why: "§747" },
  { step: "bench-snapshot", mustMention: ["bench", "snapshot"], why: "§759 手动改坏 snapshot.json ⇒ 报指标漂移" },
  // §771: 沉睡字段登记 —— 证据 = 加一个不存在的机制名 ⇒ 报"登记表过期" + 退出 1。
  { step: "field-coverage", mustMention: ["verify-field-coverage"], why: "§771 理由里写不存在的机制名 ⇒ 报过期" },
  // ⚠ **它自己**也在门禁里 (第 17 步) ⇒ 必须同样有证据 (§759: 加同步断言时这条才被发现缺失)。
  { step: "gate-evidence", mustMention: ["verify-gate-evidence"], why: "§759 加一条假步 ⇒ 报缺证据 + 退出 1" },
  // `notes: coverage` 是**条件步** (CI 里工作区干净时也跑, 但可用 HX_SKIP_NOTE_COVERAGE 跳过):
  // 它同样用 `step` 登记, 故计入总数。
  { step: "notes:coverage", mustMention: ["verify-agent-note-coverage"], why: "§747 统一调用方式时验过它在链上" },
];

/**
 * ⚠ **先核对清单是否覆盖 `verify.sh` 的全部 step** (§759 实测: 本文件自己就是第 17 步,
 * 而它**不在下面的清单里** —— 那是自指问题, 而更一般的问题是"加了新步却忘了来这里登记")。
 *
 * 判据: 从 `verify.sh` 里数出 `step "` 的条数, 与本清单的条数比对。
 * 少了就报错 —— **一个漏登记的步骤等于"从未被要求提供证据"**。
 * (`notes: coverage` 是条件步, 它也用 `step` 登记 ⇒ 一并计入, 故与 verify.sh 的数相等。)
 */
const verifySh = readFileSync(join(ROOT, "scripts", "verify.sh"), "utf8");
// ⚠ 判据必须含**条件步** (`notes: coverage` 缩进在 `if` 里) —— 用 `^step` 会漏掉它,
// 而"漏掉"正是本检查要防的事 (§759 实测: 第一版用 `^step` ⇒ 数出 16, 而实际 17)。
const declaredSteps = (verifySh.match(/^\s*step "/gm) ?? []).length;
if (declaredSteps !== GATE_EVIDENCE.length) {
  console.error(
    "verify-gate-evidence: **清单不同步** —— verify.sh 登记了 " + declaredSteps +
      " 个 step, 而本清单只有 " + GATE_EVIDENCE.length + " 条。",
  );
  console.error("  ⇒ 补上缺失的步 (否则那一步**从未被要求提供'它能失败'的证据**)。");
  process.exit(1);
}

const archive = readFileSync(join(ROOT, "docs", "capture-audit.md"), "utf8");

const missing: string[] = [];
for (const row of GATE_EVIDENCE) {
  const hit = row.mustMention.some((m) => archive.includes(m));
  if (!hit) missing.push(row.step + "  (缺: " + row.mustMention.join(" / ") + ")");
}

console.log("verify-gate-evidence: " + GATE_EVIDENCE.length + " 步门禁的证据账");
for (const row of GATE_EVIDENCE) {
  const hit = row.mustMention.some((m) => archive.includes(m));
  console.log("  " + (hit ? "[OK]  " : "[MISS]") + " " + row.step.padEnd(20) + row.why);
}

if (missing.length) {
  console.error("verify-gate-evidence: **" + missing.length + " 步在归档里没有'它能失败'的证据**:");
  for (const m of missing) console.error("  " + m);
  console.error("  ⇒ 手动把那一步搞坏一次 (改快照/删字段/改阈值), 看它是否退出非 0, 然后把结果写进归档。");
  process.exit(1);
}
console.log("verify-gate-evidence: 每一步都有证据");
