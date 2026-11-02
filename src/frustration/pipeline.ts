// src/frustration/pipeline.ts — 挫折链路 (唯一一条): 检测 → 按消息去重 → 同轮独立评审 → 入库 → 注入。
//
// 对应 PLAN.md J1.4 / J3.1-J3.5。挂在 DSH 的 agent/pre-step 上, 每个 step 调一次 onStep:
//
//   step k   (用户消息第一次出现): 检测一次。命中 → 立即在后台启动评审 (不等轮末), 本 step 注入一句
//            「收到纠正, 正在评审」和已有的同范围规则。
//   step k+1 (同一轮的下一个 step): 等评审结果 (最多 sameTurnWaitMs)。通过闸门 → 入库, 并把结论注入,
//            主 agent 在这一轮里就能照着改。没通过 → 不入库, 也不注入模板句。
//   之后的 step: 这条消息已经处理完, 什么都不做。
//   新会话的第一个 step: 注入适用于当前仓库 / 目录的已入库规则 (J3.5, 不依赖 agent 调工具)。
//
// 一条用户消息最多触发一次检测、一次评审、一次入库、一次结论注入。计数都在 stats() 里, 评测 A3 读它。
import { randomBytes } from "node:crypto";
import { latestUserMessage, SeenMessages, textOf } from "./dedupe.ts";
import type { FrustrationDetector, FrustrationSignal } from "./detect.ts";
import { buildReviewInput, parseLesson, REVIEW_SYSTEM_PROMPT, reviewUserPrompt, type Lesson } from "./review.ts";
import { formatLesson, type LessonStore } from "./rules.ts";

/** 评审模型调用 (独立上下文的一次性调用)。 */
export type ReviewModel = (system: string, input: string) => Promise<string>;

export interface FrustrationPipelineDeps {
  detector: FrustrationDetector;
  review: ReviewModel;
  store: LessonStore;
  /** 工作位置: 仓库根与当前目录 (由调用方从 session.header.cwd 解析)。 */
  locate: (cwd: string) => { repo: string; cwd: string };
  /** 最近一次 diff (仓库根下 git diff; 拿不到返回空串)。 */
  diff: (repo: string) => string;
  /** 评审材料取触发前几轮 (含触发轮)。默认 6。 */
  turns?: number;
  /** 下一个 step 最多等评审多久 (ms)。默认 45000。 */
  sameTurnWaitMs?: number;
  /** 命中时给人看的回执 (可选)。 */
  onHit?: (sessionId: string, signal: FrustrationSignal) => void;
  /** 评审结束 (入库或拒收) 的观测钩子。 */
  onReviewed?: (event: { sessionId: string; messageKey: string; accepted: boolean; reason: string; ms: number }) => void;
  now?: () => Date;
}

export interface StepInput {
  sessionId: string;
  step: number;
  messages: readonly unknown[];
  cwd: string;
}

interface Pending {
  promise: Promise<{ lesson: Lesson | null; reason: string }>;
  settled: { lesson: Lesson | null; reason: string } | null;
  delivered: boolean;
}

export interface PipelineStats {
  /** 第一次见到的用户消息数。 */
  messages: number;
  hits: number;
  /** 每条消息被检测的次数 / 评审次数的最大值 (A3 要求 = 1)。 */
  maxDetectPerMessage: number;
  maxReviewPerMessage: number;
  reviewsStarted: number;
  accepted: number;
  rejected: Record<string, number>;
  conclusionsInjected: number;
  sessionRuleInjections: number;
}

export class FrustrationPipeline {
  private readonly seen = new SeenMessages();
  private readonly pending = new Map<string, Pending>();
  private readonly sessionsPrimed = new Set<string>();
  private readonly detectCount = new Map<string, number>();
  private readonly reviewCount = new Map<string, number>();
  private readonly counters = { messages: 0, hits: 0, reviewsStarted: 0, accepted: 0, conclusionsInjected: 0, sessionRuleInjections: 0 };
  private readonly rejected: Record<string, number> = {};

  // 显式字段, 不用参数属性 (Node 26 strip-only 不支持)。
  private readonly deps: FrustrationPipelineDeps;

  constructor(deps: FrustrationPipelineDeps) {
    this.deps = deps;
  }

  stats(): PipelineStats {
    return {
      ...this.counters,
      maxDetectPerMessage: Math.max(0, ...this.detectCount.values()),
      maxReviewPerMessage: Math.max(0, ...this.reviewCount.values()),
      rejected: { ...this.rejected },
    };
  }

  /** 每个 pre-step 调一次。返回要并进注入块的文本 (没有就是空串)。 */
  async onStep(input: StepInput): Promise<string> {
    const parts: string[] = [];
    const where = this.deps.locate(input.cwd);

    // J3.5: 新会话第一次进来, 注入已入库的同范围规则。
    if (!this.sessionsPrimed.has(input.sessionId)) {
      this.sessionsPrimed.add(input.sessionId);
      const rules = this.deps.store.match(where);
      if (rules.length) {
        this.counters.sessionRuleInjections++;
        parts.push("【HX-Memory 规则】以下是你在这个仓库被纠正后沉淀的做法, 本会话照做:\n" + rules.map(formatLesson).join("\n"));
      }
    }

    const msg = latestUserMessage(input.messages);
    if (!msg) return parts.join("\n\n");
    const pkey = input.sessionId + "\u0000" + msg.key;

    if (this.seen.claim(input.sessionId, msg.key)) {
      // 这条用户消息第一次出现: 检测一次。
      this.counters.messages++;
      this.detectCount.set(pkey, (this.detectCount.get(pkey) ?? 0) + 1);
      const prevAssistant = previousAssistantText(input.messages, msg.index);
      const signal = await this.deps.detector.detectWithJudge(msg.text, prevAssistant);
      if (signal.hit) {
        this.counters.hits++;
        this.deps.onHit?.(input.sessionId, signal);
        this.startReview(input, msg.key, msg.index, signal, where);
        parts.push("【HX-Memory】用户这条消息是在纠正你 (" + signal.kinds.join("+") + ")。先停下, 复述你理解的方向再继续; 评审结论会在下一步给你。");
      }
      return parts.join("\n\n");
    }

    // 同一条消息的后续 step: 结论只交付一次。
    const p = this.pending.get(pkey);
    if (p && !p.delivered) {
      const result = p.settled ?? (await withTimeout(p.promise, this.deps.sameTurnWaitMs ?? 45000));
      if (result) {
        p.delivered = true;
        if (result.lesson) {
          this.counters.conclusionsInjected++;
          parts.push("【HX-Memory 评审结论】针对用户刚才的纠正, 本轮立刻按此改正:\n" + formatLesson(result.lesson));
        }
        this.pending.delete(pkey);
      }
    }
    return parts.join("\n\n");
  }

  private startReview(input: StepInput, messageKey: string, triggerIndex: number, signal: FrustrationSignal, where: { repo: string; cwd: string }): void {
    const pkey = input.sessionId + "\u0000" + messageKey;
    this.counters.reviewsStarted++;
    this.reviewCount.set(pkey, (this.reviewCount.get(pkey) ?? 0) + 1);
    const started = Date.now();
    const cwdDir = where.repo && input.cwd.startsWith(where.repo) ? input.cwd.slice(where.repo.length).replace(/^\/+/, "") : "";
    const reviewInput = buildReviewInput({
      messages: input.messages,
      triggerIndex,
      turns: this.deps.turns ?? 6,
      diff: safe(() => this.deps.diff(where.repo), ""),
      repo: where.repo,
      cwdDir,
    });
    const entry: Pending = { settled: null, delivered: false, promise: Promise.resolve({ lesson: null, reason: "" }) };
    entry.promise = (async () => {
      let lesson: Lesson | null = null;
      let reason = "";
      try {
        const raw = await this.deps.review(REVIEW_SYSTEM_PROMPT, reviewUserPrompt(reviewInput));
        const parsed = parseLesson(raw, reviewInput);
        if (parsed.ok) {
          lesson = {
            id: "lesson_" + (this.deps.now?.() ?? new Date()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "_" + randomBytes(4).toString("hex"),
            createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
            session: input.sessionId,
            messageKey,
            trigger: { text: textOf((input.messages[triggerIndex] as { content?: unknown })?.content).slice(0, 500), via: signal.via, kinds: signal.kinds },
            ...parsed.lesson,
          };
          this.deps.store.save(lesson);
          this.counters.accepted++;
          reason = "accepted";
        } else {
          reason = parsed.reason;
        }
      } catch (error) {
        reason = "review-error: " + String(error).slice(0, 120);
      }
      if (!lesson) {
        const k = reason.split(":")[0]!;
        this.rejected[k] = (this.rejected[k] ?? 0) + 1;
      }
      const result = { lesson, reason };
      entry.settled = result;
      this.deps.onReviewed?.({ sessionId: input.sessionId, messageKey, accepted: Boolean(lesson), reason, ms: Date.now() - started });
      return result;
    })();
    this.pending.set(pkey, entry);
  }
}

function previousAssistantText(messages: readonly unknown[], before: number): string {
  for (let i = before - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role === "assistant") {
      const t = textOf(m.content).trim();
      if (t) return t.slice(-1500);
    }
  }
  return "";
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
