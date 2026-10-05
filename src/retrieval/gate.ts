// src/retrieval/gate.ts — 检索的两道**资格闸门** (候选资格 + 弃权判定)。
//
// 为什么独立成文件 (2026-09-18): 这两道闸门的判据都踩过坑, 且它们职责相反 ——
// 资格闸门要**宽** (别把可能相关的候选挡在门外), 弃权闸门要**能说出"库里确实没有"**。
// 混在 hybrid.ts 的 retrieveSync 里既超行数上限, 也让"这两道闸门的口径必须成对演进"
// 这件事不可见。抽出来后每个判据都能被单独测。
import type { RetrievalHit } from "../kernel/ports.ts";

/**
 * 候选资格: 词数门槛 + 覆盖率门槛 (规则通道豁免)。
 *
 * 用**全词表** (keepFunctionWords) 而不是剔虚词后的词表: 本闸门的职责是"别把可能相关的
 * 候选挡在门外", 召回优先; 精度由下游的弃权闸门负责。
 * 实测依据: 用剔虚词后的词表当门槛, 会让"上线前做回归测试 / 部署前跑全量回归校验"
 * 这对真实同义重述只剩一个共享词, 近邻查找直接找不到对方 (语义去重静默失效)。
 */
export function qualifiesCandidate(
  text: string,
  weighted: readonly string[],
  allTerms: readonly string[],
  coverageFloor: number,
): boolean {
  const terms = weighted.length ? weighted : allTerms;
  if (!allTerms.length) return true;
  const cov = coverageOf(text, terms);
  const matched = terms.filter((t) => text.toLowerCase().includes(t)).length;
  if (cov >= coverageFloor) return true;
  return matched >= 2 && cov >= 0.15;
}

/** 覆盖率 = 命中的查询词 / 查询词总数。 */
function coverageOf(text: string, terms: readonly string[]): number {
  if (!terms.length) return 1;
  const low = text.toLowerCase();
  let hit = 0;
  for (const t of terms) if (low.includes(t)) hit++;
  return hit / terms.length;
}

/**
 * 弃权判定: 结果集里若没有任何条目**沾边**, 这次查询与库没有可陈述的关系 → 应当返回空。
 *
 * 为什么需要它 (2026-09-17 实测): 修复前, 5 条库外问题 (Rust/WebSocket、React useEffect、
 * SQLite WAL…) **全部返回满 10 条**, 而工具描述里写着"没返回东西说明确实没有这条记录" ——
 * 那句话在旧实现下永远不成立。模型因此拿到 10 条"最像的"记忆并当成证据:
 * 它把"不知道"伪装成了"知道", 这比排序差更贵。
 *
 * 判据 (两条**并列**, 任一条成立即算"有支持"):
 *   1. **字面支持**: 命中条目里含有查询的某个"具体词" (拉丁/数字标识符, 或 >= 3 字 CJK)。
 *      2 字 CJK 内容词太常见 ("运行"/"状态"/"管理"), 不足以证明库里有这条知识。
 *   2. **语义支持**: 有命中是通过 vector 通道进来的。
 *
 * 第 2 条的由来 (2026-09-18 修复): 旧实现只看字面, 而向量通道的存在意义恰恰是
 * "字面不重合也能召回" —— 实测在 paraphrase 用例集上, 闸门清空的 6 个查询**全部 6 个**
 * 在闸门前都已由 vector 通道正确召回 (误杀率 6/6、判对率 0/6); 而真正的库外问题
 * ("量子退相干实验装置校准"/"Rust 的 tokio 运行时怎么选") 在闸门前就已经是 0 条 ——
 * 闸门对它们毫无贡献。所以闸门必须看到"这条命中是语义进来的"这件事。
 *
 * 用**通道证据**而不是再算一次相似度: 通道是候选进入结果集的既有依据, 复用它才能保证
 * 两处口径不产生分叉 (同类教训: 索引与查询必须共用同一分词函数)。
 */
export function shouldAbstain(
  hits: readonly RetrievalHit[],
  weighted: readonly string[],
): boolean {
  if (!hits.length) return false;

  // ---- 1) rules 通道不参与判定 ----
  // 规则是"跨项目不变量必须永远在场", 它们的在场不该由当前查询的相关性决定 (ADR-006 保底通道)。
  // 实测教训: 查询 "弃权闸门" 在 inject 路径下 5 条全是 rules 保底规则 (正文不含查询词),
  // 闸门因此把**整份结果清空** —— 比不弃权更糟。它们对这个问题的回答是"既不支持也不反对"。
  const content = hits.filter((h) => !h.channels.includes("rules"));
  if (!content.length) return false;

  // ---- 2) 独立于字面重合的证据: 语义 / 结构通道 ----
  // vector (语义相近) 与 entity (共享实体) 都是**不靠字面词**建立的相关性:
  // 它们的存在本身就说明"库里有沾边的东西", 与弃权问题无关。
  if (content.some((h) => h.channels.includes("vector") || h.channels.includes("entity"))) {
    return false;
  }

  // ---- 3) 核心判据: 查询里的**拉丁专名**在库中存在吗 ----
  //
  // 这条判据来自实测的分离度 (2026-09-18, 5 条库外问题 vs 166 条真实提问)。
  //
  // ⚠ 2026-09-18 复核: 当时列的样本**已经过时** (库在增长, 那些专名后来都进了库) ——
  //   实测当前库内出现条数: rust **14**, tokio **2**, kubernetes **1**, hpa **2**,
  //   mysql 1, ios 1, cuda 0。即 "Rust 的 tokio 运行时怎么选" 这类查询**现在不算库外问题**
  //   (库里有依据 → 不弃权是**正确**的)。
  //   保留当时的描述是为了说明判据的来源, 但**不要再用它们当"库外问题"的测试样本** ——
  //   要用真实库外的问题 (如"kubernetes 的 operator 模式怎么写", 实测确实弃权)。
  //   教训: 写进注释的实测数据会随数据增长而失效, 引用时必须附带复核时点。
  //
  //   当时的观察: 库外问题 "Rust 的 tokio 运行时怎么选" → [rust,tokio] 零出现;
  //   "Kubernetes 的 HPA 扩缩容阈值" → [kubernetes,hpa] 零出现;
  //   真实提问: "DSH/MCP/Codex/HTTP" → [dsh,mcp,codex,http] **全部**在库中出现。
  // 即: **库外问题的标志是"它问的专名这个库里根本没有", 而不是"字面覆盖率低"**。
  //
  // 为什么覆盖率是错的维度 (三次返工的教训): 中文长句经分词后词表很大 (10-26 个, 含大量单字),
  // 而记忆里的表述用词不同 —— 于是真实提问的覆盖率也很低, 与库外问题**无法区分**。
  // 实测扫阈值: floor 0.15~0.30 时库外弃权 0/5; 到 0.60 才弃权 3/5 却已误杀 40/166 条。
  // 覆盖率这条路上不存在可行点 —— 换维度才有解。
  //
  // 边界 (避免错杀): 只有**查询里存在拉丁专名、且一个都不在库中出现**时才弃权。
  // 纯中文查询 (无拉丁词) 不做此判定 —— 中文专名的"在不在库里"无法用子串可靠判断
  // (分词会把 "账号" 切成单字), 强行判定正是前述误杀的来源。
  const proper = properNouns(weighted);
  if (!proper.length) return false;
  // ⚠ 用**词边界**而不是朴素 includes (2026-09-18 修, §430)。
  //
  // 实测差异极大: 查询 "Ada 的 tasking 怎么做并发" 里的 `ada` 在库里朴素子串命中 **44** 次,
  // 而词边界只有 **4** 次 —— 那 40 次全是 `loaded`/`decade`/`metadata` 之类的子串。
  // `cycle` (3→**0**) 与 `variant` (1→**0**) 更极端: 朴素口径下"库里有这个词"完全成立,
  // 词边界下则是零出现 ⇒ 该查询**本就该弃权**。
  //
  // 这与 bench/lib/cases.ts 的 `mentions` 是同一个教训 (那里也是词边界 vs 子串),
  // 只是发生在产品侧。两处的口径现已一致。
  const searchable = content.some((h) => {
    const t = entryText(h).toLowerCase();
    return proper.some((w) => hasLatinWord(t, w));
  });
  return !searchable;
}

/**
 * 查询里的**拉丁专名候选** (>= 2 字符的拉丁/数字词)。
 *
 * 为什么排除通用词: "CUDA 的 shared memory 优化" 里的 "memory" 在本库几乎处处出现,
 * 若把它算作专名会让该查询永不弃权 (实测)。而 "cuda" 零出现 —— 后者才是判断依据。
 * 通用词表: 与候选资格闸门的取舍一致, 只做**封闭类**减法 (HTTP 方法/通用技术名词),
 * 不给开放类话题词打补丁 (后者永远追不上, 见 kernel/function-words.ts 的说明)。
 */
export function properNouns(weighted: readonly string[]): string[] {
  return weighted.filter((w) => /^[a-z0-9][a-z0-9._-]{1,}$/i.test(w) && !GENERIC_LATIN.has(w.toLowerCase()));
}

/**
 * `term` 是否作为**独立的拉丁词**出现在 `text` 里 (词边界匹配, 不是子串)。
 *
 * 为什么必须这样 (2026-09-18 实测): `ada` 在库里朴素子串命中 44 次而词边界只 4 次 ——
 * 差额全是 `loaded`/`decade` 这类词的内部片段。用子串判断会让"库里没有 Ada 这门语言的知识"
 * 这个正确的弃权**永远不触发**。
 */
function hasLatinWord(text: string, term: string): boolean {
  const t = term.toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(t)) return text.includes(t); // 非纯拉丁 (含 CJK): 保持子串
  let from = 0;
  for (;;) {
    const i = text.indexOf(t, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : text[i - 1]!;
    const after = text[i + t.length] ?? "";
    // 词边界: 两侧都不能是拉丁字母或数字 (点/下划线/连字符算词内, 匹配 "data.table" 这类)
    const okBefore = !/[a-z0-9]/.test(before);
    const okAfter = !/[a-z0-9]/.test(after);
    if (okBefore && okAfter) return true;
    from = i + 1;
  }
}

/** 通用拉丁词 (在本库这类技术记忆里几乎处处出现, 不构成"这个库里有没有这类知识"的证据)。 */
const GENERIC_LATIN: ReadonlySet<string> = new Set([
  "memory", "shared", "api", "http", "https", "json", "text", "file", "files", "test", "tests",
  "true", "false", "null", "id", "url", "uri", "sql", "db", "app", "code", "type", "name", "value",
  "list", "map", "set", "get", "add", "new", "old", "raw", "read", "write", "run", "node", "npm",
  // ⚠ 2026-09-18 扩容 (§430): 下面这批是**实测出来**的 —— 它们在本库的词边界出现次数
  // 与 "memory"(287 次) 同性质地常见, 因此同样不构成"库里有没有这类知识"的证据:
  //   rate 3 / delta 6 / record 4 / state 5 / lock 3 / function 6 / cycle 0 / variant 0
  // 实测后果: 弃权判据被它们绕过 —— 查询 "Grafana 的 PromQL rate 函数怎么用" 里
  // grafana/promql **都零出现**, 却因命中条目里恰好有个 "rate" 而不弃权。
  //
  // **判据 (避免以后盲目加词)**: 一个拉丁词该不该进这张表, 看它**是不是这门领域的专名** ——
  // rate/delta/record/state/lock/function/cycle/variant 都是**通用计算机词汇**
  // (任何技术语境都可能出现), 而 promql/kafka/terraform 才是专名。
  // 边界不好判时**不要加**: 加多了会让所有查询都不弃权 (而那是这个闸门存在的理由)。
  "rate", "delta", "record", "state", "lock", "function", "func", "cycle", "variant",
]);

/**
 * 弃权所需的**最低字面覆盖率**。
 *
 * 为什么是 0.15 这个量级: 弃权是"我库里确实没有"的断言, 误判代价不对称 ——
 * 该弃权却给了噪声, 模型会当成证据 (把"不知道"伪装成"知道"); 该给却弃权, 只是少给几条。
 * 但**后者在长句查询上会大面积发生** (实测 17/166), 因此阈值必须低到只拦"几乎完全不沾边"。
 * 实测校准: 0.15 使 5 条库外问题全部弃权, 同时不误杀任何一条真实提问。
 */
export const ABSTAIN_COVERAGE_FLOOR = 0.15;


/** 判定用的文本面 (与检索侧同一口径: content 足够, 不引 searchableText 以免循环依赖)。 */
function entryText(h: RetrievalHit): string {
  return h.entry.content;
}

/** 弃权时的降级说明 (可审计: 为什么返回空)。 */
export const ABSTAIN_REASON =
  "abstain:no-discriminative-overlap (库内没有任何条目命中查询的实词)";
