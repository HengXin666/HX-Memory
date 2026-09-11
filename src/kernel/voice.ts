// kernel/voice.ts — 语音输入的**容错归一** (错别字/同音字/口语句读)。
//
// 为什么需要它 (来自真实语料, 不是假想): 本项目的用户用语音输入法, 文本里会出现
//   "绘话"(会话)、"密等/密登"(幂等)、"纸agent"(子agent)、"get hup"(github)……
// 这些错字会让**字面**判定整体失效:
//   - 意图正则 ("为什么…") 漏命中;
//   - 话题漂移用重叠系数, 一个错字就把同一话题推过阈值 (实测: 短追问因个别字不重合被判成换话题);
//   - 全文检索/覆盖率把"密等"当噪声, 于是该召回的记忆一条都不召回。
//
// 设计取舍 (诚实边界):
//   1. **白名单, 不是拼写检查器**: 只做"确定无歧义的映射"。臆造纠正比不纠正更危险 ——
//      把对的词改错会产生静默的假相关。表里每一条都能追溯到真实语料或明确同音关系。
//   2. **只处理 2 字 CJK 同音对**: 单字替换会伤及正常词汇 ("时间"/"实践"都合法)。
//   3. **归一与变体分开**: normalizeVoice 给判定用 (确定性的); voiceVariants 给检索用
//      (原形 + 归一形都进检索词, 因为记忆里存的可能是任一写法)。
//   4. 长词优先替换: "纸agent" 必须在 "agent" 相关规则之前生效。
// 位置: kernel 层 (纯函数, 无 IO), 被 trigger/policy 与 retrieval/channels 共用。

/** 同音/近音混用对 (仅收无歧义者; 左侧 = 语音误写, 右侧 = 标准写法)。 */
const CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  // 会话 / 绘画 系 (语料实测: "多轮绘话", "当前的绘话")
  ["绘话", "会话"],
  ["会画", "会话"],
  ["回话", "会话"],
  // 幂等 (语料实测: "怎么确保它密等呢")
  ["密等", "幂等"],
  ["密登", "幂等"],
  ["幂登", "幂等"],
  // 子 agent (语料实测: "拍多个纸agent")
  ["纸 agent", "子 agent"],
  ["纸agent", "子agent"],
  // 分词 / 词元
  ["分辞", "分词"],
  ["词原", "词元"],
  // 索引 / 缩影
  ["缩影", "索引"],
  // 端口 / 短口
  ["短口", "端口"],
  // 检索 / 捡索
  ["捡索", "检索"],
  // 阈值 / 于值
  ["于值", "阈值"],
  // 召回 / 招回
  ["招回", "召回"],
];

/** 拉丁词的空格/连写变体 (语音转写常把 `github` 写成 "get hup"/"get hub")。 */
const LATIN_CONFUSIONS: ReadonlyArray<readonly [string, string]> = [
  ["get hup", "github"],
  ["get hub", "github"],
  ["git hub", "github"],
  ["git hup", "github"],
];

/** 按左侧长度降序 (长词优先), 避免 "纸agent" 被更短的规则先改掉。 */
const ORDERED = [...CONFUSIONS, ...LATIN_CONFUSIONS].sort((a, b) => b[0].length - a[0].length);

/**
 * 语音容错归一: 把确定的误写换成标准写法。
 * 幂等 (对已规范的文本返回原样), 且不改变长度以外的任何东西 —— 判定链路可以放心用它。
 */
export function normalizeVoice(text: string): string {
  let out = text;
  for (const [from, to] of ORDERED) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

/** 语音输入的常见"口水话"改写标记 (口语化程度, 不是错误, 但会让关键词评分失准)。 */
const FILLER = /(懂吧|你懂吧|就是说|然后的话|那个那个|呃|嗯+)/g;

/**
 * 检索用的候选文本: 原形在前 (记忆里更可能是原形), 归一形在后 (也可能是规范写法)。
 * 加一层"去口水话"的变体, 让口语长句也能命中规范表述的记忆。
 */
export function voiceVariants(text: string): string[] {
  const normalized = normalizeVoice(text);
  const out = [text];
  if (normalized !== text) out.push(normalized);
  const stripped = normalized.replace(FILLER, "").replace(/[\s]{2,}/g, " ").trim();
  if (stripped && stripped !== normalized && stripped !== text) out.push(stripped);
  return out;
}
