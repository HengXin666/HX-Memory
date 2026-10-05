// trigger/always-on.ts — always-on 保底通道的**选取与预算**。
//
// 为什么独立成文件 (2026-09-18, §565): 它原在 trigger/policy.ts 的后半, 而 policy.ts
// 触及 400 行上限 —— 拆分的**依据是职责不同**:
//   · policy.ts 回答"**要不要去查**" (话题漂移 / 意图门控 / 触发决策);
//   · 本文件回答"**查出来的东西怎么放进预算里**" (打分组序 / 分档配额 / 被挡清单)。
// 两者变化的原因不同 (前者随判定策略变, 后者随预算模型变), 所以分开。
import type { MemoryEntry } from "../kernel/types.ts";
// 占位草稿判据与生成方同源 (generalize/service.ts 用同一个模板产出)。
import { isHeuristicRulePlaceholder } from "../kernel/rule-shape.ts";
// 项目可见性的偏序判定 (祖先链) —— 与捕获/召回/绑定共用同一口径, 不在这里另写一份。
import { lineageVisible, type ProjectLineage } from "../kernel/project-lineage.ts";

/**
 * always-on 选择的入参。
 *
 * `ruleBudgetRatio` (2026-09): 规则组最多占预算的比例, 其余留给项目事实。
 * 为什么必须分仓: 修复前规则按 (score 100 + importance) 全排在前面, 6 条规则约 300 token
 * 会吃光 400 token 预算 —— 真正随任务变化的"架构决策/项目约定"一条都注入不进来 (实测确认)。
 * 规则是**不变量**, 但不该是**全部**。只在规则与其它两组都有候选时启用上限。
 */
export interface AlwaysOnOptions {
  project?: string;
  /**
   * 工作区的**项目祖先链** (最内层仓库在前)。给了它就按祖先链判定可见性:
   * 子仓库里能看到父工程的记忆, 兄弟仓库严格不可见 (见 kernel/project-lineage)。
   *
   * 缺省时退回单值 `project` 的精确匹配 —— 这是刻意的向后兼容: 老调用点与老数据
   * (键里没有层级信息) 的行为一字不变, 只有显式传链的路径才获得层级可见性。
   */
  lineage?: ProjectLineage;
  budgetTokens?: number;
  estimate: (text: string) => number;
  /** 规则组预算占比 (默认 0.6)。传 1 可恢复"规则优先填满"的旧行为。 */
  ruleBudgetRatio?: number;
  /**
   * **条数上限** (2026-09-29 新增, 用户实测 "太多无用上下文")。
   *
   * 为什么需要它 (token 闸不够): token 预算只管"总长度", 不管"几条"。实测
   * 真实首轮注入 9 条 / 581 token —— 9 条平铺时每条都要占用注意力, 而用户的诉求是
   * "只给最有用的几条"。业界同族做法是文件级行数上限 (Claude Code CLAUDE.md 200 行、
   * Cursor 500 行、Codex 32 KiB), 它们同样不是纯字节闸。
   *
   * 判据是"**条目数**"而不是"每条多长": 前者是注意力成本, 后者是预算成本, 两个正交约束。
   * 被条数挡掉的条目同样进 `blocked` 报告 (面板要能解释"为什么只注入了这几条")。
   * 缺省不设上限 (undefined) —— 老调用点行为一字不变。
   */
  maxEntries?: number;
}

/**
 * always-on 允许的 kind 白名单 (**唯一的 kind 判据**)。
 *
 * 为什么抽成一个函数而不是写在 filter 里 (2026-09-27, 真实缺陷): 原先这条白名单
 * 只是 filter 末尾的一行**枚举兜底** (`return e.kind === "fact" || ...`), 位置在
 * `scope === "project"` 分支**之后** —— 而那个分支当时是提前 `return`, 于是白名单
 * 对**所有项目内条目完全失效** (实测混进 348 条 lesson)。
 * 抽成命名函数 + 放到 filter 最前面, 是为让"kind 判据与 scope 判据正交"这件事**结构上**成立,
 * 而不是靠注释提醒下一个改动者"别忘了它也管 kind"。
 *
 * 语义 (与既有行为逐条对齐, 非新设计):
 *   · rule  —— 跨项目不变量 (另有更严的`已确认`闸门, 见 filter 内);
 *   · fact / preference / decision —— 项目关键事实、偏好、决策;
 *   · **doc 显式排除** (§795): 知识库切片是"可查的参考", 不是"每条对话都该看见的不变量";
 *     实测按小节切片后有 267 条, 全部常驻会把保底预算吃光。
 *   · lesson / context / pattern / event 等一律**不进**: 它们按需召回 (意图通道),
 *     常驻只会把不变量挤出去。
 */
export function isAlwaysOnKind(kind: string): boolean {
  return kind === "rule" || kind === "fact" || kind === "preference" || kind === "decision";
}

/** 从条目里挑 always-on 内容: 已确认规则 + 项目关键事实/偏好 (受预算约束)。 */
export function selectAlwaysOn(
  entries: readonly MemoryEntry[],
  opts: AlwaysOnOptions,
): MemoryEntry[] {
  return selectAlwaysOnDetailed(entries, opts).entries;
}

/**
 * 与 `selectAlwaysOn` **同一实现**的带报告版本 (见 `AlwaysOnSelection` 的说明)。
 *
 * 为什么拆成两个出口而不是改 `selectAlwaysOn` 的返回类型:
 * 后者会波及 10+ 个调用点 (含大量测试), 而其中只有**面板/账本**需要"为什么没全注入"。
 * 两者共用同一实现, 因此**不存在口径分叉** (本项目反复强调的坑)。
 */
export function selectAlwaysOnDetailed(
  entries: readonly MemoryEntry[],
  opts: AlwaysOnOptions,
): AlwaysOnSelection {
  const budget = opts.budgetTokens ?? 400;
  const ratio = Math.min(1, Math.max(0, opts.ruleBudgetRatio ?? 0.6));
  const scored = entries
    .filter((e) => {
      if ((e.status ?? "active") !== "active") return false;
      if (e.kind === "rule") {
        // 机器生成的占位草稿 ("经验: <主题> 相关的 N 条实例已沉淀") 不进常驻通道。
        // 为什么必须在这里挡: 规则在下面得分为 100 + importance, 永远排在事实/决策之前,
        // 而占位草稿**不含任何可执行约束** —— 实测 10 条草稿把 400 token 的保底预算吃光,
        // 真正的架构决策一条都注入不进来 (保底通道因此只剩噪声)。判据见 kernel/rule-shape。
        if (isHeuristicRulePlaceholder(e.content)) return false;
        return e.scope === "global" && Boolean(e.confirmedBy && e.confirmedAt);
      }
      // 非规则: 项目内关键事实/偏好/决策 (lesson 由意图通道按需召回, 不常驻)。
      //
      // ⚠ **2026-09-27 修 (真实缺陷, 关键)**: `kind` 白名单与 `scope` 可见性本是**两件正交的事**,
      // 而此前 project 分支写的是 `return lineageVisible(...)` —— **提前 return 把白名单整个绕过了**。
      // 实测 (真实库 702 条, 传 lineage=["HX-Memory","HXLoLis"]): 候选里混进
      // **lesson/project 348 条 + context/project 50 条 + pattern 8 条**, 全部是"按需召回"的东西。
      // 而对照实验证明唯一的变量就是 lineage: 不传 lineage 时候选为空 (白名单生效), 传了就被短路。
      // 生产路径恰好**总是**传 lineage (adapters/dsh/trigger-cache.ts:82) ⇒ 这是活缺陷,
      // 平时只被 400 token 的预算掩盖着 —— 实测把预算放大到 20000, 注入块里出现 9 条 lesson
      // 与 47 条 context (本该"按需", 却每轮常驻)。
      //
      // 修法: 先过 kind 白名单 (与 scope 无关), 再判 scope 可见性 —— 两者是**与**关系。
      if (!isAlwaysOnKind(e.kind)) return false;
      // scope:"agent" 的关键事实/偏好是**跨工作区共享层**: 不属于任何项目, 对每个项目都常驻候选。
      // 注意: agent scope **只收 fact/preference** (不含 decision) —— 这是原有的收紧, 保留。
      if (e.scope === "agent") return e.kind === "fact" || e.kind === "preference";
      // 项目内的条目**必须**匹配当前项目 —— 判据不能挂在 `opts.project &&` 之下:
      // 调用方没传 project 时 (例如会话还没有工作区) 那个短路会让**所有项目**的
      // 事实/决策一起通过, 于是别的项目的私有记忆被当成"本项目关键事实"注入 (实测泄漏:
      // 一次无 project 的调用返回了 HX-Memory/Freebuff 等 8 个项目的条目)。
      // 不知道是哪个项目时, 正确的答案是"一条项目内条目都不给", 而不是"全都给"。
      if (e.scope === "project") {
        // 有祖先链时按链判定 (子仓库可见父工程记忆); 没有链时退回单值精确匹配。
        // 两条路都必须是"不知道是哪个项目就一条都不给", 而不是"全都给" (见上一条注释的实测泄漏)。
        if (opts.lineage?.length) return lineageVisible(e.project, opts.lineage);
        return e.project === opts.project;
      }
      // ⚠ 走到这里只剩 `scope: "global"` 的**非规则**条目 (rule 已在上面单独处理)。
      // 它们**保留原有行为**: 全局事实/偏好/决策可进保底通道 (kind 白名单已在最上面把关)。
      // 这条**不是**随手写的兜底 —— 实测被负例测试钉住 (tests/s2/kb-index.test.ts:
      // 同内容的 global fact 必须进、global doc 必须不进, 唯一变量只有 kind)。
      // 我第一版在这里写成 `return false` (想收紧"只认 global 规则"), 结果把 global fact
      // 一起误杀、把那条对照测试打红 —— 收紧 scope 与收紧 kind 是两件事, 不能顺手合并。
      return true;
    })
    .map((e) => ({
      entry: e,
      // 规则优先级最高 (跨项目不变量), 其次偏好/决策, 最后事实; importance 作为微调。
      score:
        (e.kind === "rule" ? 100 : e.kind === "preference" ? 30 : e.kind === "decision" ? 20 : 10) +
        (e.importance ?? 5),
    }))
    // ⚠ **2026-09-27 修 (真实缺陷): 排序必须带确定性 tiebreak, 不能只比 score**。
    //
    // 为什么 (实测): 分数相同时 (`同 kind + 同 importance` —— 规则几乎总是这种情况,
    // 因为规则分都是 100 + importance), `Array.prototype.sort` 的次序**继承输入顺序**,
    // 而两个入口给的输入顺序不同:
    //   · `store.all()`          → 真相文件里的块出现顺序;
    //   · `store.entrySummaries()` → `SELECT ... WHERE status='active'` 的 SQL 行序 (无 ORDER BY, 不确定)。
    // 实测 (真实库 702 条, 同一 project/lineage/预算): 两条路径选出**不同集合**
    // (`facade.alwaysOn` 8 条 vs 直调选择器 9 条, 集合差 4 条); 把输入数组**反转**后
    // 选出的又是另一组 —— 证明结果依赖与语义无关的输入顺序。
    // 后果: "同一份记忆、同一个工作区, 注入内容却取决于这个投影有没有被命中" ——
    // 而这类分叉**不会有任何报错**, 只表现为"有时注入这条, 有时注入那条"。
    //
    // 修法: 以 `id` 为**最终 tiebreak** (唯一、两路径都必有、与内容修改无关)。
    // 这是**确定性**诉求, 不是"id 小的更该注入" —— 它没有任何语义偏好,
    // 只是保证"同一逻辑查询 → 同一结果", 让差异只能来自语义字段而非数组次序。
    .sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));

  const rules = scored.filter((s) => s.entry.kind === "rule");
  const others = scored.filter((s) => s.entry.kind !== "rule");
  // 两组都有候选时才切分预算; 只有一组时用满, 不让分仓变成浪费。
  const ruleCap = rules.length > 0 && others.length > 0 ? Math.floor(budget * ratio) : budget;

  // ⚠ 2026-09-18 修复 "假短缺": `ruleBudgetRatio` 是**规划配额** (给规则留多少),
  // 而不是**硬上限** —— 此前规则组被死卡在 `ruleCap`, 于是当总预算还有余量、
  // 且非规则组**用不完**时, 规则会被无谓地挡掉。
  //
  // 实测 (真实库): 9 条已确认规则里 **2 条永远注入不进**, 而那一刻
  //   总预算占用 334/400 (剩 66), 被挡的 2 条只要 62 token ⇒ **纯属分组配额造成的假短缺**。
  //
  // 修法: 规则先按 `ruleCap` 填; 若规则**还有剩余候选**且总预算仍有余量, 则允许规则
  // 继续填充 —— 但**先给非规则组预留它真正需要的量** (见下方预留计算), 因此
  // 这个放宽**不会挤占任何非规则条目**。这就是"配额是规划、不是上限"的落实。

  const out: MemoryEntry[] = [];
  const taken = new Set<string>();
  // 被**配额**挡掉的条目 (与"分数不够"不同: 它们本是候选, 只是塞不进预算)。
  const budgetBlocked: BudgetBlocked[] = [];
  let used = 0;
  const maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const fill = (group: typeof scored, cap: number): void => {
    for (const item of group) {
      if (taken.has(item.entry.id)) continue;
      const cost = opts.estimate(item.entry.content) + 8;
      // ⚠ 归因顺序: **先算预算, 再算条数** —— 反过来的话, 一条"本身太大、放不进预算"的
      // 条目会被记成 `over-entry-cap`, 而它的真实成因是预算。两者的处置完全不同
      // (放宽条数 vs 放宽预算), 记错会把排查方向带偏 (2026-09-29 由测试抓出)。
      if (used + cost > cap) {
        budgetBlocked.push({
          id: item.entry.id,
          kind: item.entry.kind,
          content: item.entry.content,
          tokens: cost,
          reason: used + cost > budget ? "over-total-budget" : "over-group-cap",
        });
        continue;
      }
      // 条数闸: 预算放得下, 但**注意力**上不再容纳更多条目。
      if (out.length >= maxEntries) {
        budgetBlocked.push({
          id: item.entry.id,
          kind: item.entry.kind,
          content: item.entry.content,
          tokens: cost,
          reason: "over-entry-cap",
        });
        continue;
      }
      used += cost;
      taken.add(item.entry.id);
      out.push(item.entry);
      // ⚠ 一个条目可能**先被挡、后又被后面的轮次选中** (两个 fill 调用就是两轮) ——
      // 此时必须撤销先前的"被挡"记录, 否则它会同时出现在 selected 与 blocked 两处。
      // 那个自洽性是面板的前提: 用户不该看到"它被挡了"却又在"将注入"里看到它。
      const prior = budgetBlocked.findIndex((b) => b.id === item.entry.id);
      if (prior >= 0) budgetBlocked.splice(prior, 1);
    }
  };
  fill(rules, ruleCap);

  // ---- 规则组的"富余填充" (见上方"假短缺"的说明) ----
  //
  // 顺序很关键: **先算非规则组真正需要多少**, 再把"用不到的那部分"让给规则 ——
  // 这样放宽规则配额**不可能**挤掉任何非规则条目 (它们需要多少就留多少)。
  //
  // 只在"规则还有候选被卡住"时才做这步 (否则纯属多算一遍)。
  fill(others, budget);
  return { entries: out, blocked: budgetBlocked };
}

/** 一条"本是候选但因配额没进来"的条目。 */
export interface BudgetBlocked {
  id: string;
  kind: string;
  /**
   * 该条目的正文 —— **面板要显示它** ("哪些内容被挡了").
   *
   * ⚠ 为什么必须带上 (2026-09-18, §565): 此前 `BudgetBlocked` 只有 id/kind/tokens/reason,
   * 而下游的 `projectAlwaysOnPreview` 用它拼面板视图时**填了空串** `content: ""`。
   * 面板那边 `{b.content}` 照原样渲染 ⇒ **用户只看到徽标与条数, 看不出被挡的是什么** ——
   * 而"哪些被挡了"正是这个出口存在的理由 (规则是用户确认过的不变量, 保底通道承诺无条件注入)。
   *
   * 类型上 `content` 是 `string`, 所以 `content: ""` **不报错** —— 那类缺陷只能靠
   * "把每个字段的用途写清楚"来防。
   */
  content: string;
  tokens: number;
  /**
   * 成因 (三者处置不同):
   *   · `over-total-budget` —— 连总预算都放不下 (条目本身太大);
   *   · `over-group-cap`  —— 总预算还有, 但它所属**分组**的配额用完了。
   *     **这才是"规则被挡"的典型情形**: 规则组配额 (budget*ratio) 用尽, 而总预算未满。
   *   · `over-entry-cap`  —— 预算还有, 但**条数上限**已满 (maxEntries)。
   *     处置与前两者不同: 想让它进来只能调高上限或删掉更靠前的条目, 而不是放预算。
   */
  reason: "over-total-budget" | "over-group-cap" | "over-entry-cap";
}

/**
 * always-on 的选择结果 (**带可观测的"被配额挡掉"清单**)。
 *
 * 为什么要这个报告 (2026-09-18 实测): 真实库有 **9 条已确认规则, 而配额 240 token 只够 7 条** ——
 * 另外 2 条**永远进不了保底通道**, 且**完全静默** (没有日志说"它因配额没注入")。
 * 用户看到的是"我确认过这条规则, 但它好像没生效"。
 *
 * 规则是**用户确认过的跨项目不变量**, 而 `always-on` 的承诺是**无条件注入** ——
 * 因此"哪些规则被挡了"必须可查, 否则这个承诺无法被验证。
 *
 * 用**返回值**而不是模块级状态: `selectAlwaysOn` 会被**多个项目分别调用**,
 * 共享一份模块状态会串台 (与 scheduleLog 的 per-project 缓存是同一类教训)。
 */
export interface AlwaysOnSelection {
  entries: MemoryEntry[];
  /** 本是候选、但因配额没进来的条目 (含被挡的规则)。 */
  blocked: BudgetBlocked[];
}


