// bench/lib/cases.ts — 生成评测 case (分层, gold 机器可验证)。
//
// 为什么分层: 单一类型的 case 会被某一种检索策略系统性主宰。词面探针偏爱 FTS,
// 语义改写偏爱向量, 多跳偏爱图。分层后能看出"某个系统的优势到底来自哪一层"。
//
// 分层与用途:
//   lexical_unique  — 全库唯一子串探针。天花板对照: 任何系统都该接近满分, 拉开差距说明有 bug。
//   lexical_shared  — 多条目共享的词面, 有区分度。
//   multihop        — 需要沿关系边扩展才能拿全的多个 gold。
//   temporal_update — 期望召回更新后的版本而不是旧版。
//   abstention      — 库里没有相关记忆, 期望弃权 (关键词经机器校验确实不出现)。
//
// 用法: node --experimental-strip-types bench/lib/cases.ts [--in corpus.json] [--out cases.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Corpus, CorpusEntry } from "./corpus.ts";

export interface Case {
  id: string;
  type: "lexical_unique" | "lexical_shared" | "multihop" | "temporal_update" | "abstention";
  query: string;
  expect: string[];
  secondary?: string[];
  note: string;
  /**
   * **代码碎片探针** (`true` = 该 query 是从条目里截取的片段, **不是自然提问**)。
   *
   * 为什么必须单独标出来 (2026-09-18, §448): 实测 872 条正样本里 **448 条 (51%)** 的 query
   * 是这种碎片 —— 形如 `generalize)` / `ng_model_id),` / `ed,rejected,archived` /
   * `d+4*0.2)/(exposure+4`。它们由 `uniqueProbe` 与"共享词面"两处逻辑产出。
   *
   * **后果 (实测)**: 在碎片上 R@10 = 0.8951, 而在**非碎片**上 R@10 = **0.9693** ——
   * 总体指标 (0.9106) 被碎片**拉低 6 个百分点**。即"以碎片为主的指标"**低估了真实提问上的表现**。
   *
   * **为什么标而不是删**: 碎片对"字面探针"这个用途是**有效的** (它确实是"天花板对照",
   * 见生成处的注释), 只是**不能代表真实负载**。删掉会丢掉那一层信息;
   * 标出来则可以让评分侧**分别报告**两类 —— 那才是诚实的读法。
   */
  fragment?: boolean;

  /**
   * **不计入指标** (`true` = 该样本已失效, 保留只为审计)。
   *
   * 为什么需要这个机器可读位 (2026-09-18, §424): 弃权样本的成立前提是"关键词在语料里不出现"。
   * 而库会增长 —— 曾经的库外主题 (rust/tokio/kubernetes) 后来进了库。
   * 旧版只把这件事写成 note 里的文字, 评分侧**照样把它算进弃权率**,
   * 于是那些"不弃权才是正确"的样本被算成失败 ⇒ **指标被系统性低估**。
   */
  exclude?: boolean;
}

/**
 * 这条 query 是**代码碎片**而不是自然提问吗?
 *
 * 判据 (保守, 宁可漏判也不误判): 短 (<= 30 字) **且** 含 >= 3 个连续拉丁字符。
 * 实测该判据在真实库上给出 448/872 (51%) —— 与人工抽查一致 (抽样全是 `ng_model_id),` 这类)。
 *
 * ⚠ 它**必然有误判**: 真实提问里也会有 "DSH 的 API 怎么调" 这种短且含拉丁词的。
 * 所以标记的用途是**分别报告**, 不是"把误判的算作错"。
 *
 * ⚠ **也会漏判** (§614 实测): 判据要求"含 >= 3 个连续拉丁字符", 于是不含拉丁词的
 * 代码片段被漏掉 —— 例如 `"\`..."` (4 字) 与 `"3000]"` (5 字) 都被判成"自然提问"。
 * **规模**: 自然提问 426 条里漏判 **2 条 (0.47%)** ⇒ 对 `[自然提问] R@1` 的影响
 * **小于 0.5 个百分点**。**这是保守判据的已知代价, 不打算为它放宽** (放宽会让
 * "PostgreSQL 的 autovacuum 什么时候触发" 那类**完整短提问**被误判成碎片 —— 那个
 * 错误比漏判更贵, 因为它把真实负载算进了噪声侧)。
 */
export function isFragmentQuery(query: string): boolean {
  // ⚠ 第一版只用"短 + 含拉丁词", 于是把 "PostgreSQL 的 autovacuum 什么时候触发"
  // 这类**完整短提问**也判成了碎片 (实测 32 条弃权样本里 31 条被误判)。
  // 修正: **含问句词的一律不算碎片** —— 那是"这是个提问"的直接证据。
  if (/[怎么什么为什么哪吗呢]/.test(query)) return false;
  return query.length <= 30 && /[A-Za-z_]{3,}/.test(query);
}

/** 在条目内容里找一段"只属于它"的子串 (高精度词面探针, 不依赖 LLM)。 */
export function uniqueProbe(text: string, others: string): string | null {
  const positions = [0.15, 0.4, 0.65, 0.9].map((p) => Math.floor(text.length * p));
  for (const start of positions) {
    for (let len = 20; len >= 6; len--) {
      const slice = text.slice(start, start + len).trim();
      if (slice.length < 6 || /\s/.test(slice) || /^[\p{P}\p{S}]+$/u.test(slice)) continue;
      if (others.includes(slice)) break;
      return slice;
    }
  }
  return null;
}

/** 保守的关键词出现判定: ASCII 词用词边界, 避免 "wal" 命中 "walk" 这类假泄漏。 */
export function mentions(haystack: string, term: string): boolean {
  const text = haystack.toLowerCase();
  const t = term.toLowerCase();
  if (/^[a-z ]+$/.test(t)) return new RegExp("(^|[^a-z])" + t + "([^a-z]|$)").test(text);
  return text.includes(t);
}

/** 弃权样本的主题与关键词 (关键词用于**机器校验**: 语料里若出现它, 该样本不成立)。 */
const ABSTAIN_TOPICS = [
  { q: "Rust 的 tokio 运行时怎么选", keys: ["tokio", "rust"] },
  { q: "Kubernetes 的 HPA 扩缩容阈值", keys: ["kubernetes", "hpa"] },
  { q: "MySQL 的 InnoDB 间隙锁怎么排查", keys: ["mysql", "innodb"] },
  { q: "iOS 的 SwiftUI 状态管理", keys: ["swiftui", "ios"] },
  { q: "CUDA 的 shared memory 优化", keys: ["cuda", "shared memory"] },
];

/**
 * 扩充弃权样本 (2026-09-18, §421)。
 *
 * 为什么必须扩: 原本只有 **5 条** —— 而快照里的"弃权率"就是基于它们算的
 * (`A 0.8` / `B 0.6`)。**5 条样本上 1 条翻转 = 20 个百分点**, 那不是统计量而是噪声;
 * 而弃权恰恰是"模型能不能知道自己不知道"的开关 (见 snapshot.ts 的长注释),
 * 用噪声盯着它等于没盯。
 *
 * 扩充原则 (每条都必须满足):
 *   ① **关键词在语料里确实不出现** (机器校验, 见下面的 leaked 检查) —— 否则"应弃权"不成立;
 *   ② 主题**远离**本仓库的技术栈 (记忆层/检索/宿主插件), 否则可能有语义近邻;
 *   ③ 长度与真实提问同量级 (短查询在词面上更容易"碰巧命中")。
 *
 * 目标规模 40 条: 按 `required_n` 的口径, 40 条能可靠探测 **>=0.33** 的效应 ——
 * 仍不足以探测小效应, 但**远好于 5 条** (那连 0.5 的效应都测不准)。
 * 不追求更大是因为: 每条都要人工确认"关键词不出现且主题够远", 而那是**判断成本**。
 */
const ABSTAIN_TOPICS_EXTENDED = [
  ...ABSTAIN_TOPICS,
  { q: "PostgreSQL 的 autovacuum 什么时候触发", keys: ["postgresql", "autovacuum"] },
  { q: "Redis 的 AOF 重写怎么调优", keys: ["redis", "aof"] },
  { q: "Kafka 的 ISR 收缩是什么原因", keys: ["kafka", "isr"] },
  { q: "Elasticsearch 的分片分配策略", keys: ["elasticsearch", "shard"] },
  { q: "Nginx 的 upstream keepalive 配置", keys: ["nginx", "upstream"] },
  { q: "Terraform 的 state 锁怎么释放", keys: ["terraform", "tfstate"] },
  { q: "Grafana 的 PromQL rate 函数怎么用", keys: ["promql", "grafana"] },
  { q: "Ansible 的 handler 执行顺序", keys: ["ansible", "handler"] },
  { q: "gRPC 的 deadline 和 timeout 区别", keys: ["grpc", "deadline"] },
  { q: "WebAssembly 的线性内存模型", keys: ["webassembly", "wasm"] },
  { q: "Zig 的 comptime 是怎么实现的", keys: ["zig", "comptime"] },
  { q: "Elixir 的 OTP supervisor 树怎么设计", keys: ["elixir", "supervisor"] },
  { q: "Haskell 的 Monad transformer 怎么选", keys: ["haskell", "monad"] },
  { q: "Scala 的 given 和 implicit 有什么区别", keys: ["scala", "given"] },
  { q: "Clojure 的 STM 事务怎么回滚", keys: ["clojure", "stm"] },
  { q: "Erlang 的热代码加载怎么用", keys: ["erlang", "hot code"] },
  { q: "Racket 的 continuation 有什么用途", keys: ["racket", "continuation"] },
  { q: "OCaml 的 functor 怎么组织模块", keys: ["ocaml", "functor"] },
  { q: "Fortran 的数组切片性能", keys: ["fortran", "array slice"] },
  { q: "COBOL 的 COMP-3 字段怎么解析", keys: ["cobol", "comp-3"] },
  { q: "R 的 data.table 按引用更新", keys: ["data.table", "r language"] },
  { q: "Julia 的 multiple dispatch 开销", keys: ["julia", "dispatch"] },
  { q: "MATLAB 的 parfor 怎么分片", keys: ["matlab", "parfor"] },
  { q: "LabVIEW 的数据流编程模型", keys: ["labview", "dataflow"] },
  { q: "Solidity 的 gas 优化技巧", keys: ["solidity", "gas"] },
  { q: "Verilog 的阻塞与非阻塞赋值", keys: ["verilog", "nonblocking"] },
  { q: "VHDL 的 delta cycle 是什么", keys: ["vhdl", "delta cycle"] },
  { q: "Prolog 的回溯怎么控制", keys: ["prolog", "backtracking"] },
  { q: "Smalltalk 的消息传递怎么工作", keys: ["smalltalk", "message send"] },
  { q: "Forth 的栈式虚拟机怎么实现", keys: ["forth", "stack machine"] },
  { q: "APL 的数组编程范式", keys: ["apl", "array programming"] },
  { q: "Ada 的 tasking 怎么做并发", keys: ["ada", "tasking"] },
  { q: "Pascal 的 variant record 怎么用", keys: ["pascal", "variant record"] },
  { q: "Scheme 的 call/cc 有什么用途", keys: ["call/cc", "scheme"] },
  { q: "Tcl 的 uplevel 怎么用", keys: ["tcl", "uplevel"] },
];

export function buildCases(corpus: Corpus): { schema: string; generatedAt: string; corpus: string; metrics: Record<string, string>; cases: Case[] } {
  const entries = corpus.entries;
  const cases: Case[] = [];
  let seq = 0;
  const nextId = (t: string): string => "c-" + t + "-" + String(++seq).padStart(4, "0");
  const haystackOf = (skipId: string): string =>
    entries.filter((e) => e.id !== skipId).map((e) => e.content).join("\n");

  // 1) 唯一子串探针 (天花板对照)
  for (const entry of entries) {
    if (entry.content.trim().length < 60) continue;
    const probe = uniqueProbe(entry.content, haystackOf(entry.id));
    if (!probe) continue;
    cases.push({
      id: nextId("lexical_unique"),
      type: "lexical_unique",
      query: probe,
      expect: [entry.id],
      ...(isFragmentQuery(probe) ? { fragment: true } : {}),
      note: "唯一子串: 天花板对照, 不应有区分度",
    });
  }

  // 2) 共享词面 (有区分度)
  const byWord = new Map<string, string[]>();
  for (const e of entries) {
    for (const w of e.content.split(/[\s,，。；;:：()（）]+/).filter((x) => x.length >= 4 && x.length <= 12)) {
      const list = byWord.get(w) ?? [];
      list.push(e.id);
      byWord.set(w, list);
    }
  }
  for (const [word, ids] of byWord) {
    if (ids.length < 3 || ids.length > 8) continue;
    cases.push({
      id: nextId("lexical_shared"),
      type: "lexical_shared",
      query: word,
      expect: ids.slice(0, 4),
      ...(isFragmentQuery(word) ? { fragment: true } : {}),
      note: "共享词面命中 " + ids.length + " 条, 取前 4 条作 gold",
    });
  }

  // 3) 多跳 (真实关系边)
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const source of entries) {
    const targets = source.relations.map((r) => r.to).filter((id) => byId.has(id));
    if (!targets.length) continue;
    const probe = uniqueProbe(source.content, haystackOf(source.id));
    if (!probe) continue;
    cases.push({
      id: nextId("multihop"),
      type: "multihop",
      query: probe,
      expect: [source.id],
      ...(isFragmentQuery(probe) ? { fragment: true } : {}),
      secondary: targets.slice(0, 3),
      note: "主目标词面可命中; 次级目标只能靠关系边拿到",
    });
  }

  // 4) 时间更新 (supersedes 边)
  for (const e of entries) {
    for (const r of e.relations) {
      if (r.type !== "supersedes") continue;
      cases.push({
        id: nextId("temporal_update"),
        type: "temporal_update",
        query: uniqueProbe(e.content, haystackOf(e.id)) ?? e.content.slice(0, 20),
        expect: [e.id],
        note: "期望召回取代者而不是被取代者",
      });
    }
  }

  // 5) 弃权 (关键词机器校验确实不出现)
  const corpusText = entries.map((e) => e.content).join("\n");
  for (const item of ABSTAIN_TOPICS_EXTENDED) {
    const leaked = item.keys.some((k) => mentions(corpusText, k));
    cases.push({
      id: nextId("abstention"),
      type: "abstention",
      query: item.q,
      expect: [],
      // ⚠ `exclude` 而不是只写"警告" (2026-09-18, §424 修复):
      // 旧版只把泄漏标成 note 里的文字, 而那 8 条**仍然被当作有效弃权样本参与计分** ——
      // 后果: 它们"不弃权"是**正确的** (库里有依据), 却被算成失败, 于是弃权率被**系统性低估**。
      // 实测: 40 条里 8 条带警告 (原 5 条经复核已全部泄漏: rust 14 / tokio 2 / kubernetes 1… ,
      // 加我新扩的 upstream / handler / scheme 也命中)。
      // 现在给一个**机器可读**的判定位, 由 score 侧过滤, 而不是靠人读 note。
      ...(leaked ? { exclude: true } : {}),
      note: leaked ? "已排除: 语料里出现了关键词 (该主题现在不算库外问题)" : "语料中没有相关记忆, 期望弃权",
    });
  }

  return {
    schema: "hxmem-cases/1",
    generatedAt: new Date().toISOString(),
    corpus: "corpus.json",
    metrics: {
      "recall@k": "|top-k ∩ gold| / |gold| (gold 为空时不计入检索均值)",
      mrr: "首个 gold 的排名倒数",
      "ndcg@k": "二值相关 (IDCG = 把 |gold| 个 gold 排最前)",
      abstention: "系统返回空 OR top1 分数 < 阈值",
    },
    cases,
  };
}

function main(argv: string[]): number {
  let input = join(".tmp", "bench", "corpus.json");
  let out = join(".tmp", "bench", "cases.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--in") input = argv[++i] ?? input;
    else if (argv[i] === "--out") out = argv[++i] ?? out;
  }
  const corpus = JSON.parse(readFileSync(input, "utf8")) as Corpus;
  const cases = buildCases(corpus);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(cases, null, 2));
  const byType: Record<string, number> = {};
  for (const c of cases.cases) byType[c.type] = (byType[c.type] ?? 0) + 1;
  console.log("case: " + cases.cases.length + " " + JSON.stringify(byType));
  console.log("输出: " + out);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
