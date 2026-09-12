// src/capture/structurer.ts — AI 参与存储结构化: turn → 结构化摘要/标签/要点。
// 设计:
//   - TurnStructurer 是端口: DSH adapter 注入真实 agent 实现 (llm-abstractor 里的 agentSummarize);
//   - 默认 heuristicStructurer 兜底 (离线/失败/测试环境: 纯规则, 确定可测);
//   - 结构化是"增强"不是"门槛": 失败时原样落盘, 捕获永不因 AI 故障而丢。


export interface StructuredTurn {
  /** 提炼后的摘要 (比原文更可检索、可审计)。 */
  summary: string;
  /** 标签 (进入 SQLite tags 索引, 支持按 tag 召回)。 */
  tags: string[];
  /** 要点 (结构化片段, 便于人读与后续推广引用)。 */
  points: string[];
  /**
   * 提炼后的**结论** (决策 / 教训 / 偏好本身)。
   *
   * 为什么它决定 content: 记忆要回答的是"最后定了什么、为什么", 不是"我问了什么"。
   * 有一层必须说清: 这不是改写历史 —— 原始问答仍逐字留在 episode 日志里 (ADR-018),
   * 条目通过 derivedFrom 指回去, 抽查与重放都不受影响; 变的只是**记忆层**从转录升为提炼。
   * 缺省 (启发式兜底 / AI 失败) 时不产出, content 退回原文, 行为与旧版一致。
   */
  conclusion?: string;
}

export interface TurnStructurer {
  /**
   * 结构化一轮问答。
   * input.answer 是**同一个设计的一部分**: 只有问题没有回答时, 结论与理由无从谈起
   * (实测旧路径下 15% 的记忆是疑问句本身)。
   */
  structure(input: { text: string; answer?: string; project?: string }): Promise<StructuredTurn>;
}

/** 默认启发式结构化: 不调 AI, 纯规则确定可测。 */
export function heuristicStructurer(): TurnStructurer {
  return {
    async structure(input) {
      const text = input.text.trim();
      const points = text.length > 120 ? splitPoints(text) : [text];
      // 兜底**刻意不产 conclusion**: 规则没法可靠判断"这一轮到底定没定";
      // 产错结论比不产更糟 (会覆盖掉原文)。content 因此保持原文。
      return {
        summary: text.length > 200 ? text.slice(0, 200) + "…" : text,
        tags: inferTags(text),
        points,
      };
    },
  };
}

function splitPoints(text: string): string[] {
  return text
    .split(/[。！？!?\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

const TAG_SIGNALS: Array<[RegExp, string]> = [
  [/并发|concurrency|race|deadlock|锁|幂等|idempoten/i, "concurrency"],
  [/容器|docker|k8s|kubernetes|deploy|部署/i, "container"],
  [/超时|timeout|重试|retry/i, "resilience"],
  [/数据库|sql|查询|索引|database/i, "database"],
  [/性能|慢|优化|performance|benchmark/i, "performance"],
  [/安全|权限|auth|鉴权|泄露|安全/i, "security"],
  [/测试|单测|测试用例|test/i, "testing"],
];

function inferTags(text: string): string[] {
  const tags = new Set<string>();
  for (const [re, tag] of TAG_SIGNALS) {
    if (re.test(text)) tags.add(tag);
  }
  if (tags.size === 0) tags.add("general");
  return [...tags];
}