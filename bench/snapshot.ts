// bench/snapshot.ts — 指标快照: 把关键评测数字固化成文件, 由 CI 比对防漂移。
//
// 为什么需要它: docs/memory-benchmark-report.md 里的表格是**手抄**的。检索逻辑一改,
// 报告不会自动更新 —— 数字会静默过期, 而"过期但看起来权威"比没有报告更糟。
// 本脚本把关键指标写成 JSON 快照; verify-bench-snapshot 比对当前实现与快照的偏差,
// 超阈值就失败, 强迫"改行为"与"改报告"在同一提交里发生 (与 verify-docs 同一思路)。
//
// 用法:
//   node --experimental-strip-types bench/snapshot.ts --write    # 写快照
//   node --experimental-strip-types bench/snapshot.ts --check    # 比对 (CI)
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../src/app/stack.ts";
import { LexicalEmbedder } from "../src/retrieval/embedding-lexical.ts";
// 词集口径走 kernel/cjk 的权威实现 —— 分层判据不在这里另写一份分词 (§608)。
import { tokenSet } from "../src/kernel/cjk.ts";
import type { Corpus } from "./lib/corpus.ts";

const HERE = import.meta.dirname;
const SNAPSHOT = join(HERE, "snapshot.json");
const CORPUS = join(".tmp", "bench", "corpus.json");
const CASES = join(".tmp", "bench", "cases.json");
const K = 10;
/** 允许的偏差: 指标是浮点且依赖分词/排序细节, 留一点余量; 超过说明行为变了。 */
const TOLERANCE = 0.005;

interface CaseFile {
  cases: Array<{ id: string; type: string; query: string; expect: string[] }>;
}

function recallAt(ranked: string[], gold: Set<string>, k: number): number {
  return gold.size ? ranked.slice(0, k).filter((x) => gold.has(x)).length / gold.size : 0;
}

/**
 * 语料的内容指纹 (不含 exportedAt / source.root 这类每次导出都会变的元数据)。
 *
 * 为什么要它: 快照的指标同时受**代码**与**输入语料**影响, 而语料在 gitignore 里 ——
 * 它是本机真实记忆的导出, 会随使用而变化。没有指纹时, 两种情况都只能报"指标漂移",
 * 而它们的处置完全相反: 语料变了要重新导出快照, 代码变了要解释清楚改了什么。
 */
function corpusFingerprint(corpus: Corpus): string {
  // 只取参与检索的字段, 且排序固定 (导出顺序不该影响身份)。
  const canonical = corpus.entries
    .map((e) => [e.id, e.content, e.kind, e.scope, e.project ?? "", e.entities.join(","), e.relations.map((r) => r.type + ">" + r.to + ":" + r.weight).join(",")].join("\u0000"))
    .sort()
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** 只保留**与远端系统无关**的臂: 本仓库的确定性变体 (不依赖 LLM/嵌入服务), CI 才能跑。 */
function measure(corpus: Corpus, cases: CaseFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, embedder] of [
    ["A 纯词面", null],
    ["B 哈希近似语义", new LexicalEmbedder()],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "hxmem-snap-"));
    const stack = openMemoryStack(root, {
      episodeRetentionDays: 0,
      ...(embedder ? { embedder } : { embedder: null }),
    });
    for (const e of corpus.entries) {
      stack.store.add({
        id: e.id, kind: e.kind as never, content: e.content, source: e.sourceRef,
        scope: e.scope as never, ...(e.project ? { project: e.project } : {}),
        ...(e.tags.length ? { tags: e.tags } : {}),
        ...(e.entities.length ? { entities: e.entities } : {}),
        ...(e.relations.length
          ? { relations: e.relations.map((r) => ({ type: r.type as never, toId: r.to, weight: r.weight })) }
          : {}),
        ...(e.confirmedBy
          ? { confirmedBy: e.confirmedBy, ...(e.confirmedAt ? { confirmedAt: e.confirmedAt } : {}) }
          : {}),
        ts: { validAt: e.validAt, assertedAt: e.assertedAt },
      });
    }
    let r1 = 0, r10 = 0, h10 = 0, n = 0;
    /** 分层计数: 碎片探针 (f*) 与自然提问 (n*)。见下面的说明。 */
    let fr1 = 0, fr10 = 0, fn = 0, nr1 = 0, nr10 = 0, nn = 0;
    /**
     * **第二个分层维度: 词面可解 vs 需语义**。
     *
     * 为什么需要它 (2026-09-18, §608 —— 补 `docs/eval-audit.md` 待办 2):
     * 那个维度**当时做过实验** (该文档 §7 的分层归因: 词面可解层召回 0.486 / 需语义层 **0.100**),
     * 但那是**一次性脚本** (`.tmp/bench/layer-attrib.ts`, 不入版本库) —— 于是它**不进任何常规报告**,
     * 后续改动会不会伤到"需语义层"**无人盯**。
     *
     * 判据: 查询与**任一 gold 条目**的正文有共同词 ⇒ 词面可解; 一条都没有 ⇒ 需语义。
     * (用 `tokenSet` 的权威口径, 不在这里另写分词。)
     *
     * ⚠ **必须叠 `fragment` 维度** (§611 实测): 直接按"有无共同词"分时, "需语义"那
     * 36 条里 **34 条是代码碎片** (形如 `ng_model_id),` / `nManager` —— 后者是
     * `SessionManager` 被截断, 于是它与 gold 没有**完整词**交集)。
     * 只看自然提问 (426 条): **词面可解 424 / 需语义 2**。
     * **⇒ "需语义"这一层在自然提问上几乎不存在 (0.5%)** —— 不加 fragment 维度会把
     * "碎片没有共同词"误读成"语义层表现差"。
     */
    const goldText = new Map<string, string>();
    /** "需语义"层的**最小可信样本量** —— 低于它就不报 (见下面的说明)。 */
    const MIN_LITERAL_UNSOLVABLE_N = 20;
    for (const e of corpus.entries) goldText.set(e.id, e.content);
    let sr1 = 0, sr10 = 0, sn = 0, mr1 = 0, mr10 = 0, mn = 0;
    // 弃权: 库外问题 (expect 为空) 必须返回**空**, 而不是"最像的 10 条"。
    //
    // 为什么必须进快照 (2026-09-17 实测): 这个指标此前**完全没被测量** —— 上面的循环
    // 用 `if (!c.expect.length) continue` 把弃权 case 直接跳过了, 于是"检索器永远能返回
    // 10 条"这件事没有任何数字盯着。实测修复前 5 条弃权 case **全部返回 10 条** (0/5),
    // 而工具描述里写着"没返回东西说明确实没有记录" —— 那句话在旧实现下永远不成立。
    // 弃权不是"召回率的一个角落", 它是"模型能不能知道自己不知道"的开关。
    let abstained = 0, abstentionN = 0;
    for (const c of cases.cases) {
      if (!c.expect.length) {
        // ⚠ 失效样本不计入 (2026-09-18, §424): 见 Case.exclude 的说明 ——
        // 库增长后某些"库外主题"变成了库内主题, 那种样本"不弃权"才是**正确**的。
        // 旧版照样把它们算进弃权率 ⇒ 指标被系统性低估。
        if (c.exclude) continue;
        abstentionN++;
        const res = stack.retriever.retrieveSync({
          text: c.query, limit: K, tokenBudget: 1_000_000, purpose: "recall",
          ...(embedder ? {} : { channels: { vector: { enabled: false } } }),
        });
        if (!res.hits.length) abstained++;
        continue;
      }
      const gold = new Set(c.expect);
      const res = stack.retriever.retrieveSync({
        text: c.query, limit: K, tokenBudget: 1_000_000, purpose: "recall",
        ...(embedder ? {} : { channels: { vector: { enabled: false } } }),
      });
      const ids = res.hits.map((h) => h.entry.id);
      r1 += recallAt(ids, gold, 1);
      r10 += recallAt(ids, gold, K);
      if (ids.slice(0, K).some((x) => gold.has(x))) h10++;
      n++;
      // ⚠ 分层: **代码碎片探针**与**自然提问**必须分开报 (2026-09-18, §448)。
      //
      // 为什么: 实测 872 条正样本里 **448 条 (51%)** 的 query 是从条目里截取的代码碎片
      // (形如 `ng_model_id),`)。它们对"字面探针"这个用途有效, 但**不代表真实负载** ——
      // 实测碎片上 R@10 = 0.8951 而非碎片上 = **0.9693**, 总体指标被拉低 6 个百分点。
      // 只看总体会把"真实提问上的表现"**系统性低估**。
      if (c.fragment) { fr1 += recallAt(ids, gold, 1); fr10 += recallAt(ids, gold, K); fn++; }
      else { nr1 += recallAt(ids, gold, 1); nr10 += recallAt(ids, gold, K); nn++; }
      // 第二个分层维度: 词面可解 vs 需语义 —— **只对自然提问统计** (§611)。
      // 碎片必须排除: 它们是**被截断的代码片段**, 与 gold 天然没有完整词交集, 而那不代表"需语义"。
      const qTokens = tokenSet(c.query);
      let literalSolvable = false;
      for (const gid of c.expect) {
        const body = goldText.get(gid);
        if (body === undefined) continue;
        for (const t of tokenSet(body)) {
          if (qTokens.has(t)) { literalSolvable = true; break; }
        }
        if (literalSolvable) break;
      }
      const a1 = recallAt(ids, gold, 1);
      const a10 = recallAt(ids, gold, K);
      if (!c.fragment) {
        if (literalSolvable) { sr1 += a1; sr10 += a10; sn++; }
        else { mr1 += a1; mr10 += a10; mn++; }
      }
    }
    out[label + " R@1"] = Number((r1 / n).toFixed(4));
    out[label + " R@10"] = Number((r10 / n).toFixed(4));
    // 分层读数 (碎片 / 自然提问) —— 那才是"真实负载"的读数
    if (fn) out[label + " [碎片] R@10"] = Number((fr10 / fn).toFixed(4));
    if (nn) out[label + " [自然提问] R@1"] = Number((nr1 / nn).toFixed(4));
    if (nn) out[label + " [自然提问] R@10"] = Number((nr10 / nn).toFixed(4));
    // 第二个分层维度 (词面可解 / 需语义) —— 见上面 goldText 的说明。
    if (sn) out[label + " [词面可解] R@1"] = Number((sr1 / sn).toFixed(4));
    // ⚠ 只报**样本量够**的层: 实测自然提问里"需语义"只有 **2 条** (§611) ——
    // 那个 R@1 会恒为 0 而**没有统计意义** (n=2 上"0/2"与"1/2"的差别全是噪声)。
    // 报一个 n=2 的指标进 CI 快照 = 给未来留一个"动一下它就红"的假警报。
    // 而层本身**不是不存在** —— 它有 2 条, 那两句查询确实与 gold 无任何共同词。
    // 只是**样本量不足以支撑一个被 CI 守住的数字**。
    if (mn >= MIN_LITERAL_UNSOLVABLE_N) {
      out[label + " [需语义] R@1"] = Number((mr1 / mn).toFixed(4));
      out[label + " [需语义] R@10"] = Number((mr10 / mn).toFixed(4));
    }
    out[label + " H@10"] = Number((h10 / n).toFixed(4));
    out[label + " 弃权率"] = abstentionN ? Number((abstained / abstentionN).toFixed(4)) : 0;
    stack.close();
    rmSync(root, { recursive: true, force: true });
  }
  // 结构完整性: 这些不依赖服务, 也应由 CI 守住
  out["语料条目数"] = corpus.entries.length;
  out["关系边总数"] = corpus.entries.reduce((s, e) => s + e.relations.length, 0);
  out["有 entities 的条目"] = corpus.entries.filter((e) => e.entities.length).length;
  return out;
}

function main(): number {
  // 语料来自真实记忆库, 含私人内容, 永不入库 (在 gitignore 的 .tmp/ 下)。
  // 因此在没有它的环境 (CI / 新克隆) 必须**明确跳过而不是假装通过** ——
  // 这条 gate 的适用范围只写进 Agent Note, 不靠"大家记得"。
  if (!existsSync(CORPUS) || !existsSync(CASES)) {
    console.log("bench-snapshot: 跳过 (缺 " + CORPUS + " —— 该语料含真实记忆, 不入库)。");
    console.log("  本地首次使用: node --experimental-strip-types bench/lib/corpus.ts");
    return 0;
  }
  const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as Corpus;
  // 快照断言的是**某一份语料上**的指标, 所以必须先判"是不是同一份语料" —— 否则漂移
  // 红得没有解释力: 实测把 HEAD 与它的父提交各跑一次, 数字一模一样 (都是 0.635),
  // 而快照里记的是 0.6411。缺了这一步, 人只能靠猜"是代码变了还是语料变了"。
  const fingerprint = corpusFingerprint(corpus);
  if (!existsSync(SNAPSHOT)) {
    console.error("bench-snapshot: 缺少快照文件 " + SNAPSHOT);
    return 1;
  }
  const cases = JSON.parse(readFileSync(CASES, "utf8")) as CaseFile;
  const now = measure(corpus, cases);

  if (process.argv.includes("--write")) {
    const snapshot = { k: K, tolerance: TOLERANCE, corpus: fingerprint, metrics: now };
    writeFileSync(SNAPSHOT, JSON.stringify(snapshot, null, 2) + "\n");
    console.log("快照已写入: " + SNAPSHOT + " (语料指纹 " + fingerprint + ")");
    for (const [k, v] of Object.entries(now)) console.log("  " + k.padEnd(26) + v);
    return 0;
  }

  const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    metrics: Record<string, number>;
    tolerance?: number;
    corpus?: string;
  };
  // 语料身份对不上 → 这不是"实现漂移", 是"输入换了"。两者处置相反, 必须分开报:
  // 混在一起说"指标漂移", 人就只能猜到累了为止 (实测这个 gate 从诞生起就一直这么红)。
  if (saved.corpus !== undefined && saved.corpus !== fingerprint) {
    console.error("bench-snapshot: 语料已变 (快照记的是 " + saved.corpus + ", 当前是 " + fingerprint + ")。");
    console.error("  指标差异可能全部来自输入而不是实现。要在这份语料上继续用, 重新导出快照:");
    console.error("    node --experimental-strip-types bench/snapshot.ts --write");
    console.error("  若确实实现了行为变更, 同一次提交里也要同步 docs/memory-benchmark-report.md 的表格。");
    return 1;
  }
  const tol = saved.tolerance ?? TOLERANCE;
  const drift: string[] = [];
  for (const [key, was] of Object.entries(saved.metrics)) {
    const is = now[key];
    if (is === undefined) { drift.push(key + ": 快照有但当前指标缺失"); continue; }
    if (Math.abs(is - was) > tol) drift.push(key + ": " + was + " → " + is);
  }
  if (drift.length) {
    console.error("bench-snapshot: 指标漂移超过 " + tol + ":");
    for (const d of drift) console.error("  " + d);
    console.error("");
    console.error("若这是**有意**的行为变更: 在同一次提交里跑");
    console.error("  node --experimental-strip-types bench/snapshot.ts --write");
    console.error("并同步更新 docs/memory-benchmark-report.md 的表格。");
    return 1;
  }
  console.log("bench-snapshot: " + Object.keys(saved.metrics).length + " 项指标与快照一致 (容差 " + tol + ")");
  return 0;
}

process.exitCode = main();
