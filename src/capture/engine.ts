// src/capture/engine.ts — 捕获引擎: 把一轮对话 (turn) 转成结构化记忆条目。
// 纯内核逻辑 (S1): 无网络, 无 harness, 无存储依赖 (只依赖 kernel/types)。
//
// 设计:
//   - 捕获分两级: 显式 ("记住 X") 与 隐式 (决策/教训/偏好信号)。
//   - 本级不用 LLM 抽取 (成本与不确定性); 用规则信号推断 kind, 确定性可测。
//   - 去重靠内容指纹 (contentHash): 相同内容不重复沉淀。
//   - 双时态: validAt = 事实生效时间 (可指定), assertedAt = 捕获时间。
import { createHash } from "node:crypto";
import { hasSubstantiveOutput } from "./output-signal.ts";
import type { MemoryEntry, MemoryKind, MemoryScope } from "../kernel/types.ts";
import { NO_NEGATIVE } from "../kernel/negativity.ts";
import {
  EXPLICIT_PATTERNS,
  CONCLUSION_SIGNALS,
  WEAK_CLOSURE_SIGNALS,
  inferKind,
  type CaptureNegativity,
} from "./signals.ts";
// 这些判据的实现搬到了 signals.ts (§710 行数上限); 转出去让既有 import 不被打断
// (对外 API 一字不变 —— 搬运实现不该改变依赖图的形状)。
export {
  EXPLICIT_PATTERNS,
  LESSON_SIGNALS,
  DECISION_SIGNALS,
  PREFERENCE_SIGNALS,
  RULE_SIGNALS,
  DIRECTIVE_PATTERNS,
  CONCLUSION_SIGNALS,
  WEAK_CLOSURE_SIGNALS,
  inferKind,
  type CaptureNegativity,
} from "./signals.ts";

export interface TurnInput {
  text: string;
  /**
   * 同一轮**助手的回答**。
   *
   * 为什么必须一起给: 结论、理由与"为什么这么问"都长在回答里, 只喂用户那句等于
   * 让抽取器看着问题猜答案 (实测: 旧路径下 15% 的记忆是疑问句本身, 助手侧一条都没进)。
   */
  answer?: string;
  project?: string;
  session: string;
  occurredAt?: string;
  /** 该轮对话对应的 episode id (有则写进 derivedFrom —— 支撑抽取级重建与溯源)。 */
  episodeIds?: string[];
}

/** 一段耗时 (毫秒, 已取整)。名字就是它测的东西, 不做二次解释。 */
export interface CaptureTiming {
  /** episode 原文追加 (两条: 用户 + 助手)。 */
  episodeMs: number;
  /**
   * 结构化器耗时 (真实 LLM 调用 / 启发式兜底)。
   *
   * ⚠ **它是被截断的** (2026-09-18, §571 实测): `llm-agent.ts` 对 LLM 调用设了**硬超时**
   * (`llm-structurer.ts` 传 10000ms), 超时即拒绝 ⇒ **这一轮的耗时记的是"时限"而不是真实值**。
   *
   * 真库实测 (45 个有耗时的轮次): 37 个在 258~8666ms **分散**, 而 **8 个挤在 10000~10002ms**
   * —— 那个 2ms 窗口就是截断特征。**⇒ 那 8 轮的真实耗时不可知, 只能说 ≥10s。**
   *
   * 后果: **"有多少轮被时限牺牲"这个问题无法从本字段直接回答** (只能给出下界)。
   * 要测真实耗时需要在超时后**单独记录一次"未截断"的测量**, 或把时限调高再看分布是否右移。
   */
  enrichMs: number;
  /** 结构关联建边 (要读全库做共现比较)。 */
  linkMs: number;
  /** 存储写入 (同步 SQLite + 真相文件)。 */
  storeMs: number;
  /** 本轮捕获占用的总时间。 */
  totalMs: number;
}

/**
 * 捕获结束的回调 (成功与失败都会调一次)。
 *
 * 为什么由调用方注入而不是 pipeline 自己落盘: 分段耗时只有 pipeline 知道 (它才知道
 * enrich/link/store 各自花了多久), 而"这条属于哪个会话/第几轮/哪个项目"只有 adapter 知道。
 * pipeline 只**测量并回报**, 记到哪由适配层决定 —— 内核因此不必知道日志格式。
 */
export type CaptureTimingReporter = (timing: CaptureTiming, result: CaptureResult) => void;

export interface CaptureOptions {
  mode?: "auto" | "explicit" | "off";
  forceKind?: MemoryKind;
  /**
   * 负面/纠正信号判定 (可选)。
   *
   * 给了它时: 命中负面信号的轮次落成 `lesson`, 且 content 换成"教训草稿"而不是用户原话
   * (真库实测 27 条辱骂原话进库就是缺这一层)。不传 = 关闭该路径, 行为与接入前逐字一致。
   */
  negativity?: CaptureNegativity;
  /**
   * 捕获结束时的耗时回报 (由 pipeline.run 在**每一条**路径上恰好调一次)。
   * engine 自己不做测量 —— 它只负责把调用方传进来的上游耗时透传下去,
   * 这样"一段耗时的唯一来源"就不会因为多一条返回路径而分叉。
   */
  onTiming?: CaptureTimingReporter;
  /**
   * 调用方在本轮进 engine **之前**已经花掉的原文追加耗时 (episode 写入)。
   * 放在这里而不是让 pipeline 自己计时: episode 是 runtime 写的, 它才知道那一段。
   */
  episodeMs?: number;
}

export interface CaptureResult {
  entries: MemoryEntry[];
  deduped: number;
  signal: string;
  /**
   * 被**提炼闸门**丢掉的条数 (问句开头 + 结构化器读不出结论)。
   *
   * 为什么与 deduped 分开: 两者都表现为"库里没多出条目", 但成因相反 ——
   * 一个是"这一轮没有可沉淀的结论", 一个是"早就存过了"。调用方 (账本/面板)
   * 要解释"为什么没沉淀", 把两者混在一个计数里就等于没解释。
   * engine 不产它 (它为 0), 由 pipeline 在闸门处累加。
   */
  noConclusion?: number;
  /**
   * 本轮的结构化**是否来自"能出结论的实现"** (`TurnStructurer.canConclude`)。
   *
   * 为什么记它 (2026-09-18): 捕获账本此前**没有这个信号** —— 于是"结构化器的 10 秒时限
   * 该不该调"这个问题**无法判定**: 从 `enrichMs` 只能看出"调了多久", 看不出
   * "超时后回退到启发式、沉淀质量是否变差"。
   *
   * 与 `enrichMs` 互补: 后者是**耗时**, 它是**路径**。两者一起才能算"某时限下
   * 有多少轮被截断、其中多少仍沉淀"。
   *
   * **三态** (缺省 \`undefined\` 与 \`false\` 语义不同):
   *   · \`undefined\` —— 本轮**没走过 enrich** (连条目都没产生);
   *   · \`false\` —— 走过 enrich, 但**没得到结论能力** (启发式兜底 / LLM 超时或失败);
   *   · \`true\` —— 至少一次 enrich 来自能出结论的实现。
   *
   * 为什么必须区分前两者: "没调 LLM" 与 "调了但失败" 对"时限该不该调"的判定完全不同 ——
   * 混成一个值会让统计把两者一起算, 而那正是要分开看的。
   */
  concludeCapable?: boolean;
  /**
   * 进**审核队列**的条数 (候选可疑, 待人裁决)。
   *
   * ⚠ **2026-10-05 语义已反转**: 队列成员**已经落盘** —— 它是"入库之后可被剔除的待办",
   * 不是"拦住不让入库"。因此本字段的含义从"这条没能进库"变成"这条进了库, 但被人审标记过"。
   * 与 noConclusion/deduped 仍要分开: 后两者是"这一轮没有条目", 本字段是"有条目且已入库"。
   */
  reviewQueued?: number;
  /**
   * 本轮命中的**负面/纠正信号** (可选; 未注入词表时为 undefined)。
   *
   * 为什么必须回报而不是让调用方自己再判一次: 判定只在 engine 里做一次 (单一判据),
   * 账本/pipeline/面板都读这一个结果 —— 各判一遍必然分叉 (本仓反复踩过的坑)。
   */
  negative?: { kinds: string[]; level: number };
}

export function isInterrogative(text: string): boolean {
  const head = text.slice(0, 160);
  if (/[?？]/.test(head)) return true;
  return /(吗|呢|怎么|为什么|为何|如何|是不是|能不能|可不可以|要不要|对不对|行不行)[。！!？?\s]?$/.test(
    head.trim(),
  );
}

/**
 * 用户在提问之后**自己敲定**了的信号 (采纳/确认/落地)。
 *
 * ⚠ 2026-09-18 收紧 (独立盲审指出 + 我方复现): 原判据过宽, 是"用户原话被当记忆"的直接来源 ——
 * 实测真库里 content 与某条用户提问**完全相等**的自动捕获条目有 29 条 (18%)。
 * 三条具体修正 (每条都有实测反例):
 *
 *   T1 裸词 "采用": 实测 "刷新请采用局部更新" 被判 decision —— 那是**需求描述**,
 *      不是"用户采纳了方案"。修正: 要求**主体与决策语境** ("我/我们 + 采用/采纳"), 或明确的收束语。
 *   T2 无主语的 "修好了/生效/完成": 实测 "确实修好了"、"仅对住宅链路生效" 都落成 decision,
 *      但它们可能是在描述别的东西。修正: 要求**收束形态** (句末, 或后接"了/吧/的"等语气收尾),
 *      而不是句中任意位置出现。
 *   T3 确认词过宽: 实测 "好的"、"可以"、"没问题" 单句即落 decision, content 就是这两个字 ——
 *      这是**纯确认**, 没有任何可沉淀的内容。修正: 确认词必须与**实质内容共现**才成立
 *      (单独一句确认不构成"结论"); 用"整句只是确认词"来排除。
 */
/** 该轮是否产出结论 (用户认可 / 事情落地)。 */
export function hasConclusionSignal(text: string, answer?: string): boolean {
  if (CONCLUSION_SIGNALS.some((p) => p.test(text))) return true;
  // 弱信号: 需要"本轮有实质产出"共现才作数 (消解"描述 vs 决策"的同形歧义)。
  return WEAK_CLOSURE_SIGNALS.some((p) => p.test(text)) && hasSubstantiveOutput(answer ?? "");
}

function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

function extractExplicit(text: string): string | null {
  for (const p of EXPLICIT_PATTERNS) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function shouldCapture(text: string, kind: MemoryKind, mode: CaptureOptions["mode"]): boolean {
  if (mode === "off") return false;
  if (kind === "fact") return true;
  if (mode === "explicit") return false;
  if (kind === "context") return false;
  return true;
}

// ⚠ **nowIso 的唯一实现在 storage/entry-normalize.ts** (§707): 它此前在三个文件里逐字相同
// (本文件 / episode-store / entry-normalize)。统一后这里保留 re-export —— 既有 import 不被打断。
import { nowIso } from "../storage/entry-normalize.ts";
export { nowIso };

/**
 * 把一轮对话捕获为记忆条目。纯函数 (除时间戳外无副作用)。
 * 返回 0 条的情况: off 模式 / 无信号 / 内容与已有指纹重复。
 */
export function captureTurn(
  input: TurnInput,
  opts: CaptureOptions = {},
  existingHashes: ReadonlySet<string> = new Set(),
): CaptureResult {
  const text = input.text.trim();
  if (!text) return { entries: [], deduped: 0, signal: "empty" };
  const mode = opts.mode ?? "auto";
  if (mode === "off") return { entries: [], deduped: 0, signal: "off" };

  const explicit = extractExplicit(text);
  const interrogative = isInterrogative(text);
  const concluded = !explicit && hasConclusionSignal(text, input.answer);
  const hasAnswer = Boolean(input.answer?.trim());
  // 负面/纠正信号 (可配置词表; 未注入时不参与任何判定)。
  const negative = explicit ? NO_NEGATIVE : (opts.negativity?.detect(text) ?? NO_NEGATIVE);

  // 结论闸门 (必须排在 context 过滤**之前**): 只有问题、后面什么都没有的轮次没有可沉淀的
  // 结论, 存下来就是转录 —— 实测这类占了 15%。
  //
  // ⚠ 负面信号轮次**不走这道闸门** (2026-10-05): "你傻逼" 单独一句也是"被纠正过"的事实,
  // 而它的价值不在"有结论", 在"下次别再犯"。旧代码在这里把它连同其它问句一起丢掉,
  // 代价是"被骂了但什么都没记" —— 那正是用户实测抱怨的那件事。
  if (!explicit && !negative.hit && interrogative && !concluded && !hasAnswer) {
    return { entries: [], deduped: 0, signal: "no-conclusion:question" };
  }

  // kind 推断: "用户自己敲定了" (结论信号) 但没命中其它信号时, 它至少是一条 decision,
  // 不该被当成闲聊 context 丢掉 (自问自答 "那就用 A 吧" 就属于这种)。
  const inferred = explicit ? "fact" : inferKind(text, opts.negativity);
  const kind = opts.forceKind ?? (concluded && inferred === "context" ? "decision" : inferred);

  // 越过 context 过滤的两个条件 (2026-09-18 修正; 此前只有前者):
  //
  // ① 带回答的疑问句: 结论长在回答里, 由结构化器判定有没有 (原逻辑, 保留)。
  // ② **本轮产出实质内容**: 与问句形态无关地放行。
  //
  // 为什么必须补 ② (独立盲审 + 我方复现的结构性缺陷): 原判据只看**用户措辞**,
  // 于是 "next"/"fix"/"继续啊" 这类极短指令**必被丢弃** —— 即使回答里有根因、文件路径、
  // 端口、错误码。实测 "next" 配 89 字符含根因的回答, 与配空回答得到**逐字相同**的结果。
  // 真库 229 轮中 202 轮被丢, 其中被判据丢掉的 131 轮含 41.1 万字符助手输出。
  // 判据应当回答"这一轮产出了什么", 而不是"用户那句话像不像要记的样子"。
  //
  // 为什么用 answer 而不是放宽 text 匹配: 放宽措辞匹配会同时放进"用户闲聊但措辞像约束"的噪声;
  // 而按**产出**放行只多收"确实干了活"的轮次 —— 且它们仍要过结构化器的结论闸门。
  //
  // ⚠ ③ **负面信号轮次放行且优先于 context 过滤** (2026-10-05): 与 ② 相反, 这条**不要求**
  // 本轮有产出 —— 骂人本身就是信息 (它指向一个失败), 而这条路径落的是 lesson 不是原话,
  // 因此"没有产出也放行"不会污染库 (旧行为下它有产出才放行, 结果落的是原话, 反而更糟)。
  const substantive = hasSubstantiveOutput(input.answer, text);
  const bypassContext =
    negative.hit || (!explicit && (interrogative || substantive) && hasAnswer);
  if (!bypassContext && !shouldCapture(text, kind, mode))
    return { entries: [], deduped: 0, signal: "no-signal:" + kind };

  // ⚠ **内容不是用户原话** (2026-10-05): 命中负面信号时落"教训草稿" ——
  // 形态固定为 "禁止<做法>。改为: <改法>。" / "必须<做法>。" (读者是下一轮的我, 不是旁观者)。
  // 真库实测 27 条辱骂原话就是缺这一步 —— 而第一版写成 "用户对XX不满" 被用户否决 ("记这个有个屁用")。
  const content =
    explicit ?? (negative.hit ? opts.negativity!.lessonDraft(negative, text) : text);
  const hash = contentHash(content);
  if (existingHashes.has(hash)) return { entries: [], deduped: 1, signal: "duplicate:" + hash };

  const scope: MemoryScope = input.project ? "project" : "agent";
  const occurredAt = input.occurredAt ?? nowIso();
  const entry: MemoryEntry = {
    id: "c" + hash,
    kind,
    content,
    source: "session:" + input.session,
    scope,
    ...(input.project ? { project: input.project } : {}),
    ts: { validAt: occurredAt, assertedAt: nowIso() },
    // 血缘: 这条记忆是从哪一轮原文抽出来的 (用户问 + 助手答, 换抽取器时按 episode 重放)。
    ...(input.episodeIds?.length ? { derivedFrom: input.episodeIds } : {}),
  };
  return {
    entries: [entry],
    deduped: 0,
    signal: kind + ":" + hash,
    ...(negative.hit ? { negative: { kinds: negative.kinds, level: negative.level } } : {}),
  };
}