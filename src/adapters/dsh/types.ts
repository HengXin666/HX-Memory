// src/adapters/dsh/types.ts — DSH adapter 的运行时设置形状。
// 命名空间常量在 settings.ts (单一来源), 这里只放类型与默认值。

import { DEFAULT_SCHEDULE_RETENTION_DAYS } from "./schedule-log.ts";
import { DEFAULT_CAPTURE_RETENTION_DAYS } from "./capture-log.ts";

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
  /**
   * 注入时机: `first` = 只在会话首轮注入一次; `every-turn` = 逐轮注入 (差量, 只补新条目)。
   * 默认 every-turn: 会话中途出现的回忆型提问仍能拿到具体历史 (差额只是新增条目)。
   */
  injectMode: "first" | "every-turn";
  /** 写入期自动演化 (显式更新信号 → 取代链; 矛盾 → 标记)。关掉只保留字面去重与建边。 */
  autoEvolve: boolean;
  /**
   * 注入前预热异步向量投影的硬时限 (ms)。
   * 0 = 不预热 (预步永不等待); 50 是"几乎无感但足以补齐首批向量"的默认值。
   */
  semanticWarmupMs: number;
  /**
   * 决策层开关 (**默认关**)。
   *
   * 打开后, 每轮注入前会用判官 (JEV) 判一次"当前输入与候选记忆是否相关",
   * 判定"无关"时抑制该轮召回。判官不可用/没把握/连续失败 n 次时**自动走既有通道**
   * (保底 + 意图), 因此打开它不会让记忆失效 —— 最坏后果是退回打开前的行为。
   *
   * 为什么默认关: 它给每轮注入加一次 ~0.5s 的同步开销, 而"值不值得"取决于用户对
   * 延迟与精度的偏好 —— 这是取舍, 不该由默认值替用户决定。
   */
  decisionGate: boolean;
  /** 决策账本保留天数 (0 = 永久)。 */
  decisionRetentionDays: number;
  /**
   * always-on 保底通道的**条数上限** (默认 3; 0 = 不限制)。
   *
   * 为什么有它 (2026-09-29, 用户实测 "太多无用上下文"): token 预算只管"总长度",
   * 管不住"9 条平铺各自占用注意力"。保底通道的目的是**不变量**, 不是把库里所有规则倒出来。
   * 取"分最高的 N 条", 被挡的进 blocked 报告 (面板可解释)。
   */
  alwaysOnMaxEntries: number;
  /** 记录原始轮次 (episode 追加日志): 支撑"换抽取器 → 全量重放"; 关掉则只留抽取结果。 */
  captureEpisodes: boolean;
  /** episode 保留天数 (0 = 永久保留)。 */
  episodeRetentionDays: number;
  /**
   * 注入调度账本 (默认开): 每一步把判定落进 <root>/schedule/YYYY-MM-DD.jsonl。
   * 为什么独立开关: 它记录的是"为什么注入/为什么没注入", 与捕获 (autoCapture) 无关 ——
   * 关掉捕获仍要能看见调度行为, 反之亦然。写入永远 best-effort, 写不进去不影响对话。
   */
  scheduleLog: boolean;
  /** 调度账本保留天数 (0 = 永久)。它是可观测性账本, 因此默认比 episode 短得多。 */
  scheduleLogRetentionDays: number;
  /**
   * 捕获耗时账本 (默认开): 每一轮落一条 <root>/capture/YYYY-MM-DD.jsonl。
   *
   * 为什么需要它: 捕获对宿主是异步的, 但它调 LLM、读全库建边、同步写 SQLite, 全都在对话
   * 所在的那个 event loop 上。没有它, "这一轮怎么慢了"只能靠猜 —— 唯一的计时证据是宿主日志
   * 里的一行, 与具体哪一轮对不上号, 重启后也拿不到。
   */
  captureLog: boolean;
  /** 耗时账本保留天数 (0 = 永久)。与调度账本同理: 观测数据, 比 episode 短。 */
  captureRetentionDays: number;
  /**
   * 后台维护周期 (小时; 0 = 关闭)。开启时在**空闲窗**内跑 `consolidate` 与 episode/schedule 清理。
   * 为什么默认开: 只通过面板/对话使用记忆的用户永远不会手动跑 CLI —— 没有它, 事件类条目
   * 从不衰减、清理从不发生, 记忆层会单调增长 (P3 的 ⬜ 调度器)。
   */
  maintenanceIntervalHours: number;
  /**
   * 维护前的空闲时长 (分钟): 距上次会话活动超过它才认为"现在没人写真相文件"。
   * 维护写的是 Markdown, 与宿主捕获并发会丢写, 因此宁可等。
   */
  maintenanceIdleMinutes: number;
  /** AI 结构化提示词 (可编辑, 缺省用默认)。 */
  structurerPrompt?: string;
  /** AI 规则提炼提示词 (可编辑, 缺省用默认)。 */
  abstractorPrompt?: string;
  /**
   * **负面/纠正信号词表** (2026-10-05, 用户要求"直接给个地方让用户配置")。
   *
   * 三行一组 (`blame-method:` / `blame-execution:` / `correction:`), 其余行按类别名解析。
   * 每条可以是**字面串**或 `/正则/`。空 = 用内置缺省词表 (`DEFAULT_NEGATIVE_WORDS`)。
   * 命中后会: ① 把该轮落成 lesson (不是原话); ② 顺带注入同类铁律 (见 negativityGate)。
   */
  negativityWords?: string;
  /**
   * 命中负面信号时是否**顺带注入**同类铁律 (默认 true)。
   *
   * 为什么默认开: 用户的原话是"看看这个问候是否指明的方向, 指明的方向就应该沉淀 ——
   * 是不是别人都骂你了, 你为什么不记住这次的教训"。只有"沉淀"没有"当下就用上"，
   * 那条教训要等下一次检索才可能被想起 —— 而"被骂"这个时刻恰恰是最该立刻看到它的时刻。
   */
  negativityGate?: boolean;
  /**
   * 是否调用判官 (JEV) 做负面信号的**兜底判定** (默认 false)。
   *
   * 词表是确定性的但覆盖有限 (用户会换新词); 判官能识别"这句话在骂人/在纠正"这个语义。
   * 默认关的理由与 decisionGate 一致: 它给每轮加一次 ~0.5s 的同步开销, 是取舍不是默认值。
   * **只在前置词表未命中时调用** —— 命中时零开销。
   */
  negativityJudge?: boolean;
}

export const DEFAULT_SETTINGS: HxMemorySettings = {
  autoCapture: true,
  autoMemoryInterval: 1,
  rootAgentsOnly: true,
  language: "zh",
  injectGuidance: true,
  injectBindings: true,
  injectMode: "every-turn",
  autoEvolve: true,
  semanticWarmupMs: 50,
  alwaysOnMaxEntries: 3,
  decisionGate: false,
  decisionRetentionDays: 7,
  captureEpisodes: true,
  episodeRetentionDays: 90,
  scheduleLog: true,
  scheduleLogRetentionDays: DEFAULT_SCHEDULE_RETENTION_DAYS,
  captureLog: true,
  captureRetentionDays: DEFAULT_CAPTURE_RETENTION_DAYS,
  maintenanceIntervalHours: 6,
  maintenanceIdleMinutes: 10,
  negativityWords: "",
  negativityGate: true,
  negativityJudge: false,
};
