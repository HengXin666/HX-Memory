// src/frustration/features.ts — 挫折检测的特征抽取 (确定性, 不调用任何模型)。
//
// 为什么要有它 (2026-11-01): 检测不再依赖 LLM 判官。判定改为「特征 × 权重」的线性打分
// (见 classifier.ts), 每个特征都有名字, 每次判定都能列出是哪几个特征、各贡献多少分。
// 同一段文本永远得到同一组特征 (无随机、无网络、无时钟), 所以结果可复现。
//
// 特征分三组, 训练脚本按组合出 4 个候选 (FRUSTRATION-MODEL.md 第 2 节):
//   lex:*   现有词表 (kernel/negativity.ts) 在遮掉技术词之后的命中, 按类别各 1 个特征;
//   cue:*   人写的句式规则 (下方 CUES), 每条一个特征, 名字即规则 id;
//   ng:*    汉字/字母 2-3 元组, 哈希进固定桶数 (小模型候选才用)。
//
// 另有一组「后验特征」(POSTERIOR_CUES, 2026-11-01 加): 看的是被判那条用户消息「之后」助手回复的首句。
// 判定用户消息的那一刻助手回复还不存在, 所以后验特征**永远不进实时检测主路** (extractFeatures 不抽它,
// 4 个候选和 model.ts 都不含它)。它只用在两处, 入口是 extractPosteriorFeatures():
//   一, 轮末补偿判定 (detect.ts compensateAtTurnEnd): 助手已经回完, 实时路判「否」而首句命中时, 回补一条纠正记录;
//   二, 离线重放/评测 (train-frustration.ts 的 posterior 段): 标定实时 detect 的漏报。
import { compileNegativity, detectNegative, type CompiledNegativity } from "../kernel/negativity.ts";
import { maskTechTerms } from "./detect-mask.ts";

export type FeatureVector = Map<string, number>;

/** 句式规则。id 进入特征名 `cue:<id>`; 改正则要同时改 id 的语义, 不要复用旧 id。 */
export const CUES: ReadonlyArray<{ id: string; re: RegExp; note: string }> = [
  { id: "profanity", re: /傻逼|煞笔|sb(?![a-z])|妈的|他妈|操你|白痴|蠢货|脑子(进水|有病)|废物|垃圾/i, note: "脏话/辱骂" },
  { id: "you-rhetorical", re: /你[^。！!\n]{0,14}(吗|么|嘛)\s*[？?]/, note: "以「你」开头的反问: 你听不懂吗?" },
  { id: "not-x-q", re: /不是[^。\n]{0,24}(吗|么|嘛)/, note: "不是……吗" },
  { id: "why-not", re: /为什么(不|没|还|又|你|现在|我)|为啥(不|没)|怎么(不|没|又|还)/, note: "为什么不/没/又" },
  { id: "again", re: /怎么又|又是|还是(不|没)|又(错|坏|失败)/, note: "又/还是不" },
  { id: "i-meant", re: /我(说的是|的意思|不是让你|让你|要的是|只是要|是说|要你)/, note: "我的意思是/我让你" },
  { id: "i-dont-want", re: /我(不要|不希望|不想要|严格禁|希望)/, note: "我不要/我希望" },
  { id: "you-wrong", re: /(你|你的).{0,6}(误解|主观|臆想|乱|瞎|没有理解|不理解|理解错|搞坏|搞错|的问题)|是不是你|你是不是|会不会是你/, note: "指向助手的过错" },
  { id: "slow", re: /太慢|这么久|那么久|半天|效率太低|磨蹭/, note: "嫌慢" },
  { id: "verify", re: /(你|你们)?(确认|真正|真的).{0,12}(吗|？|\?)|测试过.{0,6}(吗|？|\?)/, note: "质疑是否真做了" },
  { id: "punct-burst", re: /[？?]{2,}|[！!]{2,}|。。|[?？][!！]|[!！][?？]/, note: "连续标点" },
  { id: "ban", re: /(^|[，,。\s])(别|不要|禁止|不能)/, note: "禁令/否定祈使" },
  { id: "must", re: /必须|应该|严格|永远|务必/, note: "强约束措辞" },
  { id: "broken", re: /(没有|没)(看到|产出|反应|用)|不行|不对|无法|失败|坏了|不能用|没用/, note: "结果不对" },
  { id: "is-it", re: /(吗|么|嘛)[？?]|[？?]$/, note: "以问句结尾" },
  { id: "polite", re: /请|麻烦|谢谢|辛苦|please|thanks/i, note: "礼貌语 (负向)" },
  { id: "probe", re: /^(say|reply|call|respond|output|print|回一个|回复一个|只回)/i, note: "探针/指令模板 (负向)" },
];

/**
 * 后验句式规则: 作用在「下一条助手消息的首句」上, 不作用在用户原话上。特征名仍是 `cue:<id>`。
 * apology-opener 依据 ASSISTANT-CUES.md 第 2 节 (40 个标注会话, 128 条配到首句): 以「你说得对」开头的首句
 * 阳性 9 / 阴性 1, 精确率 0.90 [0.60, 0.98], 召回 9/37; 9 条阳性里 6 条是当时 detect (候选 A) 漏判的。
 * 「抱歉 / 我的错 / 你说错了」在同一批首句里开头出现 0 次, 没有依据, 不加。
 */
export const POSTERIOR_CUES: ReadonlyArray<{ id: string; re: RegExp; note: string }> = [
  { id: "apology-opener", re: /^\s*你说得对/, note: "助手下一条消息首句以「你说得对」开头" },
];

/** 后验特征: 输入是下一条助手消息的首句。只给轮末补偿和离线评测用, 实时路径禁止调用。 */
export function extractPosteriorFeatures(nextAssistantFirst: string): FeatureVector {
  const f: FeatureVector = new Map();
  const t = (nextAssistantFirst ?? "").trim();
  if (!t) return f;
  for (const c of POSTERIOR_CUES) if (c.re.test(t)) f.set("cue:" + c.id, 1);
  return f;
}

/** 2-3 元组哈希桶数。固定为 2^11, 改它等于换模型, 必须重训。 */
export const NGRAM_BUCKETS = 2048;

/** FNV-1a 32 位, 用于 n 元组分桶 (确定性, 与平台无关)。 */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface FeatureGroups {
  lex: boolean;
  cue: boolean;
  shape: boolean;
  ngram: boolean;
  /** n 元组的 n (默认 [2, 3]); 只给粒度分析用, 线上模型不设。 */
  ngramN?: number[];
  /** 额外的句式规则 (默认无); 只给事后分析 (DETECT-REPORT 第 1 节) 用。 */
  extraCues?: ReadonlyArray<{ id: string; re: RegExp }>;
}

export const ALL_GROUPS: FeatureGroups = { lex: true, cue: true, shape: true, ngram: true };

let defaultCompiled: CompiledNegativity | null = null;

/**
 * 抽取特征。输入是用户原话 (以及可选的上一条助手消息, 目前只用来算 shape:after-assistant)。
 * 所有正则都跑在「遮掉技术词之后」的文本上, 和词表口径一致 (detect.ts 的 maskTechTerms)。
 */
export function extractFeatures(
  text: string,
  groups: FeatureGroups = ALL_GROUPS,
  opts: { compiled?: CompiledNegativity; prevAssistant?: string } = {},
): FeatureVector {
  const f: FeatureVector = new Map();
  const { masked } = maskTechTerms(text);
  const t = masked.trim();
  if (groups.lex) {
    const compiled = opts.compiled ?? (defaultCompiled ??= compileNegativity());
    const sig = detectNegative(masked, compiled);
    for (const k of new Set(sig.hits.map((h) => h.kind))) f.set("lex:" + k, 1);
  }
  if (groups.cue) {
    for (const c of CUES) if (c.re.test(t)) f.set("cue:" + c.id, 1);
    for (const c of groups.extraCues ?? []) if (c.re.test(t)) f.set("cue+:" + c.id, 1);
  }
  if (groups.shape) {
    const len = [...t].length;
    // 2026-11-01 回归修复: 原先是无条件的 shape:len<=12。训练集里 <=12 字的样本 4 正 / 53 负 (负例多为「say OK」类短指令),
    // 而「短且命中词表」只有 1 正 / 0 负, 于是 B 学出 -0.88, 把「不对」「错了」这类短纠正整体压到阈值下 (A 能判中)。
    // 现在只在没有任何 lex 命中时才记短句特征: 它仍能压低短指令, 但不再抵消词表证据。
    const hasLex = [...f.keys()].some((k) => k.startsWith("lex:"));
    if (len <= 12 && !hasLex) f.set("shape:short-nolex", 1);
    if (len >= 120) f.set("shape:len>=120", 1);
    const ascii = t.replace(/[^\x20-\x7e]/g, "").length;
    if (len > 0 && ascii / len > 0.8) f.set("shape:ascii>0.8", 1);
    if (/你/.test(t)) f.set("shape:has-you", 1);
  }
  if (groups.ngram) {
    const s = t.toLowerCase().replace(/\s+/g, " ");
    const chars = [...s];
    for (const n of groups.ngramN ?? [2, 3]) {
      for (let i = 0; i + n <= chars.length; i++) {
        const g = chars.slice(i, i + n).join("");
        if (/^[\s\p{P}\d]+$/u.test(g)) continue;
        const key = "ng:" + (fnv1a(g) % NGRAM_BUCKETS);
        f.set(key, 1);
      }
    }
  }
  return f;
}
