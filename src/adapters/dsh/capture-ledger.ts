// adapters/dsh/capture-ledger.ts — 轮次配对与**账本形状** (从 runtime 拆出的第二职责)。
//
// 为什么独立成文件: runtime 的职责是"事件状态机 + 缓冲与冲刷"; 而"一轮问答何时算完成"与
// "账本这一行到底记什么"是两条可以单独审视、单独测试的规则。它们此前混在 flush 里,
// 结果是 469 行 (越过 400 行上限) 且没人能只看一段就明白账本字段从哪来。
//
// 一条硬约束: 账本字段**只有这一个来源**。runtime 不许自己拼一条 CaptureRecord 
// 两处拼装就会分叉, 而分叉的表现是"有些轮次的耗时字段恒为 0", 静默且难查。
import type { CaptureResult } from "../../capture/engine.ts";
import type { CapturePipeline } from "../../capture/pipeline.ts";
import type { EpisodeStore } from "../../kernel/ports.ts";
import type { CaptureLog, CaptureRecord, CaptureSkipReason } from "./capture-log.ts";
import type { CaptureNegativity } from "../../capture/engine.ts";

export interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

/** 一轮问答 (捕获单元)。 */
export interface TurnPair {
  question: string;
  answer: string;
  /** 宿主给的轮次号 (账本用它和 episode/会话日志对齐; 缺失时由本地计数兜底)。 */
  turn: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** turn/end 事件里带的轮次号 (缺失时 undefined, 由调用方回退到本地计数)。 */
export function turnOfEvent(event: SessionEventLike): number | undefined {
  const data = event.data;
  if (!isRecord(data)) return undefined;
  const turn = data.turn;
  return typeof turn === "number" && Number.isFinite(turn) ? turn : undefined;
}

/**
 * 这一轮为什么没沉淀  把引擎的 signal 与"结构化器没读出结论"折成闭集里的一个值。
 *
 * 为什么要区分: "没沉淀"有三种完全不同的成因 (引擎判据说这轮没信号 / 结构化器读不出结论 /
 * 压根没形成一轮问答), 外部此前只能看到"库里的条数没变"。账本的价值就在这个区分上。
 */
export function skipReasonOf(result: CaptureResult, stored: number): CaptureSkipReason | null {
  if (stored > 0) return null;
  // 提炼闸门丢掉的条目数由 pipeline 显式给出  不能用 entries.length 反推 (那条路径下
  // entries 恒为空, 两个成因就分不开了)。
  if ((result.noConclusion ?? 0) > 0) return "no-conclusion";
  return result.signal.startsWith("no-conclusion") ? "no-conclusion" : "no-signal";
}

/** 一轮的账本上下文 (只含 runtime 才知道的东西: 会话/项目/轮次/规模)。 */
export interface TurnContext {
  session: string;
  project?: string;
  turn: number;
  question: string;
  answer: string;
}

/** 落盘一轮的全部输入 (依赖全由调用方注入, 因此这段可单测)。 */
/** 回执的载荷 (summary 是对话里显示的那一行; text 是可展开正文)。 */
export interface ReceiptPayload {
  summary: string;
  text?: string;
}

export interface FlushTurnDeps {
  pipe: Pick<CapturePipeline, "run">;
  /**
   * 负面/纠正信号的判定面 (可选; 见 kernel/negativity.ts)。
   *
   * 由装配层注入而不是 pipeline 自建: 词表是**设置项** (面板可改), 而 ledger 是适配层 
   * 它知道"配置从哪来"。缺省不传 = 关闭该路径, 行为与接入前逐字一致。
   */
  negativity?: CaptureNegativity;
  /**
   * **对话内回执** (可选; 用户实测要求"在跟 ai 对话的日志里能看到沉淀了几条")。
   *
   * 为什么由这里发而不是 runtime 自己发: 只有这一层知道**本轮捕获的结果**
   * (stored / skipped / 为什么跳、命中了什么负面信号)。runtime 只看得到队列与事件。
   *
   * best-effort: 实现方必须吞掉自己的异常  回执是可观测性增强, 不许成为故障点。
   */
  onReceipt?: (receipt: ReceiptPayload) => void;
  /** 每次落盘时**重新求值** (面板能在会话中途开关 episode 记录 / 耗时账本)。 */
  episodes: () => EpisodeStore | null;
  log: () => CaptureLog | null;
  surface?: string;
  onError?: (error: unknown) => void;
}

/**
 * 把一轮问答落盘 (原文 → 记忆), 并把这一轮的**依据与耗时**写进账本。
 *
 * 顺序是"先原文后记忆": 反了会出现"有记忆无原文"的孤儿条目 (血缘指向不存在的东西)。
 * episode 与 memory 的耗时分开记  不分开就没人知道"慢"是花在磁盘上还是模型上。
 */
export async function flushTurn(deps: FlushTurnDeps, ctx: TurnContext): Promise<void> {
  const enteredAt = Date.now();
  const episodeStore = deps.episodes();
  const log = deps.log();
  const episodeIds: string[] = [];
  // episode 是整个捕获里**可预期变慢的一段真磁盘 IO**, 因此单独计时。
  let episodeStarted = Date.now();
  let episodeMs = 0;
  const writeEpisode = async (role: "user" | "assistant", text: string): Promise<void> => {
    if (!episodeStore || !text) return;
    try {
      // 端口允许异步实现 (远端日志/批量刷盘), 这里是 await 点。
      const episode = await episodeStore.append({
        session: ctx.session,
        turn: ctx.turn,
        role,
        text,
        at: new Date().toISOString(),
        ...(ctx.project ? { project: ctx.project } : {}),
        ...(deps.surface ? { surface: deps.surface } : {}),
      });
      episodeIds.push(episode.id);
    } catch (error) {
      // 原文写失败不能拖垮记忆捕获 (记忆仍可落盘, 只是少了血缘)。
      deps.onError?.(error);
    } finally {
      episodeMs += Date.now() - episodeStarted;
      episodeStarted = Date.now();
    }
  };
  await writeEpisode("user", ctx.question);
  await writeEpisode("assistant", ctx.answer);

  const base: CaptureRecord = {
    at: new Date(enteredAt).toISOString(),
    session: ctx.session,
    ...(ctx.project ? { project: ctx.project } : {}),
    turn: ctx.turn,
    outcome: "skipped",
    entries: 0,
    qChars: ctx.question.length,
    aChars: ctx.answer.length,
    episodeMs,
    enrichMs: 0,
    linkMs: 0,
    storeMs: 0,
    totalMs: 0,
  };
  try {
    await deps.pipe.run(
      {
        text: ctx.question,
        ...(ctx.answer ? { answer: ctx.answer } : {}),
        session: ctx.session,
        ...(ctx.project ? { project: ctx.project } : {}),
        ...(episodeIds.length ? { episodeIds } : {}),
      },
      {
        ...(episodeMs ? { episodeMs } : {}),
        ...(deps.negativity ? { negativity: deps.negativity } : {}),
        onTiming: (timing, res) => {
          if (!log) return;
          const stored = res.entries.length;
          const skip = skipReasonOf(res, stored);
          log.append({
            ...base,
            ...timing,
            outcome: stored > 0 ? "stored" : "skipped",
            ...(skip ? { skip } : {}),
            entries: stored,
            ...(stored > 0 ? {} : { detail: res.signal }),
            // 结构化路径 (耗时之外的第二个维度)  见 CaptureRecord 的字段说明。
            ...(res.concludeCapable === undefined ? {} : { concludeCapable: res.concludeCapable }),
          });
          // ---- 对话内回执 (用户实测要求: "要能看到它真的在沉淀") ----
          // 只报**有信息量**的那几种; 逐轮都报"没沉淀"会把对话刷成噪声 (见 receiptText)。
          deps.onReceipt?.({
            summary: receiptSummary(res, stored),
            text: receiptText(ctx, res, stored),
          });
        },
      },
    );
  } catch (error) {
    // 落盘失败此前只在 totalMs 上表现为"少了一轮": 账本必须把它记成 error 行,
    // 否则"这段安静的空白"会被误读成"那几轮很顺"。
    deps.onError?.(error);
    log?.append({
      ...base,
      totalMs: Date.now() - enteredAt,
      outcome: "error",
      detail: String(error),
    });
  }
}

/**
 * 记一条"没沉淀"的依据 (开关关着 / subagent / 没形成问答)。
 *
 * 为什么这些也要落账: "库里的条数没变"有几种完全不同的成因, 而它们的处置方式相反
 * (改设置 / 换会话 / 根本不用管)。只记成功的账本回答不了"为什么没沉淀"。
 *
 * 只在 turn/end 上记: 那是"一轮结束了"的唯一信号; 记在 user/message 上会把同一条事实
 * 写 N 遍 (一个 turn 里可以有多个 user/message)。
 */
export function skipOnTurnEnd(
  deps: Pick<FlushTurnDeps, "log">,
  event: SessionEventLike,
  input: { session: string; project?: string; turn: number },
  skip: CaptureSkipReason,
): void {
  if (event.type !== "turn/end") return;
  const log = deps.log();
  if (!log) return;
  log.append({
    at: new Date().toISOString(),
    session: input.session,
    ...(input.project ? { project: input.project } : {}),
    turn: turnOfEvent(event) ?? input.turn,
    outcome: "skipped",
    skip,
    entries: 0,
    qChars: 0,
    aChars: 0,
    episodeMs: 0,
    enrichMs: 0,
    linkMs: 0,
    storeMs: 0,
    totalMs: 0,
  });
}

/**
 * 从本轮收集到的文本造一个 pending 轮次 (没形成问答时返回 null)。
 *
 * 为什么"没有用户消息就不算一轮": 捕获单元是**一轮问答**, 不是一次 turn/end 事件 
 * 工具触发的空轮次、被中断的轮次都没有可沉淀的内容 (存下来就是转录)。
 */
export function completeTurn(state: {
  messages: string[];
  answers: string[];
  turnBase: number;
  pending: TurnPair[];
}, event: SessionEventLike): TurnPair | null {
  if (state.messages.length === 0) return null;
  return {
    question: state.messages.join("\n"),
    answer: state.answers.join("\n"),
    turn: turnOfEvent(event) ?? state.turnBase + state.pending.length + 1,
  };
}


/**
 * 一轮捕获的**回执行** (一行; 显示在对话里)。
 *
 * 措辞要求 (用户实测的直接反馈): 要**一眼看出"它干了什么"**, 而不是复述内部字段。
 * 因此主语是记忆层 ("已沉淀" / "判重跳过"), 而原因用最短的词, 不是 `no-signal` 这类枚举名。
 */
export function receiptSummary(result: CaptureResult, stored: number): string {
  if (stored > 0) {
    const kinds = [...new Set(result.entries.map((e) => e.kind))].join("/");
    return "HX-Memory: 已沉淀 " + stored + " 条" + (kinds ? " (" + kinds + ")" : "");
  }
  if ((result.reviewQueued ?? 0) > 0) return "HX-Memory: 已入库并标记 " + result.reviewQueued + " 条待复核";
  const skip = skipReasonOf(result, stored);
  if (skip === "no-conclusion") return "HX-Memory: 本轮未沉淀 (结构化器读不出结论)";
  return "HX-Memory: 本轮未沉淀 (无新信号)";
}

/**
 * 回执正文 (比 summary 多几句可展开的细节: 沉淀了什么 / 为什么没沉淀)。
 *
 * ⚠ **只在有信息量时才有细节**: 常规轮次的"无新信号"不展开  逐条展开会把对话变成日志流,
 * 那正好违背"回执是为了让人相信它在工作"的初衷 (噪声会和沉默一样让人失去信任)。
 */
export function receiptText(ctx: TurnContext, result: CaptureResult, stored: number): string {
  const head = receiptSummary(result, stored);
  const lines = [head];
  if (stored > 0) {
    for (const e of result.entries.slice(0, 3)) {
      lines.push("- [" + e.kind + "] " + e.content.slice(0, 120));
    }
    if (result.entries.length > 3) lines.push("- …另有 " + (result.entries.length - 3) + " 条");
  } else if (result.negative) {
    // 负面信号轮未落盘时也要说明 (否则"骂了没反应"的体感会回来)。
    lines.push("负面信号: " + result.negative.kinds.join("+") + " (level " + result.negative.level + ")");
  }
  if (result.noConclusion) lines.push("丢掉了 " + result.noConclusion + " 条 (读不出结论)");
  if (result.reviewQueued) lines.push("标记待复核 " + result.reviewQueued + " 条 (已入库, 可剔除)");
  lines.push("(来源: " + ctx.session.slice(0, 24) + " turn " + ctx.turn + ")");
  return lines.join("\n");
}
