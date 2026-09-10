// src/adapters/dsh/types.ts — DSH adapter 的运行时设置形状。
// 命名空间常量在 settings.ts (单一来源), 这里只放类型与默认值。

export interface HxMemorySettings {
  /** 自动捕获开关。 */
  autoCapture: boolean;
  /** 每 N 轮完成对话批量入记忆 (1 = 每轮, 0 视为每轮)。 */
  autoMemoryInterval: number;
  /** 只捕获根 agent (忽略 subagent)。 */
  rootAgentsOnly: boolean;
  /** 指引语言。 */
  language: "zh" | "en";
  /** 会话开始注入记忆指引开关。 */
  injectGuidance: boolean;
  /** pre-step 确定性绑定注入开关 (与指引分开, 关掉指引不影响绑定注入)。 */
  injectBindings: boolean;
  /** 写入期自动演化 (显式更新信号 → 取代链; 矛盾 → 标记)。关掉只保留字面去重与建边。 */
  autoEvolve: boolean;
  /**
   * 注入前预热异步向量投影的硬时限 (ms)。
   * 0 = 不预热 (预步永不等待); 50 是"几乎无感但足以补齐首批向量"的默认值。
   */
  semanticWarmupMs: number;
  /** 记录原始轮次 (episode 追加日志): 支撑"换抽取器 → 全量重放"; 关掉则只留抽取结果。 */
  captureEpisodes: boolean;
  /** episode 保留天数 (0 = 永久保留)。 */
  episodeRetentionDays: number;
  /** AI 结构化提示词 (可编辑, 缺省用默认)。 */
  structurerPrompt?: string;
  /** AI 规则提炼提示词 (可编辑, 缺省用默认)。 */
  abstractorPrompt?: string;
}

export const DEFAULT_SETTINGS: HxMemorySettings = {
  autoCapture: true,
  autoMemoryInterval: 1,
  rootAgentsOnly: true,
  language: "zh",
  injectGuidance: true,
  injectBindings: true,
  autoEvolve: true,
  semanticWarmupMs: 50,
  captureEpisodes: true,
  episodeRetentionDays: 90,
};
