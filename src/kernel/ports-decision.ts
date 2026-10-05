// src/kernel/ports-decision.ts — 决策端口: 把「快速判定」抽象出来, 换实现不改业务代码。
//
// ## 为什么要这一层 (HX-Jungle 实测, 2026-09-26)
//
// 判定的需求到处都有 —— "这个子问题该不该召回记忆?"; "新信息是补充当前任务还是另开一个?";
// "这条失败该归到哪一类?"。如果每处都直接调某个具体模型, 就产生了耦合: 模型换了、限流了、
// 涨价了, 业务代码要跟着改; 而且**无法替换更快的实现**。
//
// 实测对比 (本机):
//   · 概率判官 (JEV): 单次 ~0.45s, 成本极低, 输出**稳定的原子判定** (是/否 + 概率);
//   · 通用大模型: 单次十几秒, 成本高, 输出自由文本。
// 两者差几个量级 —— 判定是高频窄问题, 不该走通用模型。
//
// ## 本层只声明形状, 不做任何判定
//
// 与 kernel/ports.ts 里其余端口同一纪律: **kernel 只依赖端口**, 实现放在 adapters/。
// 决策能力的实现 (JEV / 别的模型 / 子进程 / 纯启发式) 都在 adapters/decision/ 下,
// 由组装根接线并**按能力探测**选择 —— 接线点是 adapters/dsh/decision-wiring.ts。
//
// ## 三条硬纪律 (来自实测标定, 对所有实现都成立, 写在这里因为它们约束**调用方**)
//
// 1. **state 的措辞权重高于问题本身。** 同一候选集, state 措辞不同会让投票 7/7 选中不同答案,
//    而且两者都对 —— 是 state 的歧义导致分歧。所以调用方要给**症状与已确认事实**,
//    不许给"我以为的结论"(实测: 写结论会让判定反转)。
// 2. **一致性 ≠ 正确性。** 投票只解决噪声, 不解决歧义: 状态模糊时它会**稳定地给同一个错答案**
//    (实测 12/12, 置信度 1.00)。调用方拿到高一致度**不等于**可以免于复核。
// 3. **端口是路由器不是权威。** 任何判定结果都只是"输入信息指向的结论"。
//    因此本端口的所有可信度字段都叫 `confidence` / `agreement` 这类名字,
//    不提供任何 `isCorrect` 式的名字 —— 不让人误当成真值判据。

/** 一个问题。`choice` 需要 `criteria`; `noul` (概率) 与 `score` 不需要。 */
export interface DecisionQuestion {
  /** 问题 id (调用方用来取回答案)。 */
  qid: string;
  type: "choice" | "noul" | "score";
  /** 问题本身。**不许写结论**, 写要判定的症状 (见文件头注的纪律 1)。 */
  instructions: string;
  /** choice 用: 选项 id → 说明。 */
  criteria?: Record<string, string>;
}

/** 一个问题的答案。字段随 type 变化 —— 只读自己 type 对应的那个。 */
export interface DecisionAnswer {
  type: "choice" | "noul" | "score";
  /** choice 类型: 选中的选项 id。 */
  choice?: string;
  /** noul 类型: 0..1 的概率。 */
  noul?: number;
  /** score 类型: 分数。 */
  score?: number;
  /** 实现自报的置信度 (可选; 不是正确度)。 */
  confidence?: number;
  /** 各选项概率 (可选; 有它就能看分布而不只看最高票)。 */
  probabilities?: Record<string, number>;
}

/** 一次判定的结果。 */
export interface DecisionOutcome {
  ok: boolean;
  answers: Record<string, DecisionAnswer>;
  /** 0..1: 多次采样的一致度 (实现自报)。**不是正确度** (纪律 2)。 */
  agreement: number;
  /** 0..1: 概率分布的锐度 (最高 - 次高)。低 = 候选之间模型自己也没区分开。 */
  sharpness?: number;
  /** 实现自报的元信息 (模型名/耗时/用量) —— 进日志, 便于事后追因。 */
  meta?: Record<string, unknown>;
  /** 失败原因 (ok=false 时)。空串表示没失败。 */
  error: string;
}

/**
 * 适配器自报能力。调用方**必须**读这里, 不得假设实现性质。
 *
 * 这是本契约的核心: 它让调用方能写"与实现无关"的代码 ——
 * 例如 `if (!caps.deterministic) samples = Math.max(samples, 7)`,
 * 而不是写死"JEV 要投 7 次票"。
 */
export interface DecisionCapabilities {
  name: string;
  /** 一次调用能否答多题。false 时调用方应逐题调用。 */
  parallelQuestions: boolean;
  /** 同输入是否稳定复现。false ⇒ 必须投票才有意义。 */
  deterministic: boolean;
  /** 是否必须多次采样才稳。 */
  needsVoting: boolean;
  /** 延迟档位: fast(<1s) | medium | slow。 */
  latencyClass: "fast" | "medium" | "slow";
  /** 成本档位。 */
  costClass: "low" | "medium" | "high";
}

/**
 * 决策端口。任何满足本接口的实现都可直接替换。
 *
 * 三个方法都是**可选实现**的(调用方按能力探测): `doctor()` 用于可用性自检,
 * 缺失时视为"无法自检"(不阻塞, 只是没有预检能力)。
 */
export interface DecisionPort {
  readonly name: string;
  capabilities(): DecisionCapabilities;
  decide(state: string, questions: readonly DecisionQuestion[], samples?: number): Promise<DecisionOutcome>;
  /**
   * 可用性自检: 探一次真调用, 报告 key 是否存在、延迟、样例答案。
   *
   * 为什么需要它: "不可用"有两种 —— 配置缺失 (没有 key) 与上游故障 (超时/500)。
   * 两者的处置不同 (前者该提示人去配, 后者该静默降级), 而**都不该等到业务路径上才发现**。
   */
  doctor?(): Promise<DecisionDoctorReport>;
}

/** `doctor()` 的报告。 */
export interface DecisionDoctorReport {
  ok: boolean;
  adapter: string;
  /** 不可用原因 (ok=false 时): 如 "no_key" / 异常摘要。 */
  error?: string;
  /** 自检往返延迟 (ms); 探不通时缺省。 */
  latencyMs?: number;
  /** 其他实现自报的元信息 (api/model/usage 等)。 */
  [key: string]: unknown;
}
