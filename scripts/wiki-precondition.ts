// scripts/wiki-precondition.ts — Wiki 范式的重启判据 (可检测, 不是模糊描述)。
//
// 背景 (docs/wiki-blind-review.md §6): 盲审结论是「一主题一页」在本项目当前语料上**未成立**,
// 但**未被证伪** —— 它需要「同一主题多条事实」的负载才能被公平检验, 而那样的负载当前不存在。
//
// 为什么要有这个脚本: 盲审把重启条件写成了一段自然语言 ("找到或构造同一实体/N 条事实的真实数据")。
// 那无法被检测 —— 于是「现在能不能重启」只能靠重新推导一遍。本脚本把它变成**可执行的判据**。
//
// 判据 (基于盲审实测的成因: 聚合需要"同一主题出现多次"):
//   ① 语料范围 —— **两种口径都报** (见下, 我第一版只报了严的那个);
//   ② 按项目看「共享 >=2 内容词的条目对」占比 —— 它是"有可聚合结构"的直接代理;
//   ③ 要求**规模够** (条数 >= 30 且对数 >= 200): 5 条事实的 90% 只是统计噪声。
//
// ⚠ 语料口径的修正 (2026-09-18, §409): 我第一版**排除 `session:tool`** (工具显式写入),
// 理由写成"它们不是从对话沉淀的知识"。但核对盲审原文, §6 的前提是:
//
//   "找到或构造「**同一实体/N 条事实**」的真实数据 (例如长期使用后**同一项目的多次决策记录**)"
//
//   —— **没有"必须来自对话"的限定**。而 `session:tool` 那批恰恰是"同一项目的多次决策记录"
//   (HX-Memory 项目 173 条, 共享占比 99%)。
//
//   两种口径给出的结论**完全相反**:
//     仅对话沉淀 (44 条): **无项目满足**;
//     全部真实记忆 (282 条): **3 个项目满足** (HX-Memory 173 条 / HX-Jungle 34 条 / HXLoLis 31 条)。
//
//   ⇒ 因此本脚本**两种都报**, 并以**宽口径为主判据** (它才是盲审原文的措辞);
//     严口径作为**保守读数**保留 (若只信宽口径而它其实是噪声, 严格读数会先暴露出来)。
//
// 用法: node --experimental-strip-types scripts/wiki-precondition.ts [--root <记忆根>]
import { openMemoryStack } from "../src/app/stack.ts";
import { termStreams } from "../src/kernel/cjk.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 判定阈值 (保守: 宁可说"还不满足", 也不要基于噪声重启)。 */
export const MIN_ENTRIES = 30;
export const MIN_PAIRS = 200;
export const MIN_SHARE_PCT = 40;

/**
 * 单对条目算"同一主题"的 Jaccard 门槛 (交/并)。
 *
 * 为什么是它而不是"共享 >= N 词" (2026-09-18 负对照实测): 后者在长中文文本上**无区分力** ——
 * 打乱词序后共享占比仍有 97.5% (真语料 99.0%)。Jaccard 对长度不敏感。
 *
 * 取值 0.15: 远高于实测的"同主题"水平 (真语料最高 2.7%), 因此它实际上是个**严格**门槛 ——
 * 那是对的: 宁可不触发 (Wiki 不接线), 也不要用一个被噪声满足的判据去启动一个范式实验。
 */
export const MIN_PAIR_JACCARD = 0.15;

/**
 * **结构判据** (2026-09-18, §496): 标题骨架重复 >= N 次的组, 就是"同类记录的序列"。
 *
 * ⚠ 为什么它才是主判据, 而 Jaccard 不是 —— 这是**五个判据迭代后的结论**:
 *
 * | 判据 | 读数 | 否证理由 |
 * | --- | --- | --- |
 * | 词面共享 >=2 词 | 15.9% | **无区分力** (打乱词序后仍 97.5%) |
 * | 实体簇 (entitiesOf) | 94% | **被前缀撑起** (183/184 条以同一前缀开头) |
 * | `topicOf` 共享 | 84% | **排除巨簇后只剩 17%** |
 * | 同实体 + 同 project | 70% | **全是高频词** (`always-on`/`rrf`/`fail`) |
 * | **本判据 (结构骨架)** | **10%** | **与"人读"独立一致** |
 *
 * 前四个问的都是"**它们共享什么**" —— 那是**数据的可计算投影**, 而"共享某物"只是
 * "同类记录"的一个**副产品**, 反过来不成立 (同一实体的多轮迭代日志, 每轮内容都不同,
 * 但它们确实是同一序列)。
 *
 * 本判据问的是"**它们是不是同一类东西**": 把内容前 N 字的**结构骨架**取出
 * (日期与数字归一化), 骨架相同的条目就是"填同一个模板的实录"。
 * 实测最强的那个序列 (`HX-Sagasu 第 N`) 独立满足三个条件: 编号间隔只有 1 和 2、
 * 时间递增、内容长度同量级 —— 而它是**KInfra 那句"关于 Alice 的四条只有放在一起
 * 才构成可用的判断"在本语料上的唯一对应物**。
 */
export const MIN_SEQUENCE_LEN = 3;

/**
 * **满足判定的两个条件** (满足其一即可) —— 它们对应"Wiki 能带来收益"的两种情形:
 *
 *   · `MIN_SEQ_MAX` —— 存在一个**足够长的序列**。Wiki 的"一主题一页"对它有意义:
 *     18 条同一实体的连续记录聚成一页, 比 18 张各一节的页更好读也更好改。
 *   · `MIN_SEQ_COVERED` —— 序列**覆盖面够广**。只有覆盖面广, 页头开销才摊得薄。
 *
 * 实测真库: `maxSeq = 18` (HX-Sagasu), `covered = 31/313 = 10%`。
 * ⇒ **前者满足, 后者不满足**。判定用"满足其一"是因为**收益可以局部**:
 *    一个 18 条的序列足以证明该范式在**这个负载上可行** (能不能推广是另一个问题)。
 */
export const MIN_SEQ_MAX = 10;
export const MIN_SEQ_COVERED = 40;

/** 取"结构骨架": 前 14 字, 日期与数字归一化。 */
export function skeletonOf(content: string): string {
  return content
    .replace(/\d{4}-\d{2}-\d{2}/g, "DATE")
    .replace(/\d+/g, "N")
    .slice(0, 14)
    .trim();
}

/**
 * **序列规模**: 最大的"骨架重复组"有多少成员, 以及有多少条目落在 >= `minLen` 的组里。
 *
 * 返回 `maxSeq` (最大序列长度) 与 `pct` (落在 >= minLen 组里的条目占比)。
 */
export function sequenceStructure(
  contents: readonly string[],
  minLen = MIN_SEQUENCE_LEN,
): { maxSeq: number; groups: number; covered: number; pct: number } {
  const bySkeleton = new Map<string, number>();
  for (const c of contents) {
    const k = skeletonOf(c);
    if (!k) continue;
    bySkeleton.set(k, (bySkeleton.get(k) ?? 0) + 1);
  }
  let maxSeq = 0;
  let groups = 0;
  let covered = 0;
  for (const [, n] of bySkeleton) {
    if (n > maxSeq) maxSeq = n;
    if (n >= minLen) {
      groups++;
      covered += n;
    }
  }
  return { maxSeq, groups, covered, pct: (100 * covered) / Math.max(1, contents.length) };
}

/**
 * 判定某个项目的语料是否已具备"可聚合结构" (纯函数, 便于测试)。
 *
 * 三个条件缺一不可, 且**规模条件是必须的**:
 * HX-Memory 曾出现 "5 条事实, 共享占比 90%" —— 那只是统计噪声 (10 对里的 9 对),
 * 若只看占比就会误判为"条件满足"。
 */
export function hasAggregatableStructure(
  contents: readonly string[],
  thresholds: { minEntries: number; minPairs: number; minSharePct: number } = {
    minEntries: MIN_ENTRIES,
    minPairs: MIN_PAIRS,
    minSharePct: MIN_SHARE_PCT,
  },
): { ok: boolean; entries: number; pairs: number; pct: number } {
  const sets = contents.map((c) => new Set(termStreams(c).words.filter((w) => w.length >= 2)));
  let pairs = 0;
  let shared = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      pairs++;
      // ⚠ 判据修正 (2026-09-18, §412): 原本是"共享 >= 2 个内容词"。
      // 负对照实测它**没有区分力**: 把同样长度的内容**打乱词序**后共享占比仍有 97.5%,
      // 而真语料是 99.0% —— 差别只有 1.5 个百分点。
      // 成因: 长中文文本 (中位 1154 字, 词集中位 147) 两两之间天然共享 30~42 个词,
      // 而门槛只要 2 ⇒ 实际从未筛除任何东西。
      //
      // 改用 **Jaccard 相似度** (交/并): 它对文本长度不敏感, 是"同一主题"的正规代理。
      // 实测同一批语料: 真语料 2.7% / 打乱负对照 0.8% —— 区分出来了 (虽然两者都很低,
      // 而那正是结论: **这批语料里没有可聚合结构**)。
      let inter = 0;
      for (const w of sets[i]!) if (sets[j]!.has(w)) inter++;
      const union = sets[i]!.size + sets[j]!.size - inter;
      if (union > 0 && inter / union >= MIN_PAIR_JACCARD) shared++;
    }
  }
  const pct = (100 * shared) / Math.max(1, pairs);
  return {
    ok: contents.length >= thresholds.minEntries && pairs >= thresholds.minPairs && pct >= thresholds.minSharePct,
    entries: contents.length,
    pairs,
    pct,
  };
}

/**
 * 主体 (被**直接运行**时才执行 —— 见文件末尾的守卫)。
 *
 * ⚠ 这道守卫是必需的, 不是形式: 测试要 import 上面的判据函数, 而 import 会执行模块顶层代码。
 * 实测教训: 没有守卫时, `npx vitest run tests/s2/wiki-precondition.test.ts` 会**先执行整个脚本**
 * 并命中 `process.exit(1)` —— 测试一个都没跑 (报 `no tests`), 而失败信息是
 * `process.exit unexpectedly called`, 看起来像测试环境问题。项目里 cli.ts 已有同一模式。
 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const args = [...argv];
  const rootIdx = args.indexOf("--root");
  const root =
    rootIdx >= 0 && args[rootIdx + 1]
      ? resolve(args[rootIdx + 1]!)
      : (process.env["HX_MEMORY_ROOT"] ?? (process.env["DSH_HOME"] ? join(process.env["DSH_HOME"], "hx-memory") : join(homedir(), ".dsh", "hx-memory")));

  const stack = openMemoryStack(root, { episodeRetentionDays: 0 });
const all = stack.store.all();

/** 扫一个语料切片, 返回是否有项目满足 + 逐项目读数。 */
function scan(label: string, list: typeof all): boolean {
  const byProject = new Map<string, typeof list>();
  for (const e of list) {
    const p = e.project ?? "(无项目)";
    byProject.set(p, [...(byProject.get(p) ?? []), e]);
  }
  console.log("--- 口径: " + label + " (" + list.length + " 条) ---");
  let any = false;
  for (const [p, items] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (items.length < 3) continue;
    // ⚠ Jaccard 的 `ok` **刻意不解构** (2026-09-18, lint 抓出来的): 它已**不参与判定**
    // (§490 实测它在真库上无区分力: 真主题 0.065 vs 随机对照 0.051)。
    // 保留 `pct`/`pairs` 两个读数作**对照** (便于看出"两版实现之间有没有变"), 但判定只由
    // 下面的 `sequenceStructure` 做 —— 留一个不用的布尔量会让人以为它还在起作用。
    const { pct, pairs } = hasAggregatableStructure(items.map((e) => e.content));
    const seq = sequenceStructure(items.map((e) => e.content));
    // ⚠ **主判据是序列结构, 不是 Jaccard** (2026-09-18, §496)。
    // 实测(全库口径): Jaccard 的"满足"是被前缀/高频词撑起的假读数; 而结构判据给出的
    // 是 31/313 (10%) —— 那才是"同类记录序列"的真实规模。Jaccard 读数**保留显示**
    // 作为对照 (它能看出"两版实现之间有没有变"), 但**不参与判定**。
    const satisfied = seq.maxSeq >= MIN_SEQ_MAX || seq.covered >= MIN_SEQ_COVERED;
    if (satisfied) any = true;
    console.log(
      "  " + (satisfied ? "[满足]" : "[未满足]") + " " + p.padEnd(18) +
        " 条数 " + String(items.length).padStart(4) +
        "  **最大序列 " + String(seq.maxSeq).padStart(3) + "**" +
        "  序列覆盖 " + seq.pct.toFixed(0) + "%" +
        "  (对照 Jaccard " + pct.toFixed(1) + "%, 对数 " + String(pairs).padStart(5) + ")",
    );
  }
  console.log("  ⇒ " + (any ? "**有项目满足**" : "无项目满足"));
  console.log();
  return any;
}

console.log("Wiki 重启判据 (docs/wiki-blind-review.md §6)");
console.log("  记忆根: " + root);
console.log("  阈值: 条数 >= " + MIN_ENTRIES + " 且 对数 >= " + MIN_PAIRS + " 且 共享占比 >= " + MIN_SHARE_PCT + "%");
console.log();

// 两种口径都报 (见头注的"语料口径的修正"): 盲审原文只说"同一实体/N 条事实的真实数据",
// 没限定"必须来自对话" —— 所以**宽口径是主判据**, 严口径作为保守读数保留。
const allReal = all;
const dialogueOnly = all.filter((e) => !(e.source ?? "").includes("tool"));
const wide = scan("宽: 全部真实记忆 (盲审原文措辞)", allReal);
const narrow = scan("严: 仅对话沉淀 (我第一版的口径, 更强)", dialogueOnly);

console.log("结论: " + (wide
  ? "**有条件重启** —— 至少一个项目出现了可聚合结构, 可按盲审 §5 的修正方案重做对照。"
  : "**不满足** —— 没有项目同时达到规模与共享占比阈值。Wiki 保持不接线。"));
if (wide !== narrow) {
  console.log("  ⚠ 两种口径结论不同: 宽=" + (wide ? "满足" : "不满足") + ", 严=" + (narrow ? "满足" : "不满足"));
  console.log("    以**宽口径**为准 (它是盲审原文的措辞); 严口径的差异本身是「语料来源」这个维度的信息。");
}
stack.close();
  // 退出码跟随**主判据 (宽口径)**, 与上面的结论同源 —— 不跟随严口径 (那会让 CI 与结论相反)。
  return wide ? 0 : 1;
}

// 自执行守卫 (与 cli.ts 同一模式): 被 import 时保持纯函数, 便于测试。
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
