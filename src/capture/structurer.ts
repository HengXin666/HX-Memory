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
}

export interface TurnStructurer {
  structure(input: { text: string; project?: string }): Promise<StructuredTurn>;
}

/** 默认启发式结构化: 不调 AI, 纯规则确定可测。 */
export function heuristicStructurer(): TurnStructurer {
  return {
    async structure(input) {
      const text = input.text.trim();
      const points = text.length > 120 ? splitPoints(text) : [text];
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
