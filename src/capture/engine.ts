// src/capture/engine.ts — 捕获引擎: 把一轮对话 (turn) 转成结构化记忆条目。
// 纯内核逻辑 (S1): 无网络, 无 harness, 无存储依赖 (只依赖 kernel/types)。
//
// 设计:
//   - 捕获分两级: 显式 ("记住 X") 与 隐式 (决策/教训/偏好信号)。
//   - 本级不用 LLM 抽取 (成本与不确定性); 用规则信号推断 kind, 确定性可测。
//   - 去重靠内容指纹 (contentHash): 相同内容不重复沉淀。
//   - 双时态: validAt = 事实生效时间 (可指定), assertedAt = 捕获时间。
import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryKind, MemoryScope } from "../kernel/types.ts";

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

export interface CaptureOptions {
  mode?: "auto" | "explicit" | "off";
  forceKind?: MemoryKind;
}

export interface CaptureResult {
  entries: MemoryEntry[];
  deduped: number;
  signal: string;
}

const EXPLICIT_PATTERNS: RegExp[] = [
  /记住[:：]?\s*(.+)/,
  /记一下[:：]?\s*(.+)/,
  /记到记忆里[:：]?\s*(.+)/,
  /记住这个[:：]?\s*(.+)/,
  /记下[:：]?\s*(.+)/,
];

const LESSON_SIGNALS: RegExp[] = [
  /踩坑|教训|不要再|下次要|注意并发|注意幂等|注意超时/,
  /concurrency|idempoten|race condition|timeout|deadlock/i,
];

const DECISION_SIGNALS: RegExp[] = [
  /决定|采用|选择|改用|替换为|方案是|定稿|decided|chose|switch to/i,
];

const PREFERENCE_SIGNALS: RegExp[] = [/更喜欢|偏好|倾向|prefer|约定|规范是|习惯/];

const RULE_SIGNALS: RegExp[] = [
  /以后都要|以后必须|规则|不变量|invariant|所有容器|所有服务|所有系统/,
];

function inferKind(text: string): MemoryKind {
  if (EXPLICIT_PATTERNS.some((p) => p.test(text))) return "fact";
  if (RULE_SIGNALS.some((p) => p.test(text))) return "pattern";
  if (LESSON_SIGNALS.some((p) => p.test(text))) return "lesson";
  if (DECISION_SIGNALS.some((p) => p.test(text))) return "decision";
  if (PREFERENCE_SIGNALS.some((p) => p.test(text))) return "preference";
  return "context";
}

/**
 * 疑问句形态判定。
 *
 * 为什么需要: 捕获器原先"命中信号词就落盘", 而"你觉得选 A 还是 B?"这类句子同样含
 * 决策词 —— 实测 79 条记忆里 12 条 (15%) 是问句本身, 一条结论都没有。
 * 这个函数只判形态, 不判内容: 它挡的是"没有结论的问话", 不是"所有问句"
 * (用户自问自答"那就用 A 吧"仍要被捕获, 见 hasConclusionSignal)。
 */
export function isInterrogative(text: string): boolean {
  const head = text.slice(0, 160);
  if (/[?？]/.test(head)) return true;
  return /(吗|呢|怎么|为什么|为何|如何|是不是|能不能|可不可以|要不要|对不对|行不行)[。！!？?\s]?$/.test(
    head.trim(),
  );
}

/** 用户在提问之后**自己敲定**了的信号 (采纳/确认/落地)。 */
const CONCLUSION_SIGNALS: RegExp[] = [
  /就这样|就这么|就按这个|按你(说|推荐)的|采用|采纳|确认|敲定|定了|成交/,
  // 确认词必须**成词出现** (行首或标点之后), 否则 "你好," 里的 "好," 会被误判成确认 ——
  // 实测这条误判会让闲聊 "你好, 今天天气不错" 变成一条 decision。
  /(?:^|[，,。；;！!？?\s])(?:可以|没问题|好的?|行|okay|ok)(?=[，,。；;！!？?\s]|$)/i,
  /(修好|修复|跑通|通过|生效|完成|落地|提交)了?(?=[。！!\s]|$)/,
  /以后再|下次(都)?要|从现在起/,
];

/** 该轮是否产出结论 (用户认可 / 事情落地)。 */
export function hasConclusionSignal(text: string): boolean {
  return CONCLUSION_SIGNALS.some((p) => p.test(text));
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

export function nowIso(): string {
  return new Date().toISOString();
}

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
  const concluded = !explicit && hasConclusionSignal(text);
  const hasAnswer = Boolean(input.answer?.trim());

  // 结论闸门 (必须排在 context 过滤**之前**): 只有问题、后面什么都没有的轮次没有可沉淀的
  // 结论, 存下来就是转录 —— 实测这类占了 15%。
  if (!explicit && interrogative && !concluded && !hasAnswer) {
    return { entries: [], deduped: 0, signal: "no-conclusion:question" };
  }

  // kind 推断: "用户自己敲定了" (结论信号) 但没命中其它信号时, 它至少是一条 decision,
  // 不该被当成闲聊 context 丢掉 (自问自答 "那就用 A 吧" 就属于这种)。
  const inferred = explicit ? "fact" : inferKind(text);
  const kind = opts.forceKind ?? (concluded && inferred === "context" ? "decision" : inferred);

  // 带回答的疑问句允许越过 context 过滤: 结论长在回答里, 由结构化器判定有没有;
  // 结构化器读不出结论时由 pipeline 丢弃 (见 pipeline.run), 因此不会退回转录。
  const bypassContext = !explicit && interrogative && hasAnswer;
  if (!bypassContext && !shouldCapture(text, kind, mode))
    return { entries: [], deduped: 0, signal: "no-signal:" + kind };

  const content = explicit ?? text;
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
  return { entries: [entry], deduped: 0, signal: kind + ":" + hash };
}