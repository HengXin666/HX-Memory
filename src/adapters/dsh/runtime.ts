// src/adapters/dsh/runtime.ts — 会话运行时: 监听 session/event, 聚合 turn, 批量捕获。
// 类型策略: 用宽松结构类型 (SessionLike/SessionEventLike) 与 DSH 解耦,
// 任何发同类事件的 harness 都可复用 (仿 ReMe 的做法)。
//
// project 语义见 project-key.ts (它从本文件拆出去: 这个键是跨层契约, 不该埋在运行时里)。
//
// autoMemoryInterval (2026-09 实现): 每 N 轮完成对话才落一次记忆 (0/1 = 每轮);
// 会话结束时强制冲刷, 保证不丢。
//
// 三段职责 (2026-09 拆分, 本文件此前 469 行越过 400 行上限):
//   1. 项目键解析 → project-key.ts;
//   2. 事件 → 轮次 → 账本形状 → capture-ledger.ts;
//   3. 本文件: 事件状态机 + 缓冲与冲刷 + 并发/生命周期。
import type { CapturePipeline } from "../../capture/pipeline.ts";
import type { EpisodeStore } from "../../kernel/ports.ts";
import type { CaptureLog, CaptureSkipReason } from "./capture-log.ts";
import { projectOfSession, type SessionLike } from "./project-key.ts";
import {
  completeTurn,
  flushTurn,
  skipOnTurnEnd,
  type FlushTurnDeps,
  type SessionEventLike,
  type TurnPair,
} from "./capture-ledger.ts";

export type { SessionLike } from "./project-key.ts";

export type { SessionEventLike } from "./capture-ledger.ts";
// 项目键原语在 project-key.ts; 这里**转发**导出, 让调用方不必知道它搬到哪个文件了
// (搬运实现不该改变依赖图的形状 —— 否则每次拆分都要改一圈调用点)。
export { projectKeyOfCwd, projectOfSession } from "./project-key.ts";

export interface RuntimeSettings {
  autoCapture: boolean;
  autoMemoryInterval?: number;
  /** 只捕获根 agent (忽略 subagent): 子 agent 的任务提示词也是 source.kind=user。 */
  rootAgentsOnly?: boolean;
}

interface TurnState {
  /** 本轮已收到的用户文本 (可能有多次 user/message)。 */
  messages: string[];
  /** 本轮助手的回答。 */
  answers: string[];
  /** 已完成但尚未落盘的 turn (按 interval 批量冲刷)。 */
  pending: TurnPair[];
  project?: string;
  /** 该会话已落盘的轮次数 (episode.turn 用它保持单调递增, 跨冲刷批次不断档)。 */
  turnBase: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part) || typeof part.text !== "string") return "";
        // 只认正文块: assistant/message 里 reasoning (思维链) 也是 {type, text},
        // 全收下来会把"想的过程"当成回答沉淀进记忆。
        // 缺 type 的块按正文处理 —— 别把未知形状静默丢掉 (user/message 的块常常没有 type)。
        if (typeof part.type === "string" && part.type !== "text") return "";
        return part.text;
      })
      .join("");
  }
  return "";
}

function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";
  // assistant/message 的 data 是**信封** { turn, step, message } —— 文本在 data.message.content,
  // 不在 data.content 上。只读 data.content 会让助手输出恒为空字符串: 实测 315 条 episode
  // 全是 user、账本 aChars 恒为 0、结构化器永远读不到"回答", 于是沉淀的全是用户原话。
  // user/message 则相反, 直接把 message 展开在 data 上 (content/source/role/id)。两种都要认。
  const direct = contentText(data.content);
  if (direct) return direct;
  const message = data.message;
  if (isRecord(message)) return contentText(message.content);
  return "";
}

export interface RuntimeOptions {
  /** 落盘失败的旁路通知 (记忆写入失败绝不能影响宿主)。 */
  onError?: (error: unknown) => void;
  /**
   * Episode 追加日志 (ADR-018): 保留原文, 支撑"换抽取器 → 全量重放"。
   * **用"提供者"而不是直接给实例**: 开关 (captureEpisodes) 在面板里是可改的,
   * 而构造插件时读一次会让改动必须重启才生效 (真实踩过)。
   */
  episodes?: () => EpisodeStore | null;
  /** 捕获来源标记 (写进 episode.surface, 便于多宿主共存时溯源)。 */
  surface?: string;
  /**
   * 捕获耗时账本 (可选)。给了它, 每一轮都会落一条"为什么/花了多久"的记录。
   *
   * 用**提供者**而不是实例: 开关 (captureLog) 在面板里可改, 构造插件时读一次会让改动必须重启
   * 才生效 —— 与 episodes 同一个理由 (真实踩过)。
   */
  captureLog?: () => CaptureLog | null;
}

export class HxMemoryRuntime {
  private readonly turns = new Map<string, TurnState>();
  /**
   * 最近一次会话的项目键 (面板用它预填"当前项目"行)。
   *
   * 为什么放在 runtime: 面板跑在 Web 侧, 拿不到会话 cwd; 而 runtime 在会话开始时就
   * 按同一口径算出了项目键。返回**最近的**一个 (用户正在用的那个)。
   */
  private lastProject?: string;
  /**
   * 最近一次会话活动的时间戳 (ms; 0 = 本进程还没见过活动)。
   * 只被 idleMs() 读取, 用来让后台维护避开正在写入的窗口。
   */
  private lastActivityAt = 0;
  /** 已触发但尚未结束的冲刷 (会话 dispose 后不再在 turns 里, flushAll 必须也能等到它们)。 */
  private readonly inflight = new Set<Promise<void>>();

  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly pipe: CapturePipeline;
  private readonly settings: () => RuntimeSettings;
  private readonly options: RuntimeOptions;

  constructor(pipe: CapturePipeline, settings: () => RuntimeSettings, options: RuntimeOptions = {}) {
    this.pipe = pipe;
    this.settings = settings;
    this.options = options;
  }

  /** 最近一次会话的项目键 (无则 undefined)。 */
  project(): string | undefined {
    return this.lastProject;
  }

  /**
   * 距离最近一次会话活动过了多久 (ms); 从未有过活动时返回 0。
   *
   * 为什么由 runtime 提供而不是让调度器自己看时间: "有没有人在写真相文件"只有捕获路径知道。
   * 后台维护 (P3 调度器) 用它在**空闲窗**内才动手 —— 与宿主并发改写同一批 Markdown 会丢写。
   * 返回 0 的语义是"没有活动"(而不是"刚刚活动过"), 调用方按"已空闲"处理。
   */
  idleMs(): number {
    if (this.lastActivityAt === 0) return 0;
    return Math.max(0, Date.now() - this.lastActivityAt);
  }

  onSessionStart(session: SessionLike): void {
    const project = projectOfSession(session);
    if (project) this.lastProject = project;
    this.turns.set(session.id, {
      messages: [],
      answers: [],
      pending: [],
      ...(project ? { project } : {}),
      turnBase: 0,
    });
  }

  /** 追踪一次后台冲刷: 失败只通知不抛出 (未处理的 rejection 会让宿主致命退出)。 */
  private track(promise: Promise<void>): void {
    this.inflight.add(promise);
    void promise
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => this.inflight.delete(promise));
  }

  /** 会话结束: 冲刷未落盘的 turn, 再清理状态。 */
  onSessionEnd(session: SessionLike): void {
    const state = this.turns.get(session.id);
    this.turns.delete(session.id);
    if (state?.pending.length) this.track(this.flush(session, state));
  }

  /**
   * 插件卸载/进程退出: 先等已触发的冲刷 (可能含 LLM 调用), 再冲刷剩余会话的缓冲。
   * 否则 autoMemoryInterval>1 时最后几轮会丢。
   */
  async flushAll(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
    const entries = [...this.turns.entries()];
    for (const [id, state] of entries) {
      this.turns.delete(id);
      if (state.pending.length) await this.flush({ id }, state);
    }
  }

  private interval(): number {
    const raw = this.settings().autoMemoryInterval ?? 1;
    return Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
  }

  /**
   * 把缓冲的 turn 逐条落盘。
   *
   * 捕获单元是**一轮问答**, 不是一句用户输入:
   *   - 原文用**真实 role** 写进 episode (此前助手侧根本没有入口, 日志里 107 条全是 user);
   *   - 记忆吃 {question, answer} 对, 结论/理由都长在回答里。
   * 顺序仍是"先原文后记忆" —— 反了会出现"有记忆无原文"的孤儿条目。
   */
  private async flush(session: SessionLike, state: TurnState): Promise<void> {
    const pending = state.pending.splice(0);
    let turn = state.turnBase;
    const deps: FlushTurnDeps = {
      pipe: this.pipe,
      // 每一轮都**重新求值**: 面板能在会话中途开关 episode 记录与耗时账本 (钉在构造期就得重启)。
      episodes: () => this.options.episodes?.() ?? null,
      log: () => this.options.captureLog?.() ?? null,
      ...(this.options.surface ? { surface: this.options.surface } : {}),
      ...(this.options.onError ? { onError: this.options.onError } : {}),
    };
    for (const pair of pending) {
      // 用宿主给的轮次号 (没有则本地递增): 账本要能和 episode/会话日志直接对上,
      // 而 episode 的 turn 用的是本地计数 —— 两者在"宿主没给 turn"时才可能不同。
      turn = Math.max(turn + 1, pair.turn);
      await flushTurn(deps, {
        session: session.id,
        ...(state.project ? { project: state.project } : {}),
        turn,
        question: pair.question,
        answer: pair.answer,
      });
    }
    state.turnBase = turn;
  }

  /** 消费一个 session/event。turn/end 且 reason=completed 时进入缓冲/落盘。 */
  async capture(session: SessionLike, event: SessionEventLike): Promise<void> {
    // 活动时间戳在**开关判定之前**记录: 它是"宿主在动"的事实, 与"要不要捕获"无关。
    // 后台维护靠它判断空闲窗 (见 idleMs); 若放在 autoCapture 之后, 关掉捕获时维护会误判空闲。
    this.lastActivityAt = Date.now();
    const settings = this.settings();
    if (!settings.autoCapture) {
      this.recordSkip(session, event, "disabled");
      return;
    }
    // subagent 的任务提示词 source.kind 也是 "user", 只看来源挡不住它 —— 按 origin 过滤。
    if (settings.rootAgentsOnly !== false && session.header?.origin === "subagent") {
      this.recordSkip(session, event, "subagent");
      return;
    }
    const state = this.turns.get(session.id);
    if (event.type === "turn/start") {
      if (state) {
        state.messages = [];
      } else {
        this.turns.set(session.id, {
          messages: [],
          answers: [],
          pending: [],
          project: projectOfSession(session),
          turnBase: 0,
        });
      }
      return;
    }
    if (event.type === "user/message") {
      // 只捕获**直接用户输入**: 插件注入的上下文 (AGENTS.md baseline / time-context /
      // skill 目录 / 本插件自己的绑定注入) 也是 role:user, 混进来就是自捕获+噪声。
      const source = isRecord(event.data)
        ? (event.data.source as { kind?: string } | undefined)
        : undefined;
      if (source?.kind !== "user") return;
      const text = textOf(event.data);
      if (text && state) state.messages.push(text);
      return;
    }
    if (event.type === "assistant/message") {
      // 助手输出必须一起收: 结论/理由/"为什么这么问"都在这里。
      // 缺了它, 抽取器只能看着问题猜答案 (这就是"沉淀的全是用户原话"的根因)。
      const text = textOf(event.data);
      if (text && state) state.answers.push(text);
      return;
    }
    if (event.type !== "turn/end" || !state) return;
    const reason =
      isRecord(event.data) && isRecord(event.data.reason) ? event.data.reason : undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
    const completed = kind === "completed" || kind === "max-tokens";
    if (completed) {
      // 配对规则在 capture-ledger.ts (可单测): 没有用户消息就**不是**一轮, 不落任何东西。
      const pair = completeTurn(state, event);
      if (pair) state.pending.push(pair);
      else this.recordSkip(session, event, "no-turn");
    } else {
      // 走到这里说明这一轮没有可沉淀的问答 (未完成/没有用户消息)。账本要能解释
      // "为什么这个 turn/end 之后什么也没发生" —— 否则这段空白与"没开捕获"长得一样。
      this.recordSkip(session, event, "no-turn");
    }
    state.messages = [];
    state.answers = [];
    if (state.pending.length >= this.interval()) await this.flush(session, state);
  }

  /**
   * 记一条"没沉淀"的依据 (开关关着 / subagent / 没形成问答)。
   *
   * 为什么这些也要落账: "库里的条数没变"有三种完全不同的成因, 而它们的处置方式相反
   * (改设置 / 换会话 / 根本不用管)。只记成功的账本回答不了"为什么没沉淀"。
   * 只在 turn/end 上记: 那是"一轮结束了"的唯一信号, 记在 user/message 上会把同一条
   * 事实写 N 遍 (一个 turn 里可以有多个 user/message)。
   */
  private recordSkip(
    session: SessionLike,
    event: SessionEventLike,
    skip: CaptureSkipReason,
  ): void {
    const state = this.turns.get(session.id);
    const project = state?.project ?? projectOfSession(session);
    skipOnTurnEnd(
      { log: () => this.options.captureLog?.() ?? null },
      event,
      {
        session: session.id,
        ...(project ? { project } : {}),
        turn: state ? state.turnBase + state.pending.length + 1 : 0,
      },
      skip,
    );
  }
}