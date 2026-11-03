// src/kernel/task-continuation.ts — 用户只说 "next / 继续 / 嗯" 时, 回答「继续什么」(纯函数, 无 IO)。
//
// 为什么单独成文件: task-state.ts 接近 400 行上限; 这里只吃 task-state 已经逐条算好的信号
// (每条消息的动作词 / 路径 / 报错), 不重复扫描文本, 也不 import task-state (避免环依赖)。
//
// 语义 (2026-11-03, 用户原话「必须是按当前任务, 基于当前任务去决策」):
//   当前轮是续接短句 → 当前任务 = 历史里最近一次**有明确动作**的用户轮;
//   在那之后若有工具报错且其后没有修复迹象 → blockedOn (卡在哪)。
//   confidence 表达的是「对当前任务判断有多确定」, 因此有明确上一任务时续接短句的 confidence 是高的。
// 续接词表只在这里用, 与 trigger/intents.ts 的意图正则无关 (那份不扩)。

/** task-state 为每条窗口内消息算好的信号。 */
export interface TurnSignal {
  isUser: boolean;
  role: string;
  text: string;
  /** 用户轮的动作类型 (非用户轮为 null)。 */
  action: string | null;
  /** 已归一化的文件路径 (不含目录)。 */
  paths: string[];
  /** 工具输出里的最后一处报错 (非工具轮为 null)。 */
  error: { keyword: string; context: string } | null;
}

export interface Continuation {
  /** 最近一次 action != 未知 的用户轮的动作; 没有则 null。 */
  previousAction: string | null;
  /** 那一轮用户原话 (截 80 字), 用于说清「继续的是哪件事」。 */
  previousTurn: string | null;
  /** 那一轮及其后到当前轮之前涉及的文件: 用户亲口点名的排前, 其余按次数, 至多 5 个。 */
  previousFiles: string[];
  /** 那一轮之后最后一次工具报错, 且其后没有修复迹象; 无则 null。 */
  blockedOn: string | null;
}

const CONTINUATION_WORDS = new Set([
  "next", "continue", "go", "go on", "ok", "okay", "yes", "y", "yep", "sure",
  "继续", "继续吧", "继续做", "继续搞", "接着", "接着做", "接着来", "下一步", "然后呢", "往下",
  "嗯", "嗯嗯", "好", "好的", "行", "可以", "对", "是的",
]);

/** 当前轮是不是「只表示接着干」的续接短句。 */
export function isContinuationUtterance(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/[\s。.!！?？,，~～…]+$/u, "").trim();
  if (!t) return false;
  if (CONTINUATION_WORDS.has(t)) return true;
  return t.length <= 6 && /^(继续|接着|next|continue)/.test(t);
}

/** 报错之后出现这些字样视为已处理 (只看助手/工具消息)。 */
const FIX_SIGNS = ["已修复", "修好", "已修改", "已解决", "已改", "fixed", "passed", "resolved", "通过", "成功"];

const EMPTY: Continuation = { previousAction: null, previousTurn: null, previousFiles: [], blockedOn: null };

/**
 * 续接短句的上一任务 / 涉及文件 / 未闭合报错 (不扩 trigger/intents.ts 正则)
 * .agents/notes/implemented/feature/2026-11-03-bare-continuation-fallback.md
 */
export function findContinuation(turns: readonly TurnSignal[], currentIdx: number): Continuation {
  let prevIdx = -1;
  for (let i = currentIdx - 1; i >= 0; i--) {
    if (turns[i]!.isUser && turns[i]!.action) {
      prevIdx = i;
      break;
    }
  }
  if (prevIdx < 0) return EMPTY;
  const prev = turns[prevIdx]!;

  const counts = new Map<string, { n: number; first: number }>();
  let order = 0;
  for (let i = prevIdx; i < currentIdx; i++) {
    for (const p of turns[i]!.paths) {
      order++;
      const c = counts.get(p);
      counts.set(p, { n: (c?.n ?? 0) + 1, first: c?.first ?? order });
    }
  }
  const rest = [...counts.entries()]
    .filter(([p]) => !prev.paths.includes(p))
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .map(([p]) => p);
  const previousFiles = [...new Set([...prev.paths, ...rest])].slice(0, 5);

  let blockedOn: string | null = null;
  for (let i = currentIdx - 1; i > prevIdx; i--) {
    const t = turns[i]!;
    if (t.role !== "tool" || !t.error) continue;
    const fixedAfter = turns
      .slice(i + 1, currentIdx)
      .some((x) => !x.isUser && FIX_SIGNS.some((w) => x.text.toLowerCase().includes(w.toLowerCase())));
    if (!fixedAfter) blockedOn = t.error.keyword + ": " + t.error.context;
    break;
  }
  return { previousAction: prev.action, previousTurn: prev.text.trim().slice(0, 80), previousFiles, blockedOn };
}
