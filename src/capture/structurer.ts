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
  /**
   * 抽出的**实体** (规范化名): 人/项目/文件/组件/服务等可被复用的专名。
   *
   * 为什么它必须由抽取层产出: 它决定"结构关联"能不能建起来 ——
   * `planStructuralLinks` 按实体/标签共现建边, 实体为空时图上只剩孤立点。
   * 实测真实库 entities 填充率 **0%**, 正是因为这一层从来没产出过该字段 (它当时都不存在)。
   *
   * 与 conclusion 的取舍一致: 只有能可靠判断时才产出, 拿不准就留空 ——
   * 垃圾实体会把不相关的记忆连成一团, 比没有边更糟。
   */
  entities?: string[];

  /**
   * **重要性 1..10** (缺省视为中性 5): 影响排序与整合优先级。
   *
   * 与 `entities`/`conclusion` 同一个处置 (§765): 该字段自 ADR 起就声明在 `MemoryEntry` 上,
   * 而**从未有任何一层产出过它** —— 于是 `compositeScore` 里的 `importanceFactor`
   * 恒为 0.778 (**对所有条目相同, 在排序上不区分任何东西**)。
   *
   * 为什么必须由抽取层产出: 排序要区分"这条重要吗", 而那需要**读内容**才知道 ——
   * 写入方 (工具/CLI) 只拿到一段文本, 判断不了。
   */
  importance?: number;

  /**
   * **置信度 0..1** (缺省 0.7): 低置信条目排序降权, 但不被丢弃。
   *
   * 与 `importance` 同上 (§765): 从未被产出的后果更具体 ——
   * `adjudicator` 里有一条判据 "**候选置信度不低于目标才允许取代**",
   * 而两边都取缺省值 ⇒ 差恒为 0 ⇒ **那条判据从不生效**, 且 `supersede` 的
   * `confidence` 恒为 0.6 (margin 恒 0)。**一个设计好的判据恒不触发**比"字段空着"更值得修。
   */
  confidence?: number;
}

export interface TurnStructurer {
  /**
   * 这是否是**具备提炼能力**的实现 (能产出 conclusion)。
   *
   * 为什么必须由实现**显式声明** (2026-09-18; 实测代价: 两版推断判据各自导致 42 / 39 个测试失败):
   * "无结论"有两种成因且处置相反 ——
   *   · 能力缺失 (启发式兜底 / LLM 不可用) → 保持原行为 (直接落盘);
   *   · 候选可疑 (LLM 读了但没提炼出来) → 进待审队列。
   * 而这两种情况**从外部无法区分**: 启发式兜底同样返回 summary/tags/points;
   * makeLlmStructurer 的构造不抛异常, 运行时失败还会被 catch 回退。
   * 任何"看返回形状"或"看装配期对象"的推断都被实测证伪, 因此交由实现自己声明。
   */
  readonly canConclude?: boolean;

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
    // 兜底**刻意不产 conclusion** (见 structure 内的说明): 因此它不具备结论能力,
    // 待审闸门不得据此把"无结论"判成候选可疑 (那会让无 LLM 环境全部进队列)。
    canConclude: false,
    async structure(input) {
      const text = input.text.trim();
      const points = text.length > 120 ? splitPoints(text) : [text];
      // 兜底**刻意不产 conclusion / entities**: 规则没法可靠判断"这一轮到底定没定",
      // 也没法可靠抽出专名。产错比不产更糟 —— 错的实体会把不相干的记忆连成一团。
      // 因此没有模型时: content 保持原文, 图上不新增边 (行为与旧版一致)。
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