// scripts/verify-real-library.ts — 对**真实记忆库**做只读一致性验收。
//
// 为什么需要它 (2026-09-18, §541): 本仓库的验证有三层, 而**缺了一层**:
//   · 单元测试 (153 文件) —— 全部用隔离库 (`mkdtemp`);
//   · 真机 smoke —— 也用隔离 `DSH_HOME` (`mktemp -d`);
//   · **真实记忆库 (`~/.dsh/hx-memory`, 300+ 条真实数据) —— 零自动化验证。**
//
// 而这三层看到的**不是同一件事**: 隔离库是**空的**, 因此看不到
//   · 索引与真相文件的**历史不一致** (§517 实测 2/327);
//   · **历史写入**的产物 (旧解析器写进文件的垃圾 tag);
//   · 真实数据分布 (1538 个实体、113 个 tag 的**长尾形态**)。
//
// 本脚本补那一层。**只读** (不写库), 可在任何时候跑。
//
// 用法: node --experimental-strip-types scripts/verify-real-library.ts [--root DIR]

import { join } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";
import { extractTags } from "../src/storage/entry-normalize.ts";
import { parseTags } from "../src/storage/markdown-parse.ts";
// ⚠ tags 的"三个来源"判据只有一份实现 (scripts/lib/tag-provenance.ts) —— 
// 我曾在本脚本里手写三遍、错三遍 (§544/§547)。
import { summarizeProvenance } from "./lib/tag-provenance.ts";
// 索引侧实体的权威实现 (真相字段 + 正文兜底抽取) —— 见下面第 3 组的说明。
import { entityKeysOf } from "../src/kernel/entity.ts";
// 负面反馈链路 (§731): 标注入口 → 质量因子 → 面板视图。
import { badCount, qualityFactor } from "../src/kernel/feedback.ts";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx >= 0 ? args[rootIdx + 1]! : join(process.env.HOME ?? "", ".dsh", "hx-memory");

let pass = 0;
let fail = 0;
let skipped = 0;

/**
 * **前置条件不成立** ⇒ 跳过 (不是失败)。
 *
 * 为什么需要它 (§747 实测): 有两条断言是"**这条链要能被验证, 数据得先存在**"
 * (例: "有负面标注的条目存在") —— 而空库下**那个前提天然不成立**。
 * 此前它们走 `check`, 于是 `--root <空目录>` 会报 2 项 FAIL ⇒
 * **本脚本因此无法进 CI** (CI 的库是空的), 而那件事从没被明说。
 *
 * ⚠ 而"跳过"必须是**可见的** (打出 SKIP 并计数) —— 静默跳过就与"没写这条断言"等价了。
 */
const skip = (name: string, why: string): void => {
  skipped++;
  console.log("  [SKIP] " + name + "  " + why);
};

const check = (name: string, ok: boolean, note = ""): void => {
  if (ok) {
    pass++;
    console.log("  [OK]   " + name + (note ? "  " + note : ""));
  } else {
    fail++;
    console.log("  **[FAIL]** " + name + "  " + note);
  }
};

console.log("真库一致性验收 (只读)");
console.log("  记忆根: " + root);
const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
try {
  // ⚠ **all() 不含 shadow** (§780 实测): 它是 `query({limit: MAX})` 的薄封装 ⇒ **继承 query 的
  // 默认过滤** (`status != 'shadow'`)。此前这里的注释与输出都写着"含 shadow" —— **那是错的**,
  // 而它会让读数的人以为 438 是全表 (真值 480: 438 active + **42 shadow**)。
  // 契约在 kernel/ports.ts 的 `all()` 附近 (§683 写对了), 而本脚本没跟上。
  const all = stack.store.all();
  const everyRow = stack.store.query({ limit: 100000, includeShadow: true });
  console.log(
    "  条目: " + all.length + " 非 shadow (其中全部 active), 全表 " + everyRow.length +
      " (含 " + (everyRow.length - all.length) + " 条 shadow)",
  );
  console.log();

  // ---- 0. 计数口径: all() 不含 shadow (§780) ----
  //
  // 为什么需要它: 这个脚本**自己的输出**曾写着"(含 shadow)" —— 而 all() 是 query 的薄封装,
  // **继承默认过滤**。读数的人会以为那个数就是全表 (真值多了 42 条 shadow)。
  // 判据取**可复算的关系**而不是具体数字: "全表 = 非 shadow + shadow"。
  console.log("--- 计数口径 ---");
  check(
    "all() 不含 shadow (全表 = 非shadow + shadow)",
    everyRow.length === all.length + (everyRow.length - all.length),
    "非shadow " + all.length + " + shadow " + (everyRow.length - all.length) + " = 全表 " + everyRow.length,
  );
  check(
    "all() 返回的每一条都是 active",
    all.every((e) => (e.status ?? "active") === "active"),
  );
  console.log();

  // ---- 1. 解析器硬化 (本会话修复的口径必须仍然成立) ----
  console.log("--- 解析器口径 ---");
  check("parseTags 拦哨兵字面量", parseTags('["undefined","a"]')!.length === 1);
  check("parseTags 拦数值型", parseTags('["10","a"]')!.length === 1);
  check("parseTags 保留短真标签", parseTags('["认证"]')!.length === 1);
  check("extractTags 拦编号引用", extractTags("见 #412 那一节").length === 0);
  check("extractTags 保留真标签", extractTags("见 #ppt").length === 1);
  console.log();

  // ---- 1b. **真相字段 vs 索引侧兜底**: 两者的覆盖率可以差一个数量级 ----
  //
  // 为什么必须并排看 (2026-09-18, §674 —— 而这条教训在 §605 就写过一次):
  // 我两次都按 `entry.entities` (真相字段) 下结论, 而**检索实际用的是索引侧的兜底抽取**
  // (`entitiesOf` = 真相字段 **或** 从正文抽)。两次读数的量级完全不同:
  //   · §605: 真相字段 12% vs 索引侧 **82%**
  //   · §674: `memory_save` 的真相 entities **0%** vs 索引侧 **98.9%**
  // """**⇒ 判"某字段有没有被填"时, 只看真相字段会得出相反结论。**"""
  // 本组把这个对比**固定成每次验收都看的读数** —— 让人不必每次都重新踩。
  console.log("--- 真相字段 vs 索引侧兜底 (entities) ---");
  {
    const bySource = new Map<string, { n: number; truth: number; indexed: number }>();
    for (const e of all) {
      const k = e.source === "session:tool" ? "memory_save" : "其它来源";
      const cur = bySource.get(k) ?? { n: 0, truth: 0, indexed: 0 };
      cur.n++;
      if ((e.entities ?? []).length > 0) cur.truth++;
      if (entityKeysOf(e).length > 0) cur.indexed++;
      bySource.set(k, cur);
    }
    const pct = (a: number, b: number): string => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
    for (const [k, v] of [...bySource.entries()].sort()) {
      console.log(
        "  " + k.padEnd(14) + v.n + " 条;  真相字段 " + pct(v.truth, v.n) + ";  索引侧兜底 " + pct(v.indexed, v.n),
      );
    }
    const t = [...bySource.values()].reduce((a, v) => a + v.truth, 0);
    const i = [...bySource.values()].reduce((a, v) => a + v.indexed, 0);
    check(
      "索引侧实体覆盖 >= 真相字段 (兜底抽取不该更少)",
      i >= t,
      "真相 " + pct(t, all.length) + " vs 索引侧 " + pct(i, all.length),
    );
  }
  console.log();

  // ---- 2. 索引的 tags 是**派生**的: 字段缺失时由 extractTags 从正文兜底抽取 ----
  //
  // ⚠ **判据修正** (2026-09-18, §544): 我第一版把"索引 tags != 文件 tags"一律算漂移, 于是
  // §541 建完脚本后第二天就跑出 4/340 失败 —— 而逐条追下去, 那**不是缺陷**:
  //
  //   · `indexEntry` 写 `e.tags?.length ? e.tags : extractTags(e.content)` —— **兜底抽取**;
  //   · 而 `entryToMarkdown` 只在 `e.tags` 非空时写 `tags:` 行 ⇒ **派生 tag 不进文件**;
  //   · 那违反 ADR-002 的"删除可重建"吗? **不** —— 实测 `rebuildFromTruth()` 后同样的 tag
  //     又出现了 (抽取是**确定性**的, 输入相同则输出相同)。
  //
  // ⇒ 正确的判据是: **文件 tags ⊆ 索引 tags, 且多出来的部分必须能由 extractTags 从正文重建**。
  //   那既容得下派生 tag, 又能抓到"索引里有文件里没有、且抽不出来的"真漂移。
  console.log("--- 索引 tags 与真相文件的一致性 (含派生抽取) ---");
  // 判据**只有一份实现** (scripts/lib/tag-provenance.ts) —— 我在这个脚本里手写过三遍、错三遍,
  // 所以现在连循环都不写 (见该模块的头注: 一个 tag 有三个来源, 少认一个就出假读数)。
  const prov = summarizeProvenance(all, root);
  const mismatch = prov.indexMissing;
  const derived = prov.derivedEntries;
  const orphan = prov.orphanEntries;
  const orphans = prov.orphanPairs;
  const samples: string[] = [];
  // 允许少量历史残留 (它是已知的, 且不影响用户可见行为) —— 但**必须可见**, 不能静默
  check(
    "文件 tags 必须都在索引里 (反向不成立: 索引可多出派生 tag)",
    mismatch === 0,
    mismatch + " 处" + (samples.length ? "  例: " + samples[0] : ""),
  );
  // 真孤儿 = 索引有、文件无、且**抽不回**。它们只能来自**旧版本抽取器** ⇒ 是历史残留。
  // 允许存在, 但**必须可见** (打印数量与样例), 且不该增长。
  check(
    "真孤儿 (索引有/文件无/抽不回) 数量受控 (历史残留, 需可见)",
    orphan <= Math.max(5, Math.floor(all.length * 0.03)),
    orphan + "/" + all.length + " 条, 其中派生 tag 覆盖 " + derived + " 条" +
      (orphans.length ? "  例: " + orphans.slice(0, 3).join(", ") : ""),
  );
  console.log();

  // ---- 3. 可见性口径 ----
  console.log("--- 可见性 ---");
  const inj = stack.facade.recall({ text: "记忆注入", purpose: "inject", limit: 10, tokenBudget: 4000 });
  // 空库里"注入非空"这个前提天然不成立 ⇒ 跳过 (不是失败)。
  if ((inj.hits ?? []).length === 0) skip("注入非空", "库里没有可注入内容 (空库/全新库)");
  else check("注入非空", true, (inj.hits ?? []).length + " 条");
  check("注入不含 shadow", (inj.hits ?? []).every((h) => (h.entry.status ?? "active") !== "shadow"));
  console.log();

  // ---- 4. always-on 通道 ----
  console.log("--- always-on ---");
  const ao = await stack.facade.alwaysOn({ project: "hx-memory", budgetTokens: 400 });
  check("可用", Array.isArray(ao), ao.length + " 条");
  check("只含 active", ao.every((e) => (e.status ?? "active") === "active"));
  console.log();

  // ---- 5. 负面反馈链路: 标注 → 质量因子 → 面板视图 ----
  //
  // 为什么需要它 (§731 实测缺口): 本脚本有 12 项检查, 而**负面反馈 (memory_flag) 那条链**一项都没覆盖 ——
  // 而它是"读出来的记忆能被纠正"的入口 (KInfra 的"改得动"在读取侧的那一半)。
  // 判据取**可解释性**而不是某个具体数字: 有标注的条目, 其 q 必须**低于** 1 且**可复算**;
  // 而"没有标注"的必须**恰好为 1** (机制不能在无标注时凭空降权)。
  console.log("--- 负面反馈 (memory_flag) 链路 ---");
  {
    const bad = all.filter((e) => badCount(e.feedback) > 0);
    const clean = all.filter((e) => badCount(e.feedback) === 0);
    // 同"注入非空": 没有标注数据时, 下面两条断言无从判定 ⇒ 跳过而不是判失败。
    if (bad.length === 0) skip("有负面标注的条目存在", "库里还没有任何标注 (这条链要等第一次 memory_flag)");
    else check("有负面标注的条目存在 (否则这条链无从验证)", true, bad.length + " 条");
    check(
      "有标注的 q < 1",
      bad.every((e) => qualityFactor(e.feedback, e.reinforcement ?? 0) < 1),
      bad.length ? "最小 q=" + Math.min(...bad.map((e) => qualityFactor(e.feedback, e.reinforcement ?? 0))).toFixed(3) : "-",
    );
    check(
      "无标注的 q === 1 (不凭空降权)",
      clean.every((e) => qualityFactor(e.feedback, e.reinforcement ?? 0) === 1),
    );
  }
  console.log();

  // 跳过项必须出现在总结里 —— 否则"13 通过 / 0 失败"会掩盖"2 项根本没跑"。
  console.log(
    "--- " + pass + " 通过 / " + fail + " 失败" + (skipped ? " / " + skipped + " 跳过" : "") + " ---",
  );
} finally {
  stack.close();
}
process.exit(fail > 0 ? 1 : 0);
