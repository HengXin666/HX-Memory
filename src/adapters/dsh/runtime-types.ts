// adapters/dsh/runtime-types.ts — 会话运行时的设置 / 轮次状态 / 构造选项 (2026-11-02 从 runtime.ts 拆出, verify-structure 400 行约束)。
import type { CaptureNegativity } from "../../capture/engine.ts";
import type { ReceiptPayload, TurnPair } from "./capture-ledger.ts";
import type { EpisodeStore } from "../../kernel/ports.ts";
import type { CaptureLog } from "./capture-log.ts";

export interface RuntimeSettings {
  autoCapture: boolean;
  autoMemoryInterval?: number;
  /** 只捕获根 agent (忽略 subagent): 子 agent 的任务提示词也是 source.kind=user。 */
  rootAgentsOnly?: boolean;
}

export interface TurnState {
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

/**
 * 设置热更新 + 面板自刷新 + 文档同步门禁与技能库
 * .agents/notes/implemented/process/2026-09-10-live-settings-and-doc-gates.md
 */
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
   * 才生效  与 episodes 同一个理由 (真实踩过)。
   */
  captureLog?: () => CaptureLog | null;
  /**
   * 负面/纠正信号的判定面 (可选; 由装配层按**当前设置**构造  词表可配置)。
   *
   * 用提供者而不是实例: 词表与开关都在面板里可改, 构造时读一次会让改动必须重启才生效
   * (与 episodes / captureLog 同一个理由, 那条已实测踩过)。缺省 = 关闭该路径。
   */
  negativity?: () => CaptureNegativity | undefined;
  /**
   * 对话内回执的投递器 (可选)。按 session 取: flush 是**异步**的, 拿错 agent 会串台 
   * 取不到就**不发** (回执宁可少一条)。形态与文案见 receipt.ts 与 capture-ledger.ts。
   */
  receipt?: (sessionId: string) => ((r: ReceiptPayload) => void) | undefined;
}
