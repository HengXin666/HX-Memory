// scripts/mutation-probe.ts — 变异探针: 检验**测试是否真有防护力**。
//
// 为什么需要它 (2026-09-18, §541 用过一次手工版, §653 固化): 一个测试全绿**不等于**它守住了什么 ——
// 断言可能只是"跑过就算过"。唯一能证明防护力的方法是**故意破坏实现, 看它是否变红**。
//
// 本脚本把那个手法批量可重复做:
//   1. 对每个变异 (在指定文件里把某段文本换成另一段), 先备份原文件;
//   2. 跑指定范围的测试, 记录是否失败;
//   3. **无论结果如何都还原** (finally);
//   4. 报告: 每个变异"被拦住"(测试红了) 还是"逃逸"(测试仍绿 = 断言无效)。
//
// ⚠ **它必须能失败**: 一个"永远报成功"的探针等于没有探针。因此若某个变异逃逸, 脚本以非 0 退出。
//
// 用法:
//   node --experimental-strip-types scripts/mutation-probe.ts            # 跑内置清单
//   node --experimental-strip-types scripts/mutation-probe.ts --list     # 只列清单
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Mutation {
  /** 人类可读的变异描述 (报告里显示)。 */
  name: string;
  /** 被改的文件 (相对仓库根)。 */
  file: string;
  /** 原文 (必须精确匹配, 且只出现一次)。 */
  from: string;
  /** 改成什么。 */
  to: string;
  /** 该变异应该被哪些测试拦住 (传给 vitest 的路径)。 */
  tests: string;
}

/**
 * 内置清单: 每条都对应一个**我做过的修复** —— 探针守的就是"那个修复不会被悄悄退回去"。
 *
 * 为什么绑定"修复"而不是随便挑代码: 随便挑的变异红不红都不说明问题;
 * 而这里每条都曾在真实数据上暴露过缺陷 (§编号在各条注释里), 所以它们**必须**被守住。
 */
const MUTATIONS: readonly Mutation[] = [
  {
    name: "extractTags 退回\"纯数字也抽\" (§541: 真库出现 tag \"10\")",
    file: "src/storage/entry-normalize.ts",
    from: '    if (/^\\d+$/.test(tag)) continue;',
    to: '    // (变异: 去掉纯数字判据)',
    tests: "tests/s2/extract-tags-numbering.test.ts",
  },
  {
    name: "parseTags 退回\"哨兵值当标签\" (§541: 索引出现字面量 \"undefined\")",
    file: "src/storage/markdown-parse.ts",
    from: '  if (low === "" || low === "undefined" || low === "null") return false;',
    to: '  if (low === "") return false;',
    tests: "tests/s2/parse-tags-hardening.test.ts",
  },
  {
    // ⚠ 2026-09-29: 语义随"两条出口分开"的改动升级 (见 injection-format.ts 的 formatHitLine)。
    // formatRetrieval 是**检索结果**出口 (模型主动要的结果, memory_flag 按 id 操作),
    // 它**必须带 id**; 而被动注入块 (`formatEntryLine`) 刻意不带 (id 走消息 source)。
    // 变异体还原**缺陷形态**: 检索结果丢掉 id ⇒ 模型拿到结果却无法引用/标注它。
    // (§632 的原缺陷"行尾无可解析标记"已不复存在 —— id 现在根本不在正文里了, 判据也随之上移。)
    name: "formatRetrieval 丢掉命中 id (§2026-09-29: 检索结果不可引用, memory_flag 无从下手)",
    file: "src/app/format.ts",
    from: "    lines.push(formatHitLine(e.id, e.content, e.kind));",
    to: "    lines.push(formatEntryLine(e.id, e.content, e.kind));",
    tests: "tests/s2/injection-format-single-source.test.ts",
  },
  {
    // ⚠ 2026-09-27: from 串随"kind 白名单与 scope 判据解耦"的修复同步更新 ——
    // 那行由 `if (e.project !== opts.project) return false;` 改成 `return e.project === opts.project;`
    // (该分支上面已由 `!isAlwaysOnKind` 挡掉非法 kind, 这里只判可见性)。
    // 探针的 from 串必须与实现**同步演进**, 否则它会 SKIP 并以非 0 退出 ——
    // 而"SKIP 不算通过"正是本探针的纪律 (见文件末尾)。
    name: "always-on 放宽项目隔离 (§含 §579 的实测泄漏: 别的项目的私有记忆被当本项目事实)",
    file: "src/trigger/always-on.ts",
    from: "        return e.project === opts.project;",
    to: "        return true;",
    tests: "tests/s2/trigger-cache-project.test.ts",
  },
  {
    // 2026-09-27 新增 (真实缺陷): memory_search 不带 scope ⇒ 搜全库, 实测 9 条里 7 条属于别的项目。
    // 变异体还原"agent 侧不声明范围要求"的形态 —— 没有工作区时项目内条目就不再被挡。
    name: "memory_search 丢掉工作区范围 (§2026-09-27: 跨项目泄露, 实测 9 条里 7 条属别的项目)",
    file: "src/adapters/dsh/tools.ts",
    // 锚定 facade 分支那一处 (另一处 retriever 分支缩进不同) —— 探针要求 from 恰好唯一匹配。
    from: "                scopeRequired: true,\n                ...(Object.keys(ranged).length ? { scope: ranged } : {}),\n              }).hits",
    to: "                scopeRequired: false,\n                ...(Object.keys(ranged).length ? { scope: ranged } : {}),\n              }).hits",
    tests: "tests/s2/memory-search-scope.test.ts",
  },
  {
    // 2026-09-27: 判据收口到 kernel 后, "agent 侧要求范围"的缺省差异也在这里 —— 变异它等于
    // 让"不知道工作区"退化成"全都给" (那正是实测过的泄漏形态)。
    name: "projectEntryVisible 缺省退化 (§2026-09-27: 不知道工作区时退化为'全都给')",
    file: "src/kernel/project-lineage.ts",
    from: "  return opts?.required ? false : true;",
    to: "  return true;",
    tests: "tests/s2/memory-search-scope.test.ts",
  },
  {
    // 2026-09-27 新增 (真实缺陷): kind 白名单与 scope 可见性本是正交的两件事,
    // 而 project 分支此前提前 return 把白名单整个绕过 (实测混进 348 条 lesson)。
    // 这条变异还原缺陷的**本质** —— "scope 命中即放行, 不再看 kind"。
    name: "always-on 白名单被 scope 绕过 (§2026-09-27: lineage 命中时 348 条 lesson 混入候选)",
    file: "src/trigger/always-on.ts",
    from: "      if (!isAlwaysOnKind(e.kind)) return false;",
    to: "      if (!isAlwaysOnKind(e.kind) && e.scope !== \"project\") return false;",
    tests: "tests/s2/always-on-kind-whitelist.test.ts",
  },
  {
    // 2026-09-27 新增: 排序缺确定性 tiebreak 时, 结果取决于输入数组顺序 ——
    // 两个入口 (all() 的文件序 vs entrySummaries() 的 SQL 行序) 会选出**不同集合** (实测 8 vs 9 条)。
    name: "always-on 排序丢掉确定性 tiebreak (§2026-09-27: 结果依赖输入顺序, 两入口口径分叉)",
    file: "src/trigger/always-on.ts",
    from: "    .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));",
    to: "    .sort((a, b) => b.score - a.score);",
    tests: "tests/s2/always-on-kind-whitelist.test.ts",
  },
  {
    name: "弃权闸门失效 (§421/§623: 库外问题必须返回空)",
    file: "src/retrieval/hybrid.ts",
    from: 'if (req.coverageMode !== "candidate" && gateTerms.weighted.length && shouldAbstain(result.hits, gateTerms.weighted)) {',
    to: "if (false) {",
    tests: "tests/s2/abstain-sample-validity.test.ts tests/s2/abstain-word-boundary.test.ts",
  },
  {
    name: "原子写不写内容 (§实测: 崩溃/断电会得到空文件)",
    file: "src/storage/markdown-codec.ts",
    from: '    writeSync(fd, content);',
    to: '    writeSync(fd, "");',
    tests: "tests/s2/atomic-write.test.ts",
  },
  {
    // §686: query 此前只挡 shadow, 而 searchText 挡三种 ⇒ 口径分叉。
    name: "query 退回只挡 shadow (§686: 口径分叉, expired 在结构化查询里可见)",
    file: "src/storage/index-reader.ts",
    from: "if (!q.includeShadow) clauses.push(visibleClause());",
    to: 'if (!q.includeShadow) clauses.push("status != \'shadow\'");',
    tests: "tests/s2/query-visibility-parity.test.ts",
  },
  {
    // §701: 空条目会进 always-on (占预算 + 注入空白)。
    name: "去掉空内容闸门 (§701: 空条目会进 always-on)",
    file: "src/storage/memory-store.ts",
    from: '      throw new Error("entry content must not be empty");',
    to: "      void 0;",
    tests: "tests/s1/empty-content-gate.test.ts",
  },
  {
    // §704: MemoryStore 此前手写校验副本 ⇒ 与 FileBackend 行为不一致。
    name: "MemoryStore 绕过 normalizeEntry (§704: 非法 status/id 会被接受)",
    file: "src/storage/memory-store.ts",
    from: "    const entry = normalizeEntry({",
    to: "    const entry = ((x: never) => x)({",
    tests: "tests/s1/engine-gate-parity.test.ts",
  },
  {
    // §722/§725: 手写/部分目录清单会**静默漏掉整个真相目录**。
    name: "scanTruth 只扫部分真相目录 (§722: 漏 daily/ 会造成假的'缺数据')",
    file: "src/storage/truth-scan.ts",
    from: "  const seen = new Map<string, MemoryEntry>();\n  for (const dir of TRUTH_DIRS) {",
    to: "  const seen = new Map<string, MemoryEntry>();\n  for (const dir of TRUTH_DIRS.slice(1)) {",
    tests: "tests/s1/truth-scan-and-tag-provenance.test.ts",
  },
  {
    // §737: purpose 与 rules 通道的契约 (判据写反 ⇒ inject 也丢保底不变量)。
    name: "purpose 判据写反 (§737: inject 会丢保底规则)",
    file: "src/retrieval/hybrid.ts",
    from: 'const recall = req.purpose === "recall";',
    to: 'const recall = req.purpose !== "recall";',
    tests: "tests/s2/purpose-channel-contract.test.ts",
  },
  {
    // §741: coverageMode 让弃权闸门失效 (近邻查找会因弃权而召回不到候选)。
    name: "coverageMode 失效 (§741: 近邻查找会被弃权清空)",
    file: "src/retrieval/hybrid.ts",
    from: 'if (req.coverageMode !== "candidate" && gateTerms.weighted.length && shouldAbstain(result.hits, gateTerms.weighted)) {',
    to: 'if (gateTerms.weighted.length && shouldAbstain(result.hits, gateTerms.weighted)) {',
    tests: "tests/s2/coverage-mode-contract.test.ts",
  },
  {
    name: "deleteEntry 无 facade 时不退回 store.remove (§647)",
    file: "src/adapters/dsh/gateway.ts",
    from: "this.deps.store.remove(id);",
    to: "void id;",
    tests: "tests/s3/gateway-untested-endpoints.test.ts",
  },
];

function runVitest(path: string): boolean {
  try {
    execFileSync("npx", ["vitest", "run", path, "--reporter=basic"], {
      cwd: ROOT,
      stdio: "ignore",
      timeout: 300_000,
    });
    return true; // 全绿
  } catch {
    return false; // 有失败 (或不通过)
  }
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const m of MUTATIONS) console.log("  " + m.name + "  →  " + m.tests);
  process.exit(0);
}

console.log("mutation-probe: " + MUTATIONS.length + " 个变异");
const escaped: string[] = [];
const skipped: string[] = [];
for (const m of MUTATIONS) {
  const abs = join(ROOT, m.file);
  const backup = abs + ".mutation-backup";
  if (!existsSync(abs)) { console.log("  SKIP (文件不存在): " + m.file); skipped.push(m.name); continue; }
  const original = readFileSync(abs, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log("  SKIP (原文出现 " + hits + " 次, 需恰好 1 次): " + m.name);
    skipped.push(m.name);
    continue;
  }
  let caught = false;
  try {
    copyFileSync(abs, backup);
    writeFileSync(abs, original.replace(m.from, m.to));
    const green = runVitest(m.tests);
    caught = !green;
  } finally {
    // ⚠ 无论成功失败都必须还原 —— 一个会留下变异的探针会破坏整个工作区。
    if (existsSync(backup)) {
      copyFileSync(backup, abs);
      unlinkSync(backup);
    }
  }
  console.log((caught ? "  CAUGHT  " : "  ESCAPED ") + m.name);
  if (!caught) escaped.push(m.name);
}

if (escaped.length) {
  console.error("mutation-probe: **" + escaped.length + " 个变异逃逸** —— 对应断言没有防护力:");
  for (const e of escaped) console.error("  " + e);
  process.exit(1);
}
// ⚠ SKIP **不算通过**: 一个因为"原文串不匹配"而跳过的变异, 它守的东西**根本没有被验证** ——
// 而报告若把它算进"全部被拦住", 那就是**探针自己在说谎** (比没有探针更糟)。
const probed = MUTATIONS.length - skipped.length;
if (skipped.length) {
  console.error(
    "mutation-probe: **" + skipped.length + " 个变异被 SKIP** (原文串不匹配 ⇒ 对应断言未被验证):",
  );
  for (const s of skipped) console.error("  " + s);
  console.error("  ⇒ 修好 from 串再跑; " + probed + "/" + MUTATIONS.length + " 个真正被验证且拦住");
  process.exit(1);
}
console.log("mutation-probe: 全部 " + MUTATIONS.length + " 个变异被拦住 (断言有防护力)");
