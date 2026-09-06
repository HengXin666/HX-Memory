// src/adapters/dsh/types.ts — DSH adapter 配置与设置命名空间。
// 设置项经 DSH 的 ctx.settings 持久化 (类似 ReMe 的 reme.settings)。

export const MEMORY_SETTINGS_NAMESPACE = "hx-memory.settings";

export interface HxMemorySettings {
  /** 记忆根目录 (默认为 DSH home 下 hx-memory/)。 */
  root?: string;
  /** 自动捕获开关。 */
  autoCapture: boolean;
  /** 每 N 轮完成对话批量入记忆 (0 = 每轮)。 */
  autoMemoryInterval: number;
  /** 只捕获根 agent (忽略 subagent)。 */
  rootAgentsOnly: boolean;
  /** 指引语言。 */
  language: "zh" | "en";
  /** 会话开始注入记忆指引开关。 */
  injectGuidance: boolean;
}

export const DEFAULT_SETTINGS: HxMemorySettings = {
  autoCapture: true,
  autoMemoryInterval: 5,
  rootAgentsOnly: true,
  language: "zh",
  injectGuidance: true,
};
