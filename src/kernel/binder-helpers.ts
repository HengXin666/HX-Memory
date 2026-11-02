// kernel/binder-helpers.ts — 绑定的纯函数 (判定 / 打分 / 排序 / 格式化)。
// 2026-11-02 从 binder.ts 拆出 (verify-structure 400 行约束); binder.ts re-export。
import type { MemoryEntry } from "./types.ts";
import { formatEntryLine } from "./injection-format.ts";
import type { MemoryBinding } from "./binder.ts";

/**
 * 判定一条绑定对当前文本是否应注入:
 *  - 无 signalWords → 总是注入 (VCP "有绑定即每轮检索");
 *  - 有 signalWords → 文本命中任一信号词才注入 (轻量门控, 避免无关噪声)。
 */
export function bindingShouldInject(binding: MemoryBinding, text: string): boolean {
  const words = binding.signalWords;
  if (!words || words.length === 0) return true;
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/** 关键词命中评分 (与 recall/service 同口径, 便于双线对照公平)。 */
export function keywordScore(content: string, words: string[]): number {
  const lower = content.toLowerCase();
  return words.filter((w) => lower.includes(w.toLowerCase())).length;
}

/** 查询绑定内容并按命中度排序。纯函数, 无副作用。 */
export function resolveBinding(
  binding: MemoryBinding,
  entries: MemoryEntry[],
  text: string,
): MemoryEntry[] {
  if (!bindingShouldInject(binding, text)) return [];
  const words = text
    .split(/[\s,，。.、；;:：()（）"'"]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 8);
  const max = binding.max ?? 6;
  const weight = binding.weight ?? 1;
  return entries
    .filter((e) => binding.query.kind === undefined || e.kind === binding.query.kind)
    .map((e) => ({
      e,
      s:
        (e.project === binding.query.project ? 1 : 0) +
        (words.length ? keywordScore(e.content, words) * weight : weight),
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, max)
    .map((x) => x.e);
}

/**
 * 把一组命中条目格式化成注入文本 (与 recall 输出同风格)。
 * 每行末尾带**稳定 id 标记** (见 adapters/dsh/oid.ts): 人读是注记, 代码据此做跨轮去重与差量注入 
 * 没有它就只能比"整块文本", 而块文本会随条目集合变化, 于是已注入过的条目被反复重发。
 */
export function formatBoundEntries(heading: string, entries: MemoryEntry[]): string {
  if (!entries.length) return "";
  // 传 kind: 框架句承诺"标记为 rule 的是已确认跨项目约束", 不带标记则那句话指代不到对象 (理由见 injection-format 头注)。
  // 传 date: 每条带自己的 validAt 日期  没有它, 一条四周前的 bug 陈述与今天刚踩的坑
  // 在模型眼里逐字同形, 于是它会把已完结的事当成当前待办 (用户 2026-10-06 实测指控, 见
  // docs/memory-failure-audit-20261006.md 第五节)。日期是「这件事多旧」的唯一可用信号。
  return "【" + heading + "】\n" +
    entries.map((e) => formatEntryLine(e.id, e.content, e.kind, { date: e.ts?.validAt })).join("\n");
}
