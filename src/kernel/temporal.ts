// kernel/temporal.ts — 记忆的**时间 × 置信度**模型: 越新的断言越可信, 同一话题新的压过旧的。
//
// ## 为什么需要它 (2026-11-01, 用户原话: "你不可能 1 个 10 年前的事情比你昨天的事情还要重要吧")
//
// 改之前的真实行为 (真库 index.sqlite 实测):
//   1. `HALF_LIFE_DAYS.rule = Infinity`、decision 365 天  规则在排序里**永不衰减**;
//   2. always-on 给规则打分 `100 + importance`, **完全不看时间**; 同分时按 id 字典序 
//      于是"去年定的规则"与"昨天定的规则"谁先注入, 取决于 id 的随机字母;
//   3. 衰减基线是 `lastHitAt ?? validAt`, 而 `lastHitAt` 由**注入回调**刷新
//      (adapters/dsh/index.ts onInjected → facade.reinforce)。规则每轮都被注入 ⇒ 每轮都"刚被用过"
//      ⇒ 永远是新的。真库规则的平均 reinforcement = **122**, 是 decision 的 11 倍 
//      越老、被注入越多的规则越"难忘", 这是一个自我强化的环, 正好与用户要的方向相反。
//
// ## 模型 (三件事, 各管一层)
//
//   (a) **保持率** R(age) = floor + (1 - floor) · 2^(-age / H)
//       age 从"用户最后一次断言它"算起 = max(validAt, confirmedAt), **不用 lastHitAt**:
//       被注入/被检索不是用户重新断言, 不能让它变年轻。
//       H (半衰期) 与 floor (地板) 按 kind 分档, 数值由用户自己的历史对话推导
//       (scripts/eval/derive-decay.ts, 结果与推导过程在 docs/temporal-decay.md)。
//       floor > 0: 没被推翻的老规则只是**排得更后**, 不会凭时间消失 (它是用户确认过的)。
//
//   (b) **同话题新压旧** (supersedeByRecency): 同一 kind 的规范性条目 (rule/decision/preference)
//       话题重合 (重合系数, 两档判据见 TOPIC_STRONG) 时, 只有最新的那条保持原分; 更早的乘
//       SUPERSEDED_FACTOR 并且**不进常驻注入**。这一层不依赖衰减曲线  哪怕两条只差一天,
//       昨天的也一定压过前天的。衰减只负责"没有冲突时, 老的往后排"。
//
//   (c) **有效置信度** = confidence₀ × R(age) × (被压 ? SUPERSEDED_FACTOR : 1)。
//       面板与注入块把它和"定于 YYYY-MM-DD"一起展示, 让模型和人都看得见新旧。
//
// 边界: 纯函数, 不读时钟 (now 由调用方给), 同样输入同样输出。
import type { MemoryEntry, MemoryKind } from "./types.ts";
import { tokenSet } from "./cjk.ts";

export interface DecayParams {
  /** 半衰期 (天): 过了这么久, 超出地板的那部分权重减半。 */
  halfLifeDays: number;
  /** 地板 (0..1): 无论多老都不会低于它 (只降权, 不消失)。 */
  floor: number;
}

/**
 * 各 kind 的衰减参数。数值来源 (scripts/eval/derive-decay.ts 在用户 2026-08-13 ~ 2026-11-01 的 886 个会话上):
 *
 *   · 显式改写很少: 1116 句规范性断言, 抽 150 对"同项目后续同话题断言"人工标注, 改写只占 2% (3/150),
 *     由此估出的改写半衰期约 3840 天 (bootstrap 90% 区间约 2050~6760)。但 3 次改写全发生在原断言后 0~3 天内 
 *     改写是"当场纠正", 不是慢慢变旧, 所以交给 supersedeByRecency (当天生效), 不靠曲线。
 *   · 真正让老规则失效的是**仓库停摆/换方向**: 12576 条人发的消息、28 个项目, 一条消息 d 天后同项目
 *     还有人说话的比例 S(7)=0.84, S(14)=0.81, S(30)=0.77, S(45)=0.55; 拟合 2^(-d/H) 得 H = 40.6 天。
 *     rule / decision 都是项目内的约束, 取 H = 41。
 *   · preference 多是跨项目的个人习惯 (用中文回答 / 不要文本表情), 不随单个仓库停摆而失效;
 *     数据窗口只有 80 天, 推不出它的半衰期, 取 rule 的约 2 倍 (90 天) 并标为**未推导**。
 *   · lesson / pattern / fact / context / event 沿用原排序口径的量级 (非规范性, 不参与新压旧)。
 *
 * floor > 0: 没被推翻的老规则只是排得更后, 不会凭时间消失 (它是用户确认过的)。
 * doc 不衰减: 知识库切片的去留由源文件决定, 不由时间决定 (与 HALF_LIFE_DAYS.doc 同理由)。
 */
export const DECAY: Readonly<Record<MemoryKind, DecayParams>> = {
  event: { halfLifeDays: 3, floor: 0 },
  context: { halfLifeDays: 7, floor: 0.05 },
  lesson: { halfLifeDays: 60, floor: 0.15 },
  pattern: { halfLifeDays: 60, floor: 0.15 },
  fact: { halfLifeDays: 45, floor: 0.15 },
  preference: { halfLifeDays: 90, floor: 0.2 },
  decision: { halfLifeDays: 41, floor: 0.15 },
  rule: { halfLifeDays: 41, floor: 0.2 },
  doc: { halfLifeDays: Number.POSITIVE_INFINITY, floor: 1 },
};

/** 规范性 kind: 同话题时"新的推翻旧的"才有意义 (lesson/context 是并存的经验, 不互相推翻)。 */
export const NORMATIVE_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(["rule", "decision", "preference"]);

/**
 * "同一话题"用**重合系数** |A∩B| / min(|A|,|B|), 不用 Jaccard: 规则常是"短句 vs 长句"
 * (同一条纪律, 新版写得更细), Jaccard 会被长句稀释 (真库实测同话题的测试纪律对 Jaccard 0.337、重合系数 0.682)。
 *
 * 两档 (在真库 95 条 rule/decision/preference 的 650 个同 kind 配对上标定, 清单见 docs/temporal-decay.md):
 *   · >= TOPIC_STRONG: 直接算同话题 → 新压旧;
 *   · >= TOPIC_OVERLAP: 还要求新的一条带"改写信号" (改为/不再/以后…)。
 *     否定极性不同**不算**: 真库里它在 0.35 附近只抓到"原则 vs 已实现"这类互补对 (误压)。
 *     只是"同领域、互相补充"的两条 (如 RRF k 值与 bm25 权重两条决策) 不会被压, 只按时间衰减排序。
 */
export const TOPIC_STRONG = 0.5;
export const TOPIC_OVERLAP = 0.35;

/** 新断言里"我改主意了"的信号。 */
export const REVISION_MARKERS = /改为|改成|换成|改用|不再|取消|作废|废弃|以后|今后|从现在起|从今天起|最终|而是|代替|取代|替换|新定|更正|纠正|instead|no longer|from now on|replace/i;

/** 被同话题更新条目压住的条目, 其有效置信度乘这个系数。 */
export const SUPERSEDED_FACTOR = 0.1;

const DAY_MS = 86_400_000;

/** 保持率 R(age) ∈ [floor, 1]。age 非法或为负按 0; H 非有限 → 1 (不衰减)。 */
export function retention(ageDays: number, p: DecayParams): number {
  if (!Number.isFinite(p.halfLifeDays) || p.halfLifeDays <= 0) return 1;
  const age = Number.isFinite(ageDays) && ageDays > 0 ? ageDays : 0;
  const floor = Math.min(1, Math.max(0, p.floor));
  return floor + (1 - floor) * Math.pow(0.5, age / p.halfLifeDays);
}

/** 时间戳 → 毫秒 (非法返回 NaN)。 */
function ms(iso: string | undefined): number {
  return iso ? Date.parse(iso) : Number.NaN;
}

/**
 * 用户最后一次**断言**它的时间 = max(validAt, confirmedAt)。刻意不看 lastHitAt (见文件头第 3 条)。
 * 兼容廉价投影: 投影可能只带扁平的 validAt。
 */
export function assertedAtMs(e: Pick<MemoryEntry, "confirmedAt"> & { ts?: { validAt?: string }; validAt?: string }): number {
  const v = ms(e.ts?.validAt ?? e.validAt);
  const c = ms(e.confirmedAt);
  if (Number.isFinite(v) && Number.isFinite(c)) return Math.max(v, c);
  return Number.isFinite(v) ? v : c;
}

export function ageDaysOf(e: Parameters<typeof assertedAtMs>[0], now: string): number {
  const t = assertedAtMs(e);
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return 0;
  return Math.max(0, (n - t) / DAY_MS);
}

export function retentionOf(e: Parameters<typeof assertedAtMs>[0] & { kind: MemoryKind }, now: string): number {
  return retention(ageDaysOf(e, now), DECAY[e.kind] ?? { halfLifeDays: 60, floor: 0.15 });
}

export interface SupersedeInfo {
  /** 压住它的那条 (同话题、同 kind、更晚断言)。 */
  by: string;
  overlap: number;
}

type TemporalEntry = Pick<MemoryEntry, "id" | "kind" | "content" | "confirmedAt"> & {
  ts?: { validAt?: string };
  validAt?: string;
  project?: string;
};

/**
 * 同话题新压旧: 返回 "被压条目 id → 压住它的最新条目"。
 *
 * 只在 NORMATIVE_KINDS 内、同 kind、同项目 (或都无项目) 比较。
 * 一条被压, 当且仅当存在一条同 kind、话题判据成立 (sameTopicRevision)、断言时间**严格更晚**的条目。
 * 取重合度最高的那条作为 `by` (并列取更晚的), 结果与输入顺序无关。
 * 复杂度 O(n²) 只在规范性条目内 (真库 < 100 条), 词集预先算好。
 * .agents/notes/implemented/feature/2026-11-01-temporal-confidence-decay.md
 */
export function supersedeByRecency(entries: readonly TemporalEntry[]): Map<string, SupersedeInfo> {
  const pool = entries
    .filter((e) => NORMATIVE_KINDS.has(e.kind))
    .map((e) => ({ e, t: assertedAtMs(e), tokens: tokenSet(e.content) }))
    .filter((x) => Number.isFinite(x.t) && x.tokens.size > 0);
  const out = new Map<string, SupersedeInfo>();
  for (const a of pool) {
    let best: { id: string; overlap: number; t: number } | null = null;
    for (const b of pool) {
      if (a === b || b.e.kind !== a.e.kind || (b.e.project ?? "") !== (a.e.project ?? "")) continue;
      if (!(b.t > a.t)) continue;
      const j = overlapCoefficient(a.tokens, b.tokens);
      if (!sameTopicRevision(j, a.e.content, b.e.content)) continue;
      if (!best || j > best.overlap || (j === best.overlap && (b.t > best.t || (b.t === best.t && b.e.id < best.id)))) {
        best = { id: b.e.id, overlap: j, t: b.t };
      }
    }
    if (best) out.set(a.e.id, { by: best.id, overlap: Math.round(best.overlap * 1000) / 1000 });
  }
  return out;
}

/** 重合系数 |A∩B| / min(|A|,|B|)。 */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of s) if (l.has(t)) inter++;
  return inter / s.size;
}

/** 两档判据 (见 TOPIC_STRONG / TOPIC_OVERLAP)。older/newer 是正文。 */
export function sameTopicRevision(overlap: number, older: string, newer: string): boolean {
  if (overlap >= TOPIC_STRONG) return true;
  if (overlap < TOPIC_OVERLAP) return false;
  return REVISION_MARKERS.test(newer);
}

/** 有效置信度 = confidence₀ × R(age) × (被压 ? SUPERSEDED_FACTOR : 1)。confidence₀ 缺省 0.7。 */
export function effectiveConfidence(
  e: Parameters<typeof retentionOf>[0] & { confidence?: number },
  now: string,
  superseded: boolean,
): number {
  const c0 = Number.isFinite(e.confidence) ? Math.min(1, Math.max(0, e.confidence as number)) : 0.7;
  return c0 * retentionOf(e, now) * (superseded ? SUPERSEDED_FACTOR : 1);
}

/** 曲线采样 (面板与文档用): 每个 kind 在给定天数上的 R 值。 */
export function decayCurve(days: readonly number[] = [0, 1, 3, 7, 14, 30, 60, 90, 180, 365, 3650]): Array<{ kind: MemoryKind; points: Array<[number, number]> }> {
  return (Object.keys(DECAY) as MemoryKind[]).map((kind) => ({
    kind,
    points: days.map((d) => [d, Math.round(retention(d, DECAY[kind]) * 1000) / 1000] as [number, number]),
  }));
}

/**
 * 一批已打分的命中里, 把被同话题新条目压住的那些乘 SUPERSEDED_FACTOR, 并在 why 里注明被谁压。
 * 原地修改并返回同一数组 (调用方随后会重新排序)。
 */
export function demoteSuperseded<T extends { entry: TemporalEntry; score: number; why: string }>(items: T[]): T[] {
  const sup = supersedeByRecency(items.map((i) => i.entry));
  for (const it of items) {
    const s = sup.get(it.entry.id);
    if (!s) continue;
    it.score *= SUPERSEDED_FACTOR;
    it.why += ", superseded-by:" + s.by;
  }
  return items;
}
