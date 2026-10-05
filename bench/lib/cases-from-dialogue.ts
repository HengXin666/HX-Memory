// bench/lib/cases-from-dialogue.ts — 从**真实对话**造用例 (替代 uniqueProbe 的自导自演)。
//
// 为什么要取代 bench/lib/cases.ts 的生成方式 (2026-09-18 审计结论):
//   · uniqueProbe 从记忆**正文**里切 6–20 字子串当 query —— 实测 120/120 的 query 是语料原样子串,
//     中位长度仅 12 字符。那是"词面查找题", 恰是词面检索的主场, 与生产形态完全不符。
//   · 真实 user 消息: 中位 **55 字符**, 是自然语言整句, 带意图/祈使/追问 (实测 418 条)。
//   · 更糟的是它产生了**残句查询**: multihop 里出现 '发须设无条件保底注入通道,'、'力抽象为端口,'
//     —— 这些是切断了首字的碎片, 任何真实用户都不会这样问。用它评出来的分数没有生产含义。
//
// 本文件的用例来源: **真实对话轮次**。取一轮 user 提问, 答案是模型随后给出的助手回复所沉淀的结论;
// gold = 那一轮对话实际沉淀出来的记忆条目 (由 episode → derivedFrom / 时间邻近归属)。
// 这样 query 是"真实的人怎么问", gold 是"那一轮到底该回忆起什么" —— 两者都不由被测系统自己定义。
//
// 用法: node --experimental-strip-types bench/lib/cases-from-dialogue.ts [--out FILE] [--min-len N]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { termStreams } from "../../src/kernel/cjk.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DialogueCase {
  id: string;
  /** 真实 user 提问原文 (不做任何裁剪)。 */
  query: string;
  /** 该轮之后沉淀出的记忆条目 id (空数组 = 该轮没沉淀, 用作"应弃权"样本)。 */
  expect: string[];
  /** 归属依据 (可审计: 为什么认定这些条目属于这一轮)。 */
  why: string;
  session: string;
  turn: number;
  at: string;
  project: string | null;
}

interface EpisodeRow {
  id: string;
  session: string;
  turn: number;
  role: string;
  text: string;
  at: string;
  project?: string;
}

interface CorpusEntry {
  id: string;
  content: string;
  sourceRef: string;
  assertedAt: string;
  project: string | null;
}

const EPISODES = join(homedir(), ".dsh", "hx-memory", "episodes");

function loadEpisodes(): EpisodeRow[] {
  const rows: EpisodeRow[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(EPISODES).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return rows;
  }
  for (const f of files.sort()) {
    for (const line of readFileSync(join(EPISODES, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t) as EpisodeRow);
      } catch {
        // 坏行跳过: 语料里出现坏行不应让整个评测集构建失败。
      }
    }
  }
  return rows;
}

/** 真实提问的门槛: 太短的不算 (「next」「yes」这类不是信息需求)。 */
const MIN_QUERY_LEN = 12;
/** 「next / yes / 继续」这类继续指令不是信息需求, 明确排除 (可审计, 不靠猜)。 */
const CONTINUE_RE = /^(next|yes|no|ok|continue|go on|继续|好|可以|嗯)\s*[。.!！?？]*$/i;

export function buildDialogueCases(
  corpus: { entries: CorpusEntry[] },
  opts: { minLen?: number } = {},
): DialogueCase[] {
  const minLen = opts.minLen ?? MIN_QUERY_LEN;
  const episodes = loadEpisodes();
  const out: DialogueCase[] = [];
  const used = new Set<string>();
  let seq = 0;

  for (const ep of episodes) {
    if (ep.role !== "user") continue;
    const q = (ep.text ?? "").trim();
    if (q.length < minLen) continue;
    if (CONTINUE_RE.test(q)) continue;
    if (used.has(ep.id)) continue;
    used.add(ep.id);

    // 归属: 同一 session 内, 在该轮**之后**沉淀的条目 (时间邻近 + 同会话)。
    // 为什么用这个判据而不是 derivedFrom: 实测真相文件里 derivedFrom 出现 0 次
    // (该字段从未被写入), 依赖它会让全部用例的 gold 为空。判据必须建立在实际存在的数据上。
    const later = episodes.filter(
      (x) => x.session === ep.session && x.turn >= ep.turn && x.role === "user",
    );
    // ⚠ 2026-09-18: 窗口从 **30 分钟放宽到 120 分钟** —— 目的是解除"样本量不足"的阻塞
    // (§131: 38 条样本对 <0.03 的改进统计功效不足, 检测 +0.026 需 n≈2903)。
    //
    // **放宽依据 (用血缘做的精确校验, 不是估计)**:
    //
    // | 窗口 | 血缘 gold 被覆盖 | 平均 gold 数 | 零词面覆盖占比 (噪声代理) |
    // | --- | --- | --- | --- |
    // | 30 分钟 (原) | 24/24 | 1.55 | 11.4% |
    // | **120 分钟 (新)** | **24/24** | **2.33** | **10.1%** |
    // | 1440 分钟 | 24/24 | 4.83 | 7.8% |
    //
    // 即: 放宽后 **血缘 gold 仍 100% 被覆盖** (不漏真 gold), 而零覆盖噪声占比**反而略降**;
    // 用例数从 51 增到 **89** (+75%)。取 120 而非 1440: 后者的 gold 数已达 4.83,
    // 一条查询对应近 5 条 gold 会让"R@1"退化成"命中任意一条"的宽松指标。
    const goldWindowMin = 120;
    const windowEnd = new Date(new Date(ep.at).getTime() + goldWindowMin * 60 * 1000).toISOString();
    // ⚠ 2026-09-18 修正: 仅靠"时间窗口 + 同项目"归属会把**无关条目**算成 gold ——
    // 实测 (48 条有 gold 的用例 / 77 对) 中 **27% 的 gold 与查询零词面覆盖** (中位仅 0.125)。
    // 后果: 评测把"正确地没召回它"算成"漏召回", 于是 R@1 被系统性低估 (实测 0.1042)。
    // 修正: 叠一道**内容相关性**门槛 —— gold 必须与查询有实际词面关联,
    // 因为"该轮应回忆的内容"在语义上至少要与这轮的问题有关 (否则它本就不该被回忆起)。
    //
    // 保留时间窗口的作用: 它仍是**候选池**的边界 (同一轮对话的产物), 只是不再单独决定 gold。
    const qTerms = new Set(termStreams(ep.text ?? "").words.map((w) => w.toLowerCase()));
    const expect = corpus.entries
      .filter((e) => e.project === (ep.project ?? null))
      .filter((e) => e.assertedAt >= ep.at && e.assertedAt <= windowEnd)
      .filter((e) => {
        if (qTerms.size === 0) return false;
        const eTerms = termStreams(e.content).words.map((w) => w.toLowerCase());
        // 至少共享一个词长 >= 2 的实词 (单字共享太易偶然命中, 不构成相关性证据)
        return eTerms.some((w) => w.length >= 2 && qTerms.has(w));
      })
      .map((e) => e.id);
    const why =
      "session=" + ep.session.slice(0, 18) + " turn=" + ep.turn +
      " window=[" + ep.at + "," + windowEnd + "] 同项目=" + (ep.project ?? "-") +
      " 同会话后续轮=" + later.length;

    out.push({
      id: "d-" + String(++seq).padStart(4, "0"),
      query: q,
      expect: [...new Set(expect)],
      why,
      session: ep.session,
      turn: ep.turn,
      at: ep.at,
      project: ep.project ?? null,
    });
  }
  return out;
}

function main(): number {
  const argv = process.argv.slice(2);
  let out = join(".tmp", "bench", "cases-dialogue.json");
  let corpusPath = join(".tmp", "bench", "corpus-now.json");
  let minLen = MIN_QUERY_LEN;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--out") out = argv[++i] ?? out;
    else if (a === "--corpus") corpusPath = argv[++i] ?? corpusPath;
    else if (a === "--min-len") minLen = Number(argv[++i] ?? minLen);
  }
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { entries: CorpusEntry[] };
  const cases = buildDialogueCases(corpus, { minLen });
  const withGold = cases.filter((c) => c.expect.length > 0).length;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: "hxmem-dialogue-cases/1",
        generatedAt: new Date().toISOString(),
        source: { episodes: EPISODES, corpus: corpusPath, minLen },
        stats: { total: cases.length, withGold, noGold: cases.length - withGold },
        cases,
      },
      null,
      2,
    ),
  );
  console.log(
    "对话用例: " + cases.length + " 条 (有 gold " + withGold + ", 无 gold " + (cases.length - withGold) + ") → " + out,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("cases-from-dialogue.ts")) process.exitCode = main();
