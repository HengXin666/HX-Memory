// src/capture/pipeline.ts — 捕获管道: 把 turn 捕获并持久化到存储。
// 这是 DSH adapter 会调用的入口: 一轮 turn → 记忆入库。
// 依赖: capture engine (纯逻辑) + MemoryStore 端口 (不依赖具体存储实现)。
// v2: 接入可选 TurnStructurer (AI 结构化增强) — 先落确定性捕获, 再结构化增强;
//     结构化失败不影响入库 (增强不是门槛)。
// v3 (决策反转): 记忆层从**转录**改为**提炼** —— 有 conclusion 时 content 用结论,
//     原始问答逐字留在 episode 日志里并由 derivedFrom 指回 (ADR-018 不受影响)。
//     没有 conclusion (启发式兜底/AI 失败) 时 content 仍是原文, 与 v2 行为一致。
// v4 (2026-09): 每一段的耗时被**测出来**交给调用方 (CaptureOptions.onTiming)。
//     为什么新增: 捕获对宿主是异步的, 但异步不等于免费 —— 它调 LLM、读全库建边、同步写 SQLite,
//     全都在对话所在的 event loop 上。此前"这一轮怎么慢了"在证据上完全无法回答。
//     本文件只**测量**, 不决定记到哪 (那是 adapters/dsh/capture-log.ts 的事)。
import {
  captureTurn,
  isInterrogative,
  type CaptureOptions,
  type TurnInput,
  type CaptureResult,
} from "./engine.ts";
import type { MemoryEntry } from "../kernel/types.ts";
import type { MemoryStore } from "../kernel/ports.ts";
import { heuristicStructurer, type TurnStructurer } from "./structurer.ts";
import { planStructuralLinks } from "../evolution/link.ts";
import { entitiesOf } from "../kernel/entity.ts";
import { extractTags } from "../storage/entry-normalize.ts";
import { enqueueCaptureReview, reviewReasons } from "./review-queue.ts";
import type { Relation } from "../kernel/types.ts";

export interface PipelineOptions {
  /** AI 结构化增强 (可选; 默认启发式兜底)。 */
  structurer?: TurnStructurer;
  /**
   * 单次写入最多建几条结构关联边 (默认 3; 0 = 关闭)。
   *
   * 为什么捕获路径也要建边: 结构关联 (`planStructuralLinks`) 此前只在
   * `facade.remember()` 里调用, 而`自动捕获`走的是 pipeline.write 直连存储 ——
   * 于是"日常对话沉淀下来的记忆"永远不建边。实测真实库 80 条里 56 条孤立,
   * 边只有规则推广产生的 generalizes, 图检索因此无东西可扩展。
   */
  maxStructuralLinks?: number;
  /**
   * 待审队列的根目录 (缺省 `.tmp/hx-memory-review`)。
   *
   * 为什么要显式给: 队列与真相文件同根才有意义 (人知道去哪儿找), 而 pipeline 此前只拿
   * MemoryStore 端口、不持有 root。缺省值刻意落在临时目录 —— 未显式配置时不该往用户的
   * 真相目录里写新文件 (那会让人困惑"这个 review-capture 是何时冒出来的")。
   */
  reviewRoot?: string;
}

export class CapturePipeline {
  private readonly hashes = new Set<string>();
  private readonly structurer: TurnStructurer;

  // 显式字段 + 赋值 (不用 TS 参数属性): Node strip-only 模式不支持, 子进程 import 时会崩。
  private readonly store: MemoryStore;
  private readonly maxStructuralLinks: number;
  /** 待审队列根目录 (见 PipelineOptions.reviewRoot)。 */
  private readonly reviewRoot: string;

  constructor(store: MemoryStore, opts: PipelineOptions = {}) {
    this.store = store;
    this.structurer = opts.structurer ?? heuristicStructurer();
    this.maxStructuralLinks = opts.maxStructuralLinks ?? 3;
    this.reviewRoot = opts.reviewRoot ?? ".tmp/hx-memory-review";
  }

  /**
   * 捕获一轮并入库。返回本次实际新增的条目。
   *
   * 疑问句开头的轮次有一条额外规则: **只有结构化器读出结论才落盘**。
   * 因为问句本身不是记忆, 它后面的结论才是; 读不出结论说明这一轮只是讨论,
   * 存下来就是噪声 (实测旧路径 15% 的记忆是问句转录)。
   *
   * opts.onTiming 每轮**恰好回调一次** (含"一条都没落盘"的情形) —— 缺了那条,
   * 账本就会系统性地漏掉最该解释的那些轮次。
   */
  async run(input: TurnInput, opts: CaptureOptions = {}): Promise<CaptureResult> {
    const started = Date.now();
    const result = captureTurn(input, opts, this.hashes);
    // 命中负面/纠正信号的轮次 (由 engine 判定, 这里只读结果) —— 影响两处:
    // ① 不建边 (教训是行为层, 与实体共现无关); ② 不进审核队列 (见下方闸门说明)。
    const negativeHit = result.negative !== undefined && result.entries.length > 0;
    // 被提炼闸门丢掉的条数单独计数: 它与"指纹重复"是两回事 (前者说明这一轮读不出结论,
    // 后者说明早就存过), 而调用方要据此区分"这轮没沉淀"的成因 —— 混进 deduped 就分不出来了。
    let noConclusion = 0;
    /** 进待审队列的条数 (与"丢弃"分开计数: 前者待人裁决, 后者确实没有可沉淀内容)。 */
    let reviewQueued = 0;
    const enriched: MemoryEntry[] = [];
    const needsConclusion = isInterrogative(input.text);
    let skipped = 0;
    let enrichMs = 0;
    /** 本轮是否出现过"能出结论的实现"参与 (见 CaptureResult.concludeCapable)。 */
    let sawConcludeCapable = false;
    /** 本轮是否**走过 enrich** (与"有没有结论能力"分开 —— 见该字段的三态说明)。 */
    let sawEnrich = false;
    let linkMs = 0;
    let storeMs = 0;
    const mark = (): number => Date.now();
    for (const e of result.entries) {
      const beforeEnrich = mark();
      const enrichedOut = await this.enrich(e, input.answer);
      const enhanced = enrichedOut.entry;
      enrichMs += mark() - beforeEnrich;
      sawEnrich = true;
      if (enrichedOut.ok) sawConcludeCapable = true;
      // ⚠ 2026-09-18 对称化 (实测: 同一句只差一个问号, 处置却相反):
      //   疑问句无结论 → 旧逻辑**直接丢弃**; 陈述句无结论 → 进待审队列。
      //   实测对照 ("决定采用哪个方案? 缓存过期要设多少" vs "决定采用方案 A, 缓存过期设 60 秒"):
      //   前者 noConclusion=1 且一条不留, 后者进待审 —— 后者才符合"不丢, 交给人裁决"的价值观。
      //   因此这里不再直接丢: **有提炼能力但读不出结论**一律交给下游的待审闸门统一处置
      //   (它会把"无结论"作为一条 reason 记进队列)。只有**能力缺失**(启发式兜底)时才保持
      //   原行为 —— 那种情况下本就没有结论可言, 不该把所有轮次推进队列。
      //
      // 计数语义保持: noConclusion 仍记"因缺结论而未落盘"的条数 (它们现在同时进待审),
      // 面板据此解释"这轮为什么没进库"。
      // 负面信号轮次**不过这道闸**: 它没有 conclusion 是正常的 (教训草稿本身就是结论),
      // 而"能力缺失时丢掉"的原判据会把"你能不能别这么傻逼"这类**疑问句形态的批评**一并丢掉。
      if (!negativeHit && needsConclusion && !enhanced.structured?.conclusion && !enrichedOut.ok) {
        skipped++;
        noConclusion++;
        continue; // 能力缺失: 本就没有结论可言 → 不落盘 (原行为)
      }
      // ---- 审核闸门 (语义已反转: **先落盘, 事后剔除**) ----
      //
      // ⚠ **2026-10-05 语义反转** (用户明确要求): 旧实现是"可疑 -> 不落盘, 进队列等人裁决",
      // 也就是**审核阻止记忆入库**。用户的原话: "审核机制是用于剔除你的记忆, 而不是说阻止
      // 你的记忆加入到记忆中"。旧语义的代价可量化: 真库 139 条待审**全部 pending**
      // (0 条被裁决过), 其中 133 条是 uncited 判据误杀 —— 那些内容既不在库里、也不在人眼里,
      // 等于**静默丢弃**。而"审核"本来的价值是"入库之后人还能挑掉它"。
      //
      // 现在的处置 (两档, 不再是"落盘/待审/丢弃"三档):
      //   · 经得起检查 -> 落盘, 不进队列 (与"审核不存在"完全一致);
      //   · 可疑 (无结论 / 与原文重合 >90% / 未引用回答里的具体标识符) -> **照常落盘**,
      //     同时进队列并记下理由 —— 队列变成"已落盘、可被剔除"的待办清单。
      //     面板上的 reject 会把它写成 shadow (撤回是持久的, 重建不复活); accept 只是确认留着。
      //
      // 为什么反转是对的 (而不是"把判据修准就够了"): 待审判据是**启发式**, 它的误杀率
      // (实测 133/139) 决定它**没有资格**当写入闸门; 而它作为"人审的线索"仍然有价值 ——
      // 前提是它拦不住任何东西。与召回闸"只能收紧不能放宽"是同一道理的反面:
      // 写入**不可逆**, 因此任何启发式都只该做**建议**, 不该做**否决**。
      //
      // 负面信号轮次不进队列: 它的内容是"教训草稿"而非原话, 天然不引用 answer 里的标识符
      // (教训的形状不是引用路径), 会**必然**命中 uncited 误杀判据 —— 那正是要消灭的噪声。
      const reasons = negativeHit
        ? []
        : reviewReasons({
            conclusion: enhanced.structured?.conclusion ?? "",
            question: input.text,
            answer: input.answer ?? "",
            // 判据来自结构化器**自己声明的能力** (canConclude): 前两版推断判据
            // (Boolean(structurer) / Boolean(structured?.summary)) 都被实测证伪 ——
            // makeLlmStructurer 的构造不抛异常, 启发式兜底也返回 summary, 两者都会在
            // 无 LLM 环境误启用待审 (实测 42 / 39 个测试失败)。
            expectConclusion: enrichedOut.ok,
          });
      if (reasons.length) {
        // ⚠ 入队在落盘**之前**, 但不再 continue —— 条目照常落盘 (见上方语义反转说明)。
        enqueueCaptureReview(this.reviewRoot, {
          id: enhanced.id,
          at: new Date().toISOString(),
          reasons,
          question: input.text.slice(0, 500),
          conclusion: enhanced.structured?.conclusion?.slice(0, 500) ?? "",
          answerExcerpt: (input.answer ?? "").slice(0, 300),
          ...(input.project ? { project: input.project } : {}),
          session: input.session,
          // 保留溯源: 人裁决时要能追到原话 (剔除决定也才连得上证据链)。
          ...(input.episodeIds?.length ? { episodeIds: input.episodeIds } : {}),
        });
        reviewQueued++;
      }
      // withStructuralLinks 是 async (要读既有条目做共现比较), 必须 await。
      //
      // 负面信号轮次**跳过建边**: 教训是行为层约束 ("禁止X。改为Y。"), 它没有实体可共现 ——
      // 强行建边只会按标签 (`general`) 把互不相干的教训连成一团, 而那正是 link.ts 明令避免的。
      const beforeLink = mark();
      const linked = negativeHit ? enhanced : await this.withStructuralLinks(enhanced);
      linkMs += mark() - beforeLink;
      const beforeStore = mark();
      await this.store.add(linked); // 端口允许异步后端: 必须 await
      storeMs += mark() - beforeStore;
      this.hashes.add(e.id.slice(1)); // "c<hash>" → hash
      enriched.push(linked);
    }
    const out: CaptureResult = {
      ...result,
      entries: enriched,
      deduped: result.deduped + skipped,
      noConclusion,
      reviewQueued,
      // 三态 (见 CaptureResult.concludeCapable): 没走 enrich → undefined; 走了但无结论能力
      // → false; 有过结论能力 → true。一轮通常只产 0~1 条条目, 所以"有一次"即"这一轮"。
      ...(sawEnrich ? { concludeCapable: sawConcludeCapable } : {}),
    };
    opts.onTiming?.({
      episodeMs: (opts.episodeMs ?? 0) | 0,
      enrichMs,
      linkMs,
      storeMs,
      totalMs: Date.now() - started,
    }, out);
    return out;
  }

  /**
   * 给条目补结构关联边 (实体/标签共现)。
   *
   * 为什么在这里而不是 enrich 里: enrich 只做"单条文本 → 结构化字段", 不知道库里还有什么;
   * 建边需要**与既有条目比较**, 是另一件事。放在写入前一步, 失败也不影响落盘。
   * 候选面用 all() (捕获频率低, 且正确性优先于省这一读)。
   */
  private async withStructuralLinks(entry: MemoryEntry): Promise<MemoryEntry> {
    if (this.maxStructuralLinks <= 0) return entry;
    // 前置门必须用与建边**同一套口径**判断"有没有可用的实体/标签"。
    //
    // 2026-09-18 修复: 此前只看 entry.entities/entry.tags 这两个**真相字段** ——
    // 而启发式结构化器按设计不产 entities (见 structurer.ts 的说明), 于是绝大多数条目
    // 在进建边函数之前就被这道门挡掉。实测真实库: 193 条里只有 30 条 (16%) 有出边,
    // 而实体**兜底抽取**的实际覆盖是 82% —— 即"有实体"的条目大量被这道门拦在了建边之外。
    // 这正是"索引侧兜底 vs 真相字段"断链的第二次出现 (第一次是 planStructuralLinks 本身)。
    // 用 entitiesOf (显式优先, 缺失时确定性抽取) 与 tagsOrExtracted 保持两侧一致。
    const hasEntities = entitiesOf(entry).length > 0;
    const hasTags = (entry.tags ?? []).length > 0 || extractTags(entry.content).length > 0;
    if (!hasTags && !hasEntities) return entry;
    try {
      const existing = await this.store.all();
      const planned = planStructuralLinks(entry, existing, { maxLinks: this.maxStructuralLinks });
      if (!planned.length) return entry;
      const merged: Relation[] = [...(entry.relations ?? [])];
      for (const rel of planned) {
        if (merged.some((r) => r.type === rel.type && r.toId === rel.toId)) continue;
        merged.push(rel);
      }
      return merged.length === (entry.relations ?? []).length ? entry : { ...entry, relations: merged };
    } catch {
      return entry; // 建边是增强: 失败不影响落盘
    }
  }

  /**
   * 结构化增强。
   *
   * 返回的第二项 `structured_ok` 表示**本轮真的调用了会产出结论的结构化器并成功返回** ——
   * 它是待审闸门的适用条件: 只有"LLM 读了但没提炼出结论"才算候选可疑;
   * LLM 不可用/调用失败回退到启发式时, "无结论"是能力缺失, 不该进待审队列
   * (实测: 判错该条件会让无 LLM 环境的所有候选进队列, 自动沉淀全停摆)。
   *
   * 为什么由这里回报而不是在构造函数里判断: `makeLlmStructurer` 的**构造**不抛异常,
   * 且启发式兜底**也**产出 summary —— 任何"装配期静态判断"都会被这两种情况骗过
   * (两版判据各自导致 42 / 39 个测试失败)。只有调用结果能反映真相。
   */
  private async enrich(e: MemoryEntry, answer?: string): Promise<{ entry: MemoryEntry; ok: boolean }> {
    try {
      const s = await this.structurer.structure({
        text: e.content,
        ...(answer ? { answer } : {}),
        ...(e.project ? { project: e.project } : {}),
      });
      if (!s || !s.summary) return { entry: e, ok: false };
      // 只有 AI 给出**结论**时才替换 content; 否则保留原文 (失败/无结论都不丢信息)。
      const conclusion = s.conclusion?.trim();
      return {
        entry: {
          ...e,
          ...(conclusion ? { content: conclusion } : {}),
          tags: s.tags.length ? s.tags : e.tags,
          ...(s.entities?.length ? { entities: s.entities } : {}),
          // §765: 与 entities 同一模式 —— 只有抽取层真的给了值才透传 (缺省仍走中性常量)。
          ...(s.importance === undefined ? {} : { importance: s.importance }),
          ...(s.confidence === undefined ? {} : { confidence: s.confidence }),
          structured: s,
        },
        // ok 的语义是"**结果来自能出结论的实现**", 不是"调用没报错" ——
        // 启发式兜底同样会正常返回 (summary/tags/points), 但它按设计从不产 conclusion,
        // 因此不算"有结论能力" (实测: 用"调用成功"当判据会让无 LLM 环境全部进待审)。
        ok: Boolean(this.structurer.canConclude),
      };
    } catch {
      return { entry: e, ok: false }; // AI 失败 → 原样落盘, 不丢
    }
  }

  /** 从存储回填指纹 (重启后去重仍有效)。全量读取: 只回填最近 N 条会让老记忆被重复捕获。 */
  async warmUp(): Promise<number> {
    const all = await this.store.all();
    let n = 0;
    for (const e of all) {
      if (e.id.startsWith("c")) {
        this.hashes.add(e.id.slice(1));
        n++;
      }
    }
    return n;
  }
}
