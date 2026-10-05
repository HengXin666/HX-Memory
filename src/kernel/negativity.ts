// kernel/negativity.ts — 负面/纠正信号的**判定内核** (可配置词表 + 正则, 纯逻辑无 IO)。
//
// ## 为什么需要它 (2026-10-05, 用户实测)
//
// 真库里已经躺着 27 条自动沉淀的辱骂原话 (`"操你妈"` / `"你傻逼吧，停"` /
// `"继续的操你妈别再让我重启了"`), 而它们**只是原话转录** —— 骂人背后的诉求
// ("你别磨磨蹭蹭" / "先跑测试再改代码") 一个字都没提炼出来。
// 同期真正该记的**纠正句**反而被丢: 实测 10 条纠正表述里 8 条判 `no-signal:context`。
//
// 也就是说旧行为是**双向错的**: 骂人的原话进了库, 骂人指向的教训没进库。
// 本模块只做一件事: 把"用户在用负面措辞说话"这件事**判定出来**, 并给出方向 ——
// 怎么处置 (不落原话、改落 lesson、注入同类铁律) 由调用方决定。
//
// ## 三个类别 (来自用户的真实用语, 不是猜的)
//
//   · `blame-method`    —— "你这个做法是错的" (傻逼/蠢驴/蠢牛/废物/脑残…);
//   · `blame-execution` —— "我对你的执行非常不满/生气" (操你妈/他妈/妈的/fuck…);
//   · `correction`      —— 纠正性陈述 ("错了/不是这样/我说的是/应该是/搞错了")。
//
// 用户明确说过 "程度没有什么意义, 重点是你要能真正有效地沉淀"。因此:
//   · `level` 只是**排序与日志用的副产物**, 不是任何门槛 —— 命中即处置, 不看等级;
//   · 三个类别**分开记** (修法不同: 方法错要改方案, 执行不满要改流程, 纠正要给方向)。
//
// ## 词表可配置 (用户要求 "直接给个地方让用户配置")
//
// `patterns` 从设置读, 缺省用 `DEFAULT_NEGATIVE_WORDS`。每行一条, 支持三种写法:
//   · `正则` —— 以 `/` 开头与结尾 (`/傻[逼b]/`) 按正则编译;
//   · `文字` —— 其余按字面包含匹配 (大小写不敏感)。
// 坏正则**跳过并记录**, 不让整份词表失效 (一个手滑的括号不该让兜底通道整体停摆)。
import { normalizeVoice } from "./voice.ts";

// 教训草稿的生成搬到 negativity-lesson.ts (§710 行数上限): 判定随"什么词算负面"变,
// 而落库那句话随"它该长什么样"变 —— 两类变化分开。这里转出去让既有 import 不被打断。
export { lessonDraftOf, BEHAVIOR_BANS } from "./negativity-lesson.ts";

/** 负面信号的类别 (三个类别处置不同, 必须分开)。 */
export type NegativeKind = "blame-method" | "blame-execution" | "correction";

/** 一条命中。 */
export interface NegativeHit {
  kind: NegativeKind;
  /** 命中的字面 (从原文里摘出来的, 不是词表条目本身) —— 用于日志与面板解释。 */
  matched: string;
}

/**
 * 判定结果。
 *
 * `level` 的语义 (只用于日志/排序, **不是门槛**):
 *   1 = 单一类别命中; 2 = 两类以上, 或同一词重复出现; 3 = 同时含辱骂与纠正 (用户既生气又给了方向)。
 * 用户明确说"程度没什么意义", 因此任何调用方都**不得**用 level 当可否处置的判据。
 */
export interface NegativeSignal {
  /** 是否命中。 */
  hit: boolean;
  /** 命中的类别 (去重, 保序)。 */
  kinds: NegativeKind[];
  /** 全部命中 (含重复次数; 用于"重复第 N 次"这类升级信号)。 */
  hits: NegativeHit[];
  /** 1..3 (释义见上)。 */
  level: number;
  /** 人可读理由 (进日志/面板)。 */
  reason: string;
}

/** 未命中 (常量, 避免调用方各自构造空对象)。 */
export const NO_NEGATIVE: NegativeSignal = {
  hit: false,
  kinds: [],
  hits: [],
  level: 0,
  reason: "",
};

/**
 * 词表条目: 字面串或一个内联正则。
 *
 * 为什么允许内联正则 (而不是全走字符串): 有些判据必须带**位置约束**才能避免误报 ——
 * 例如祈使否定只认"句首或标点之后的不要/别", 纯字面包含会把正文里的"那段代码不要了"也算上。
 * 类型上区分 (而不是运行时嗅探字符串) 让"这一条是正则"成为**编译期可见**的事实。
 */
export type NegativityWord = string | RegExp;

/**
 * 缺省词表。**按类别分组**而不是揉成一个数组 —— 类别就是语义, 揉在一起就再也分不开了。
 *
 * 收录依据: 用户 2026-10-05 明确给出的三类用语 + 真库里实测出现过的变体
 * (见本文件头注的 27 条样本)。**只收"指向 agent 自身"的用法**, 不收泛化的脏话 ——
 * "这个 bug 真操蛋"骂的是代码, 不是 agent 的行为, 混进来会把噪声当信号。
 */
export const DEFAULT_NEGATIVE_WORDS: Readonly<Record<NegativeKind, readonly NegativityWord[]>> = {
  // "你这个做法是错的" —— 针对**方案/实现**。
  "blame-method": [
    "傻逼", "傻b", "沙比", "傻B",
    "蠢驴", "蠢牛", "蠢货", "蠢死", "真蠢", "太蠢",
    "废物", "垃圾", "狗屁", "废话", "胡扯", "瞎搞", "乱搞",
    "脑残", "智障", "弱智", "有病", "神经病",
    "你行不行", "你会不会", "你能不能行",
  ],
  // "我对你的执行非常不满" —— 针对**过程/态度** (含脏话, 但落点仍是 agent 的行为)。
  "blame-execution": [
    "操你妈", "草你妈", "艹你妈", "操尼玛", "操你",
    "你他妈", "他妈的", "妈的", "你妈",
    "去死", "滚蛋", "给我滚", "别干了",
    "fuck you", "stfu",
  ],
  // 纠正性陈述 —— 用户没骂, 但明确说了"你做错了 / 应该是什么"。
  "correction": [
    "错了", "搞错", "弄错", "不对",
    "不是这样", "不是这个", "不是这意思", "我不是这个意思",
    "我说的是", "我的意思", "我是说",
    "应该是", "应当", "改成", "重来",
    "你理解错", "没理解", "没懂我",
    "又错", "还是错", "已经说过了", "说过多少次",
    // 祈使式禁令也是纠正 (它在说"你这个做法不对, 改成这样")。这与 capture/engine 的
    // DIRECTIVE_PATTERNS 是**不同判据**: 那里决定"落成什么 kind", 这里决定"算不算负面信号",
    // 两条判据指向同一个真实现象, 但服务两个决策 —— 合并会让其中一处的语义被另一处绑架。
    /(?:^|[ \t，,。；;！!？?\n])(?:不要|别|禁止|严禁|不准)[^ \t，,。；!？?\n]{2,}/,
  ],
};

/** 编译后的词表 (一次性; 调用方缓存它, 不要每条文本重编)。 */
export interface CompiledNegativity {
  entries: ReadonlyArray<{ kind: NegativeKind; source: string; test: (text: string) => string | null }>;
  /** 无法编译的条目 (坏正则) —— 可观测: 静默丢弃会让"我明明配了它却不生效"无从排查。 */
  invalid: readonly string[];
}

/**
 * 编译词表。
 *
 * 判据: 以 `/` 开头**且**以 `/` 结尾 (长度 > 2) 的条目按**正则**编译, 其余按**字面**包含。
 * 字面匹配大小写不敏感 (拉丁词表里 `fuck you` 与 `FUCK YOU` 同义)。
 */
export function compileNegativity(
  words: Partial<Record<NegativeKind, readonly NegativityWord[]>> = DEFAULT_NEGATIVE_WORDS,
): CompiledNegativity {
  const entries: Array<{ kind: NegativeKind; source: string; test: (text: string) => string | null }> = [];
  const invalid: string[] = [];
  for (const kind of Object.keys(words) as NegativeKind[]) {
    for (const raw of words[kind] ?? []) {
      // 内联 RegExp (缺省词表里的位置约束型条目): 直接用, 不做字符串解析。
      if (raw instanceof RegExp) {
        const re = raw;
        entries.push({ kind, source: String(re), test: (text) => re.exec(text)?.[0] ?? null });
        continue;
      }
      const source = String(raw).trim();
      if (!source) continue;
      const isRegex = source.length > 2 && source.startsWith("/") && source.endsWith("/");
      if (isRegex) {
        let re: RegExp;
        try {
          re = new RegExp(source.slice(1, -1), "i");
        } catch {
          // 坏正则跳过: 一个手滑的括号不该让整份词表失效。
          invalid.push(source);
          continue;
        }
        entries.push({ kind, source, test: (text) => re.exec(text)?.[0] ?? null });
        continue;
      }
      const lower = source.toLowerCase();
      entries.push({
        kind,
        source,
        test: (text) => {
          const at = normalizeVoice(text).toLowerCase().indexOf(lower);
          return at < 0 ? null : text.slice(at, at + source.length);
        },
      });
    }
  }
  return { entries, invalid };
}

/** 词表条目数 (编译期校验用)。 */
export function negativityWordCount(compiled: CompiledNegativity): number {
  return compiled.entries.length;
}

/**
 * 判定一段文本里的负面信号。
 *
 * ⚠ **先做语音归一** (与意图判定同一口径): 用户用语音输入, "沙比"/"傻b" 这类变体
 * 在字面上对不上词表 —— 而它们表达的是同一件事。归一表见 kernel/voice.ts。
 *
 * 命中即返回 (不看等级)。未命中返回 `NO_NEGATIVE` (同一个常量, 便于 `===` 判断)。
 */
export function detectNegative(
  rawText: string,
  compiled: CompiledNegativity = compileNegativity(),
): NegativeSignal {
  const text = normalizeVoice(rawText);
  if (!text.trim()) return NO_NEGATIVE;
  const hits: NegativeHit[] = [];
  const kinds: NegativeKind[] = [];
  for (const entry of compiled.entries) {
    const matched = entry.test(text);
    if (matched === null) continue;
    hits.push({ kind: entry.kind, matched });
    if (!kinds.includes(entry.kind)) kinds.push(entry.kind);
  }
  if (!hits.length) return NO_NEGATIVE;
  // 重复计数: 同一个词出现多次也是"同一类", 但它是**升级信号** (用户重复被激怒)。
  const repeat = hits.length > kinds.length;
  const abusive = kinds.some((k) => k === "blame-method" || k === "blame-execution");
  const corrected = kinds.includes("correction");
  const level = abusive && corrected ? 3 : kinds.length > 1 || repeat ? 2 : 1;
  return {
    hit: true,
    kinds,
    hits,
    level,
    reason:
      "命中负面信号 (" +
      kinds.join("+") +
      (repeat ? ", 有重复" : "") +
      "): " +
      hits
        .slice(0, 4)
        .map((h) => h.matched)
        .join("/"),
  };
}

/**
 * 从用户的话里抽**方向** —— "被骂之后该记住什么"。
 *
 * 为什么不能只记"被骂了": 那句话没有可执行内容, 下次照样犯。
 * 方向的来源按可靠性排序:
 *   1. 祈使/否定式的行为要求 ("不要每次都在本桌面启动浏览器" / "先跑测试再改代码");
 *   2. 纠正句里 "应该是/我说的是/改成" 之后的片段;
 *   3. 都没有时返回空串 —— **不许编** (编出来的方向比没有更糟)。
 *
 * 这是**廉价规则**, 不是理解: 它的产物只是"记忆条目的初稿正文", 仍要过结构化器与人审。
 */
export function directionOf(rawText: string, compiled?: CompiledNegativity): string {
  const text = normalizeVoice(rawText).replace(/\s+/g, " ").trim();
  if (!text) return "";
  // ⚠ 抽出的"方向"如果**自身就是一句骂** ("别这么傻逼"), 那它不是方向 ——
  // 落成"用户纠正: 别这么傻逼"比不落更糟 (它把脏话换了个包装又进了库)。
  const isAbuse = (s: string): boolean => {
    const t = detectNegative(s, compiled ?? compileNegativity());
    return t.kinds.some((k) => k === "blame-method" || k === "blame-execution");
  };
  // ① 纠正句: 取"应该是/我说的是/我的意思/改成"之后的内容。
  const after =
    /(?:应该是|应当|我说的是|我的意思是|我的意思|我是说|改成|要改成)[:：,，]?\s*([^。！？!?；;\n]{2,80})/.exec(
      text,
    );
  if (after?.[1] && !isAbuse(after[1])) return after[1].trim();
  // ② 祈使否定 + 行为对象: "不要每次都…" / "别再…" / "不许…"。
  const forbid =
    /(?:不要|别|禁止|严禁|不准|别总是|别再)[^。！？!?；;\n]{2,80}/.exec(text);
  if (forbid?.[0] && !isAbuse(forbid[0])) return forbid[0].trim();
  // ③ 频次/顺序要求: "先…再…" / "每次都要…"。
  const order = /(?:先[^。！？!?；;\n]{2,40}再[^。！？!?；;\n]{2,40}|每次都[^。！？!?；;\n]{2,60})/.exec(
    text,
  );
  if (order?.[0] && !isAbuse(order[0])) return order[0].trim();
  return ""; // 编不出来就说编不出来
}

/**
 * 解析用户配置的多行词表 (设置项 `negativityWords`)。
 *
 * 格式约定 (与面板里"一行一条"的直觉一致):
 *   · 空行与 `#` 开头的行忽略 (让用户能写注释与分组);
 *   · `blame-method:` / `blame-execution:` / `correction:` 开头的行**切换当前类别**;
 *   · 其余非空行是**条目** (字面串或 `/正则/`), 归入当前类别;
 *   · 没有任何类别头时, 全部条目归入 …**不猜** —— 返回错误说明, 让用户改格式。
 *     (猜错类别会让"方法错"与"执行不满"混成一类, 那正是本模块要分开的东西。)
 *
 * 语义: 配置**替换**该类别的缺省词表, 而不是追加 —— "我知道该怎么判" 与 "帮我兜底"
 * 是两种意图, 混在一处会让"我删掉了傻逼但它还在命中"变成不可解释的现象。
 * 想追加就写全 (从面板的默认值复制一份再改)。
 */
export function parseNegativityWords(text: string): {
  words: Partial<Record<NegativeKind, readonly NegativityWord[]>>;
  error?: string;
} {
  const words: Partial<Record<NegativeKind, string[]>> = {};
  let current: NegativeKind | null = null;
  const kinds: NegativeKind[] = ["blame-method", "blame-execution", "correction"];
  const kindsAlt = kinds.join("|");
  // 两种写法都支持, 因为它们服务两个不同的输入控件:
  //   · **多行** (面板里的文本框): 一行一个类别头, 之后每行一条词 —— 好读、好加注释;
  //   · **紧凑单行** (表单里的普通输入框): `类别:词1,词2;类别:词3` —— 用 `;` 分段。
  // 判据是"有没有换行": 没有换行时按 `;` 切段, 每段再按"类别头 + 逗号列表"解析。
  const chunks = text.includes("\n")
    ? text.split("\n")
    : text.split(/[;；]/).flatMap((c) => c.split(/\s*\|\s*/));
  for (const raw of chunks) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const head = new RegExp("^(" + kindsAlt + ")\\s*[:：]\\s*(.*)$").exec(line);
    if (head) {
      current = head[1] as NegativeKind;
      words[current] ??= [];
      // 类别头同行也可以带条目: "correction: 错了, 不对"
      if (head[2]) for (const w of head[2].split(/[,，、]/).map((x) => x.trim()).filter(Boolean)) words[current]!.push(w);
      continue;
    }
    if (!current) {
      return {
        words: {},
        error:
          "负面词表格式错误: 有效条目之前缺少类别头。多行写法先写一行 `blame-method:` / " +
          "`blame-execution:` / `correction:` 再列条目; 单行写法用 `;` 分段, 例如 " +
          "`blame-method:狗屎,烂活;correction:错了,不对`。可用类别: " +
          kinds.join(", "),
      };
    }
    words[current]!.push(line);
  }
  // 全空 = 未配置 (调用方退回缺省词表), 不是错误。
  if (Object.keys(words).length === 0) return { words: {} };
  return { words };
}

/** 把解析结果与缺省词表合并: 配了的类别**替换**, 没配的类别保留缺省。 */
export function mergeNegativityWords(
  parsed: Partial<Record<NegativeKind, readonly NegativityWord[]>>,
): Partial<Record<NegativeKind, readonly NegativityWord[]>> {
  if (!Object.keys(parsed).length) return DEFAULT_NEGATIVE_WORDS;
  return {
    "blame-method": parsed["blame-method"] ?? DEFAULT_NEGATIVE_WORDS["blame-method"],
    "blame-execution": parsed["blame-execution"] ?? DEFAULT_NEGATIVE_WORDS["blame-execution"],
    correction: parsed.correction ?? DEFAULT_NEGATIVE_WORDS.correction,
  };
}
