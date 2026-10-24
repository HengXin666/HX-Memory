// capture/transcript.ts — 把 episode 原文拼成**可复述的对话上下文** (2026-10-06)。
//
// ## 为什么需要它 (用户实测, 原话)
//
// 「我骂你的时候显然不会直接告诉你答案呐, 你肯定不能根据我骂你的那时候的输出啊,
//   肯定要看你的上下文呐, **你不包含上下文, 那你沉淀个屁呀**」
// 「要有全量上下文呐, 反正这样子都能获取到缓存的。**你难道不知道缓存是基于前缀的吗**?」
//
// 两句话定下了本模块的两条设计:
//
//   1. **要全量, 不是"最近一轮"**  骂声说的是"你刚才那一串都在乱搞", 只给紧邻一轮
//      等于让提炼器对着答案猜错处。信息在整段过程里。
//   2. **顺序与边界要对齐成对话流**  缓存按**前缀**复用。同一次会话里, 第 N 轮的上下文
//      是第 N+1 轮上下文的**前缀**: 只要从头按 [user1, assistant1, user2, assistant2, …] 排布,
//      后续调用的前面那一大段就落在缓存里, 边际成本接近零。
//      反过来说: 若按"取最近 N 条"自己截断, 每一轮的开头都在变, **前缀全废** 
//      那才是真的贵。
//
// ## 容量实测 (为什么默认预算给到 6 万字符)
//
// 254 个真实会话的 episode 体量: 中位 **6.0 KB** / 均值 **23.6 KB** / 最大 344 KB;
// 超过 6 万字符的只有 **27 个 (10.6%)**。
// ⇒ 6 万预算下, **约九成会话拿到完整从头上下文**(前缀完全共享), 只有尾部一成会滑动。
// 这不是"够用就行", 而是刻意选在"绝大多数情况下恰好不触发截断"的位置。
//
// ## 超预算时的取舍 (诚实边界)
//
// 超预算时**从最早开始丢**, 保留最近的 (正确性优先: 骂声针对的是刚发生的事)。
// 代价是那 10% 的长会话里前缀会滑动、缓存命中下降  这是明知的取舍, 不是遗漏。
// 截断处会留一行显式标记: 让模型知道自己**没看到开头**, 而不是以为那就是全部 (否则它会把
// 缺失当成"用户从没说过" — 与 memory_search 空手那条同一种病)。

/** 一条可复述的对话项。 */
export interface TranscriptItem {
  role: "user" | "assistant";
  text: string;
}

export interface TranscriptOptions {
  /** 字符预算 (默认 60000; 见头注的实测依据)。 */
  budgetChars?: number;
} 

const DEFAULT_BUDGET = 60000;

/**
 * 把一段连续对话拼成复述文本。
 *
 * 形态刻意保持**朴素**: 只有 `用户: ` / `助手: ` 与换行。任何额外的框句子都会出现在
 * 每一次调用的前缀里, 而前缀是**每轮都要重新计费一次**的地方 (缓存未命中时) 
 * 省一句框句比省一段上下文值钱得多。
 */
export function buildTranscript(
  items: readonly TranscriptItem[],
  opts: TranscriptOptions = {},
): string {
  // ⚠ **不做下限钳制** (第一版写了 `Math.max(1000, …)`, 由测试当场抓出):
  // 那会把调用方显式传的小预算**静默吃掉**  而"参数看着生效、其实读的是别的值"
  // 正是本仓反复踩过的缺陷形状 (见 stack.ts 里 channelWeights 那段实测)。
  // 调用方给多少就用多少; 唯一的兜底是 > 0 (0/负数会让截断逻辑无意义地空转)。
  const raw = opts.budgetChars ?? DEFAULT_BUDGET;
  const budget = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET;
  const rendered = items
    .filter((i) => i.text.trim())
    .map((i) => (i.role === "user" ? "用户: " : "助手: ") + i.text.trim());
  if (!rendered.length) return "";
  // 先整体量一遍  绝大多数会话走这条分支 (不截断 ⇒ 前缀完全稳定)。
  const whole = rendered.join("\n\n");
  if (whole.length <= budget) return whole;
  // 超预算: 从**最早**开始丢 (保留最近), 并在开头显式声明被截断。
  const kept: string[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const piece = rendered[i]!;
    if (used + piece.length + 2 > budget) break;
    kept.unshift(piece);
    used += piece.length + 2;
  }
  return "[上下文过长, 以下是最近的部分; 开头已省略]\n\n" + kept.join("\n\n");
}

/**
 * 从 episode 序列里取**本会话**的对话项 (按时间序)。
 *
 * 只收 user/assistant 两种 role: episode 里本来就只有这两种, 这里显式过滤是为了
 * "以后加了别的 role 也不会悄悄混进前缀"。
 */
export function transcriptItemsOf(
  episodes: readonly { session: string; role: string; text: string; at: string }[],
  session: string,
): TranscriptItem[] {
  return episodes
    .filter((e) => e.session === session && (e.role === "user" || e.role === "assistant"))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((e) => ({ role: e.role as "user" | "assistant", text: e.text }));
}
