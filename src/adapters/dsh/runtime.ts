// src/adapters/dsh/runtime.ts — 会话运行时: 监听 session/event, 聚合 turn, 批量捕获。
// 类型策略: 用宽松结构类型 (SessionLike/SessionEventLike) 与 DSH 解耦,
// 任何发同类事件的 harness 都可复用 (仿 ReMe 的做法)。
//
// project 语义 (2026-09 修正): 项目键 = 会话工作目录的目录名。此前用的是 session.id
// (UUID), 导致自动捕获永远是 scope:"agent"、绑定面板无从填写、项目内召回永远为空。
//
// autoMemoryInterval (2026-09 实现): 每 N 轮完成对话才落一次记忆 (0/1 = 每轮);
// 会话结束时强制冲刷, 保证不丢。
import type { CapturePipeline } from "../../capture/pipeline.ts";
import type { EpisodeStore } from "../../kernel/ports.ts";

export interface SessionLike {
  id: string;
  header?: { origin?: string; cwd?: string };
}

export interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

export interface RuntimeSettings {
  autoCapture: boolean;
  autoMemoryInterval?: number;
  /** 只捕获根 agent (忽略 subagent): 子 agent 的任务提示词也是 source.kind=user。 */
  rootAgentsOnly?: boolean;
}

interface TurnState {
  messages: string[];
  /** 已完成但尚未落盘的 turn 文本 (按 interval 批量冲刷)。 */
  pending: string[];
  project?: string;
  /** 该会话已落盘的轮次数 (episode.turn 用它保持单调递增, 跨冲刷批次不断档)。 */
  turnBase: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 会话 → 项目键: 工作目录的目录名 (如 /code/api → api); 无 cwd 时 undefined。 */
export function projectOfSession(session: SessionLike): string | undefined {
  const cwd = session.header?.cwd;
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const name = trimmed.split(/[\\/]/).pop();
  return name && name.length ? name : undefined;
}

function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";
  const content = data.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export interface RuntimeOptions {
  /** 落盘失败的旁路通知 (记忆写入失败绝不能影响宿主)。 */
  onError?: (error: unknown) => void;
  /**
   * Episode 追加日志 (可选, ADR-018): 保留原文, 支撑"换抽取器 → 全量重放"。
   * 关闭时记忆仍照常捕获, 只是没有原文可重放。
   */
  episodes?: EpisodeStore;
  /** 捕获来源标记 (写进 episode.surface, 便于多宿主共存时溯源)。 */
  surface?: string;
}

export class HxMemoryRuntime {
  private readonly turns = new Map<string, TurnState>();
  /** 已触发但尚未结束的冲刷 (会话 dispose 后不再在 turns 里, flushAll 必须也能等到它们)。 */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly pipe: CapturePipeline,
    private readonly settings: () => RuntimeSettings,
    private readonly options: RuntimeOptions = {},
  ) {}

  onSessionStart(session: SessionLike): void {
    this.turns.set(session.id, {
      messages: [],
      pending: [],
      project: projectOfSession(session),
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

  /** 把缓冲的 turn 逐条落盘 (每条 turn 一条记忆, 保留粒度)。 */
  private async flush(session: SessionLike, state: TurnState): Promise<void> {
    const pending = state.pending.splice(0);
    let turn = state.turnBase;
    for (const text of pending) {
      turn += 1;
      // 先写原文 (真相), 再抽取记忆并带上血缘: 顺序反了会出现"有记忆无原文"的孤儿条目。
      let episodeId: string | undefined;
      if (this.options.episodes) {
        try {
          // 端口允许异步实现 (远端日志/批量刷盘), 这里是 await 点。
          const episode = await this.options.episodes.append({
            session: session.id,
            turn,
            role: "user",
            text,
            at: new Date().toISOString(),
            ...(state.project ? { project: state.project } : {}),
            ...(this.options.surface ? { surface: this.options.surface } : {}),
          });
          episodeId = episode.id;
        } catch (error) {
          // 原文写失败不能拖垮记忆捕获 (记忆仍可落盘, 只是少了血缘)。
          this.options.onError?.(error);
        }
      }
      await this.pipe.run({
        text,
        session: session.id,
        ...(state.project ? { project: state.project } : {}),
        ...(episodeId ? { episodeId } : {}),
      });
    }
    state.turnBase = turn;
  }

  /** 消费一个 session/event。turn/end 且 reason=completed 时进入缓冲/落盘。 */
  async capture(session: SessionLike, event: SessionEventLike): Promise<void> {
    if (!this.settings().autoCapture) return;
    // subagent 的任务提示词 source.kind 也是 "user", 只看来源挡不住它 —— 按 origin 过滤。
    if (this.settings().rootAgentsOnly !== false && session.header?.origin === "subagent") return;
    const state = this.turns.get(session.id);
    if (event.type === "turn/start") {
      if (state) {
        state.messages = [];
      } else {
        this.turns.set(session.id, {
          messages: [],
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
    if (event.type !== "turn/end" || !state) return;
    const reason =
      isRecord(event.data) && isRecord(event.data.reason) ? event.data.reason : undefined;
    const kind = typeof reason?.kind === "string" ? reason.kind : undefined;
    const completed = kind === "completed" || kind === "max-tokens";
    if (completed && state.messages.length > 0) {
      state.pending.push(state.messages.join("\n"));
    }
    state.messages = [];
    if (state.pending.length >= this.interval()) await this.flush(session, state);
  }
}
