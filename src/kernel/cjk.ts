// kernel/cjk.ts — 中英混排文本的检索分词 (索引侧与查询侧共用同一函数, 保证对称)。
//
// 为什么需要它 (实测依据, Node 24.15 / SQLite 3.51.3 / node:sqlite):
//   - FTS5 unicode61 把连续汉字当成一个 token: "并发" 查不中 "所有容器都有并发策略问题";
//   - FTS5 trigram 需要 >= 3 字符: 2 字中文查询 ("并发" / "容器") 恒不命中;
//   - Intl.Segmenter('zh-Hans') 能切词, 但会把 "连接池" 切成 "连接" + "池", 未登录词无保障。
// 方案: 双流 —— 词流 (Segmenter, 保精度) + CJK bigram 流 (保召回), 两流分列交给 unicode61,
//       BM25 给词流更高列权。代价是索引膨胀约 2-3 倍, 换来"任意 2 字中文查询都能命中"的确定性。
//
// 不变量:
//   1. 索引与查询必须用同一份分词逻辑 (本文件), 否则召回会静默失效。
//   2. 索引词表带 TOKENIZER_VERSION; 版本变化 = 索引必须重建 (派生数据, 不迁移)。
//   3. 纯函数, 无 IO, 无宿主依赖 (kernel 铁律)。
import type { MemoryEntry } from "./types.ts";

/** 索引格式版本。分词逻辑改变时必须 +1, 存储层据此拒绝读旧索引并重建。 */
export const TOKENIZER_VERSION = 1;

/** CJK 及谚文/假名区 (这些文字没有空格分词, 需要 bigram 兜底)。 */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/** FTS5 语法字符: 引号相位内只需要转义双引号, 其余在引号内是字面量。 */
function quoteTerm(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

let segmenter: Intl.Segmenter | null | undefined;

/** Intl.Segmenter 是可选能力 (精简 ICU 的 Node 可能没有); 缺失时退化为纯 bigram。 */
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    try {
      segmenter =
        typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter("zh-Hans", { granularity: "word" })
          : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter;
}

export interface TermStreams {
  /** 词流: 语言感知切词 (中文词/英文单词/数字)。BM25 权重高。 */
  words: string[];
  /** CJK bigram 流: 保证 2 字查询与未登录词可召回。BM25 权重低。 */
  bigrams: string[];
}

/** 把一段文本切成词流 + bigram 流 (索引与查询共用)。 */
export function termStreams(text: string): TermStreams {
  const words: string[] = [];
  const bigrams: string[] = [];
  const normalized = normalize(text);
  if (!normalized.trim()) return { words, bigrams };

  const seg = getSegmenter();
  if (seg) {
    for (const part of seg.segment(normalized)) {
      if (!part.isWordLike) continue;
      const t = part.segment.trim();
      if (t) words.push(t);
    }
  } else {
    // 退化路径: 无 Segmenter 时按"CJK 连续段 / 非 CJK 连续段"切分。
    for (const chunk of normalized.match(/[^\s]+/g) ?? []) {
      for (const m of chunk.matchAll(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z0-9_]+/gu,
      )) {
        const t = m[0];
        if (t) words.push(t);
      }
    }
  }

  // bigram: 只对 CJK 连续段生成; 单字段落退化为该字本身 (保证 1 字查询也能命中)。
  for (const chunk of normalized.match(/[^\s]+/g) ?? []) {
    let run = "";
    const flush = () => {
      if (run.length === 1) bigrams.push(run);
      else for (let i = 0; i + 1 < run.length; i++) bigrams.push(run.slice(i, i + 2));
      run = "";
    };
    for (const ch of chunk) {
      if (CJK_CHAR.test(ch)) run += ch;
      else flush();
    }
    flush();
  }

  return { words, bigrams };
}

/** 索引写入用: 两列内容 (由存储层填进 FTS5 的两个列)。 */
export function indexTermColumns(text: string): { words: string; bigrams: string } {
  const s = termStreams(text);
  return { words: s.words.join(" "), bigrams: s.bigrams.join(" ") };
}

/**
 * 查询用: 生成 FTS5 MATCH 表达式 (在任何一列命中即可, OR 语义)。
 * 返回空串表示"该查询没有可检索词", 调用方必须短路 (不许把空表达式交给 FTS5, 那会语法错)。
 */
export function matchExpression(text: string): string {
  const s = termStreams(text);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const t of [...s.words, ...s.bigrams]) {
    if (seen.has(t)) continue;
    seen.add(t);
    terms.push(quoteTerm(t));
  }
  if (!terms.length) return "";
  return "{words bigrams} : (" + terms.join(" OR ") + ")";
}

/** 索引文本 (便于日志/测试观察: 索引里长什么样)。 */
export function indexText(text: string): string {
  const c = indexTermColumns(text);
  return (c.words + " " + c.bigrams).trim();
}

/**
 * 文本 → 词集 (词流 + bigram 流, 去重)。
 *
 * **这是全仓库唯一的"文本 → 词集"实现**。此前 `kernel/ranking.ts`、`trigger/policy.ts`、
 * `evolution/associate.ts` 各写了一份, 而它们分别服务于"去冗余 / 话题漂移 / 去重裁决" ——
 * 口径一旦分叉, 同一对文本在不同环节会得出互相矛盾的相似度, 而这类不一致**不会报错**。
 * 因此统一到本函数: 分词口径只有一处, 改它也只有一个地方要改 (索引侧仍走 termStreams 的分列版本)。
 */
export function tokenSet(text: string): Set<string> {
  const streams = termStreams(text);
  const set = new Set<string>();
  for (const t of streams.words) set.add(t);
  for (const t of streams.bigrams) set.add(t);
  return set;
}

/** 一条记忆的可检索文本: 正文 + 摘要 + 要点 + 标签 (标签权重靠后, 由列权体现)。 */
export function searchableText(entry: MemoryEntry): string {
  const parts = [entry.content];
  if (entry.structured) {
    parts.push(entry.structured.summary);
    parts.push(...entry.structured.points);
  }
  if (entry.tags?.length) parts.push(entry.tags.join(" "));
  if (entry.entities?.length) parts.push(entry.entities.join(" "));
  return parts.filter(Boolean).join("\n");
}
