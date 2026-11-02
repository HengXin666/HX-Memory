// app/memory-quality.ts — 每条记忆的「沉淀质量」判定 (纯函数, 无 IO)。面板的记忆页 / 质量总览用它。
//
// 为什么需要它 (2026-11-01, 用户原话: "这不应该显示的是你经过上下文推导之后存储下来的总结吗? 这才叫做记忆啊,
// 而不是说用户说的每一句话 … 那我怎么知道你沉淀的东西的效果是如何的呢?")。
// 真库实测: active 的 context 663 条里, 一半是用户原话被原样存下 ("对的，更详细的" / "傻逼" / "B")。
// 它们和 lesson/decision 这种推导出来的结论混在一起按时间排, 用户看不出沉淀有没有效果。
//
// ## 判据 (context 才需要判; 其它 kind 本来就是推导出的沉淀, doc 是知识库切片)
//
// 一条 context 算「推导沉淀」, 当且仅当满足其一:
//   A. content 就是结构化器给出的 conclusion (structured.conclusion === content)。
//      这是最硬的信号: 只有 LLM 结构化器读完一轮问答、给出结论时, pipeline 才会用结论替换原文
//      (src/capture/pipeline.ts enrich: `...(conclusion ? { content: conclusion } : {})`)。
//      真库: 325 / 663 条满足。
//   B. 长度 >= 40, 带提炼结构词 (根因 / 起因 / 改为 / 结论 / 确认 / 判定 / 决定 / 导致 / 实测 / 而非 / ：…),
//      且第一、二人称 (你 / 我) 不超过 1 次  第三人称陈述句, 是对事实的总结而不是对助手说的话。
// 其余一律是「用户原话」(raw), 并细分原因:
//   · short    长度 < 40 (含 ≤20 字的「低质」);
//   · filler   纯指令词 / 单句附和 (对的 / 好的 / 继续 / next / yes …);
//   · command  命令行、链接、路径、贴进来的终端输出 (以 / http [ ` ~ ╰ 开头);
//   · conversational  对助手说话的口吻 (你/我/吧/啊/吗/？) 且没有提炼结构;
//   · unstructured    既不像对话也没有提炼结构的原文。
//
// 为什么用户提的「>= 40 字且有实质内容」我只拿来做 B 的一部分: 实测有 117 条 >= 40 字的 context
// 是长段的用户原话 (例如「你这输出还是有问题啊! 为什么我说话说着说着…」), 只看长度会把它们算成沉淀。
// 抽样核对 (seed 7, 两边各 15 条): A/B 判为沉淀的 15 条里 1 条其实是原话 (结构化器把原话当成了结论);
// 判为原话的 15 条全对。
import type { MemoryEntry } from "../kernel/types.ts";

export type MemoryOrigin = "derived" | "raw" | "kb";
export type RawReason = "short" | "filler" | "command" | "conversational" | "unstructured";

export interface MemoryQuality {
  origin: MemoryOrigin;
  /** 来源的中文标签 (面板直接显示)。 */
  originLabel: string;
  /** 有没有经过提炼 (结构化结论 / 提炼结构词)。 */
  refined: boolean;
  /** 命中的提炼结构词 (最多 4 个; 面板展示「为什么算提炼」)。 */
  refineMarks: string[];
  length: number;
  /** ≤ 20 字。 */
  low: boolean;
  /** 原话的细分原因 (只有 origin = raw 时有)。 */
  rawReason?: RawReason;
  /** 一句话依据。 */
  why: string;
}

export const QUALITY_MIN_LEN = 40;
export const LOW_QUALITY_LEN = 20;

const FILLER = /^(对的?|好的?|行|可以|嗯+|是的?|继续|下一步|next|yes|ok|fix|go|没问题|收到|谢谢|都来|[a-d])([，,。.!！\s].{0,12})?$/i;
const COMMAND = /^\s*(\/|https?:\/\/|\[|pw=|`|~|╰|\d{3,}\s+\w)/;
const CONVERSATIONAL = /(^|[，。,；;\s!！])(你|我|咱们|帮我|给我|麻烦|请问?)|[吧啊呢吗呀哦嘛]([，。,！!？?\s]|$)|[？?]/;
const REFINE = /(起因|改为|改成|根因|原因是|结论|确认|判定|决定|教训|因此|导致|修法|已修|不再|禁止|必须|应当|而非|取舍|根本|实测|实为|：)/g;

const ORIGIN_LABEL: Record<MemoryOrigin, string> = { derived: "推导出的沉淀", raw: "用户原话", kb: "知识库切片" };

type QualityInput = Pick<MemoryEntry, "kind" | "content"> & { structured?: MemoryEntry["structured"] };

export function qualityOf(e: QualityInput): MemoryQuality {
  const text = String(e.content ?? "").trim();
  const length = [...text].length;
  const low = length <= LOW_QUALITY_LEN;
  const marks = [...new Set(text.match(REFINE) ?? [])].slice(0, 4);
  const conclusion = String((e.structured as { conclusion?: unknown } | undefined)?.conclusion ?? "").trim();
  const base = { length, low, refineMarks: marks };
  if (e.kind === "doc") return { ...base, origin: "kb", originLabel: ORIGIN_LABEL.kb, refined: false, why: "外部文档切片, 不是对话沉淀" };
  if (e.kind !== "context") {
    return { ...base, origin: "derived", originLabel: ORIGIN_LABEL.derived, refined: Boolean(conclusion) || marks.length > 0, why: e.kind + " 由提炼/确认路径写入" };
  }
  const raw = (rawReason: RawReason, why: string): MemoryQuality => ({ ...base, origin: "raw", originLabel: ORIGIN_LABEL.raw, refined: false, rawReason, why });
  if (conclusion && conclusion === text) {
    return { ...base, origin: "derived", originLabel: ORIGIN_LABEL.derived, refined: true, why: "内容就是结构化器给出的结论" };
  }
  if (FILLER.test(text)) return raw("filler", "纯指令词 / 单句附和");
  if (COMMAND.test(text)) return raw("command", "命令 / 链接 / 路径 / 终端输出");
  if (length < QUALITY_MIN_LEN) return raw("short", `不足 ${QUALITY_MIN_LEN} 字`);
  const persons = (text.match(/[你我]/g) ?? []).length;
  if (marks.length && persons <= 1) {
    return { ...base, origin: "derived", originLabel: ORIGIN_LABEL.derived, refined: true, why: "第三人称陈述 + 提炼结构词" };
  }
  if (CONVERSATIONAL.test(text)) return raw("conversational", "对助手说话的口吻, 没有提炼结构");
  return raw("unstructured", "原文, 没有提炼结构");
}

export interface QualitySummary {
  total: number;
  byKind: Record<string, { total: number; derived: number; raw: number; low: number }>;
  derived: number;
  raw: number;
  low: number;
  rawByReason: Record<string, number>;
  context: { total: number; raw: number; low: number; rawShare: number };
  /** 一句话结论。 */
  verdict: string;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** 质量总览: 只统计对话沉淀 (doc 不算)。 */
export function summarizeQuality(entries: readonly QualityInput[]): QualitySummary {
  const byKind: QualitySummary["byKind"] = {};
  const rawByReason: Record<string, number> = {};
  let derived = 0;
  let raw = 0;
  let low = 0;
  let total = 0;
  for (const e of entries) {
    if (e.kind === "doc") continue;
    total++;
    const q = qualityOf(e);
    const k = (byKind[e.kind] ??= { total: 0, derived: 0, raw: 0, low: 0 });
    k.total++;
    if (q.origin === "raw") {
      k.raw++;
      raw++;
      rawByReason[q.rawReason ?? "unstructured"] = (rawByReason[q.rawReason ?? "unstructured"] ?? 0) + 1;
    } else {
      k.derived++;
      derived++;
    }
    if (q.low) {
      k.low++;
      low++;
    }
  }
  const c = byKind.context ?? { total: 0, derived: 0, raw: 0, low: 0 };
  const verdict =
    `${total} 条对话沉淀里, 推导出的沉淀 ${derived} 条 (${pct(derived, total)}%), 用户原话 ${raw} 条 (${pct(raw, total)}%)。` +
    ` context ${c.total} 条里 ${c.raw} 条是原话 (${pct(c.raw, c.total)}%), 其中 ≤${LOW_QUALITY_LEN} 字的 ${c.low} 条。`;
  return { total, byKind, derived, raw, low, rawByReason, context: { total: c.total, raw: c.raw, low: c.low, rawShare: pct(c.raw, c.total) }, verdict };
}
