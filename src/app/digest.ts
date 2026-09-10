// app/digest.ts — 记忆摘要整合端口 + 确定性启发式实现 (daily → digest 的整理侧)。
//
// 背景: 记忆库的消费者 (人看面板 / 模型读上下文) 拿到的是一堆平铺条目, 需要一份"现在大概知道什么"的概述。
// 这件事天然分两半:
//   - 概述的**选材与计数**是确定性的 (只吃 active, 按 出现次数 × importance 排序, 同输入同输出);
//   - 概述的**自然语言润色**才是 LLM 的活 (由主 agent 接宿主模型实现 DigestBuilder 端口)。
// 本文件只做前一半: 可复算、可测试、无 IO、无依赖。summary 是人能读的句子而不是条目拼接。
//
// 保守边界 (与 consolidate.ts 同一套价值观):
//   1. **只吃 active**: superseded/merged/expired/shadow 一律不进摘要 —— 摘要代表"当前认为成立的知识";
//   2. **空输入不抛错**: 返回一个明确说明"无内容"的 digest (人看得懂, 调用方不用 try/catch);
//   3. **不编造**: 要点只取条目原文片段 (不改写), 数量不足时如实报数而不是硬凑。
import type { MemoryEntry, MemoryKind } from "../kernel/types.ts";

export interface DigestInput {
  entries: readonly MemoryEntry[];
  project?: string;
}

export interface Digest {
  title: string;
  summary: string;
  points: string[];
}

export interface DigestBuilder {
  readonly id: string;
  build(input: DigestInput): Promise<Digest>;
}

export interface HeuristicDigestOptions {
  /** 最多保留几条要点 (默认 8)。 */
  maxPoints?: number;
  /** 标题里引用的项目 / 主题名最大字符数 (默认 24)。 */
  titleTopicLength?: number;
  /** 单条要点的最大字符数 (默认 120)。 */
  pointLength?: number;
}

/** kind 的展示顺序 (固定, 保证摘要文本确定)。 */
const KIND_ORDER: readonly MemoryKind[] = [
  "fact",
  "preference",
  "decision",
  "lesson",
  "pattern",
  "context",
  "event",
  "rule",
];

/** 要点重复判定用的归一化: 大小写/标点/空白全抹平 (只用于比对, 不改写原文)。 */
function normalizeForCompare(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 截断 (按码点, 不切断代理对)。 */
function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("") + "...";
}

/** 单行化 + 截断: 要点/标题里不放换行。 */
function singleLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

/** 空输入的 digest: 明确说"无内容", 而不是空字符串或抛错。 */
function emptyDigest(project: string | undefined): Digest {
  const scope = project ? `项目 ${project}` : "全部项目";
  return {
    title: project ? `${project}: 暂无 active 记忆` : "暂无 active 记忆",
    summary: `${scope}当前没有可整合的 active 记忆 (0 条, 无 kind 分布), 属于空摘要而非失败。`,
    points: [],
  };
}

/**
 * 确定性摘要整合 (默认实现)。同一份输入必然产出同一份 digest:
 *   - 过滤: 只保留 status 缺省或 active 的条目 (shadow/expired/superseded/merged 全部排除);
 *   - 归纳: 先按归一化内容去重, 每组保留时间最新的原文作代表, 并记录出现次数;
 *   - 排序: 出现次数降序 → importance 降序 → 组内最新 validAt 降序 → 代表条目 id 升序 (稳定兜底);
 *   - 裁剪: 取前 maxPoints 条, 每条截断到 pointLength。
 * importance 缺省按 5 计 (与 MemoryEntry 注释一致), 因此老数据行为不变。
 */
export function heuristicDigestBuilder(opts: HeuristicDigestOptions = {}): DigestBuilder {
  const maxPoints = opts.maxPoints ?? 8;
  const titleTopicLength = opts.titleTopicLength ?? 24;
  const pointLength = opts.pointLength ?? 120;

  return {
    id: "heuristic-digest-builder",

    async build(input: DigestInput): Promise<Digest> {
      const active = input.entries.filter((e) => (e.status ?? "active") === "active");
      if (active.length === 0) return emptyDigest(input.project);

      // 归纳: 归一化文本 → 组 (代表原文 + 次数 + 最高 importance + 最新时间)。
      interface Group {
        key: string;
        representative: MemoryEntry;
        count: number;
        maxImportance: number;
        latestValidAt: string;
        firstSeen: number;
      }
      const groups = new Map<string, Group>();
      const byKind: Record<MemoryKind, number> = {
        fact: 0,
        preference: 0,
        event: 0,
        decision: 0,
        lesson: 0,
        rule: 0,
        pattern: 0,
        context: 0,
      };
      const projects = new Map<string, number>();
      const shadowed = input.entries.length - active.length;

      for (const entry of active) {
        byKind[entry.kind] += 1;
        if (entry.scope === "project" && entry.project) {
          projects.set(entry.project, (projects.get(entry.project) ?? 0) + 1);
        }
        const key = normalizeForCompare(entry.content);
        const importance = Number.isFinite(entry.importance) ? (entry.importance as number) : 5;
        const existing = groups.get(key);
        if (existing) {
          existing.count += 1;
          if (importance > existing.maxImportance) existing.maxImportance = importance;
          if (entry.ts.validAt > existing.latestValidAt) {
            existing.latestValidAt = entry.ts.validAt;
            existing.representative = entry;
          }
          continue;
        }
        groups.set(key, {
          key,
          representative: entry,
          count: 1,
          maxImportance: importance,
          latestValidAt: entry.ts.validAt,
          firstSeen: groups.size,
        });
      }

      const ordered = [...groups.values()].sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        if (a.maxImportance !== b.maxImportance) return b.maxImportance - a.maxImportance;
        if (a.latestValidAt !== b.latestValidAt) return a.latestValidAt < b.latestValidAt ? 1 : -1;
        if (a.representative.id !== b.representative.id) {
          return a.representative.id < b.representative.id ? -1 : 1;
        }
        return a.firstSeen - b.firstSeen;
      });
      const points = ordered
        .slice(0, Math.max(0, maxPoints))
        .map((g) => singleLine(g.representative.content, pointLength))
        .filter((p) => p.length > 0);

      // summary: 件数 + 去重后主题数 + kind 分布 + 主要项目 (人能读的一句话, 不是拼接)。
      const distinct = groups.size;
      const distribution = KIND_ORDER.filter((k) => byKind[k] > 0)
        .map((k) => `${k} ${byKind[k]}`)
        .join(", ");
      const scope = input.project ? `项目 ${input.project}` : "全部项目";
      const sentences: string[] = [
        `${scope}共有 ${active.length} 条 active 记忆, 归纳为 ${distinct} 个主题` +
          (distinct > points.length ? `, 摘要取前 ${points.length} 条` : ""),
        `kind 分布: ${distribution}`,
      ];
      const topProject = [...projects.entries()].sort((a, b) =>
        a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
      )[0];
      if (topProject) {
        sentences.push(
          `覆盖 ${String(projects.size)} 个项目, 其中最主要的是 ${topProject[0]} (${String(topProject[1])} 条)`,
        );
      }
      if (shadowed > 0) {
        sentences.push(`已排除 ${shadowed} 条非 active 记忆 (shadow/expired/superseded 等)`);
      }
      const summary = sentences.join("; ") + "。";
      // 标题取首要主题 (最多 titleTopicLength 字), 让面板/日志一行就能认出这份摘要讲什么。
      const first = points[0];
      const title = first
        ? truncate(first, titleTopicLength)
        : `${scope}: ${String(distinct)} 个主题`;
      return { title, summary, points };
    },
  };
}
