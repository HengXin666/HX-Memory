// src/adapters/dsh/session-events.ts — 版本无关的会话事件读取。
//
// 为什么需要这一层: DSH 0.1.2-rc.1 移除了 `Session.events` 访问器 (改为
// `eventAt(seq)` / `snapshotEvents()` / `ownEvents()`, 第一方 dsh-agent-instructions 也
// 改成按 `session.surface.nodes` 遍历), 而 0.1.1-rc.2 只有 `events`。直接读
// `session.events` 会在目标版本上静默拿到 undefined —— 去重失效、AI 调用读不到输出,
// 且编译期完全看不见 (devDeps 里没有 dsh-session)。因此这里做一次能力探测。
//
// 另一个必要性: 模型可见的是 surface, 不是完整日志。compaction 会遮蔽 (shadow) 被替换
// 的区间 —— 这些事件仍在日志里但已不在 surface 上。按日志判断"注入过"会导致模型看不见
// 记忆却永远不再注入, 所以可见性过滤必须按 surface.nodes。

export interface SessionEventLike {
  type?: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

interface SessionLikeForEvents {
  events?: unknown;
  surface?: { nodes?: unknown };
  eventAt?: (seq: number) => unknown;
  snapshotEvents?: (from?: number, to?: number) => unknown;
  ownEvents?: () => unknown;
}

function toArray(value: unknown): SessionEventLike[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as SessionEventLike[];
  if (typeof (value as Iterable<unknown>)[Symbol.iterator] === "function") {
    return [...(value as Iterable<unknown>)] as SessionEventLike[];
  }
  return [];
}

function visibleSeqSet(session: SessionLikeForEvents): Set<number> | undefined {
  const nodes = toArray(session.surface?.nodes as unknown);
  const seqs = nodes
    .map((n) => (typeof n === "number" ? n : (n as { seq?: number }).seq))
    .filter((n): n is number => typeof n === "number");
  return seqs.length ? new Set(seqs) : undefined;
}

/**
 * 读取会话事件 (版本无关), 按 surface 过滤掉已被 compaction 遮蔽的事件,
 * 并按 seq 升序返回 (日志顺序; surface.nodes 是投影顺序, 不必等于 seq 顺序)。
 * 顺序: eventAt(surface.nodes) → snapshotEvents() → events → ownEvents()。
 */
export function sessionEvents(session: unknown): SessionEventLike[] {
  if (session === undefined || session === null) return [];
  const s = session as SessionLikeForEvents;
  const visible = visibleSeqSet(s);

  // 0.1.2+: 按 surface 逐 seq 取事件 (最准确: 只看模型可见的)
  if (visible && typeof s.eventAt === "function") {
    const out: SessionEventLike[] = [];
    for (const seq of visible) {
      const event = s.eventAt(seq) as SessionEventLike | undefined;
      if (event) out.push(event);
    }
    // surface.nodes 在 compaction 后可能非单调 (替换事件的新 seq 插在被遮蔽区间的位置),
    // 因此这里也必须按 seq 排序。
    return sortBySeq(out);
  }

  let all: SessionEventLike[] = [];
  if (typeof s.snapshotEvents === "function") {
    try {
      all = toArray(s.snapshotEvents());
    } catch {
      all = [];
    }
  }
  if (!all.length) all = toArray(s.events);
  if (!all.length && typeof s.ownEvents === "function") {
    try {
      all = toArray(s.ownEvents());
    } catch {
      all = [];
    }
  }
  if (visible) all = all.filter((e) => typeof e.seq !== "number" || visible.has(e.seq));
  return sortBySeq(all);
}

/** 按 seq 升序 (无 seq 的保持相对位置)。 */
function sortBySeq(events: SessionEventLike[]): SessionEventLike[] {
  if (!events.every((e) => typeof e.seq === "number")) return events;
  return [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** 会话日志的最后 seq (给"只看新增事件"的调用方); 无事件时 -1。 */
export function lastEventSeq(session: unknown): number {
  let max = -1;
  for (const e of sessionEvents(session)) {
    if (typeof e.seq === "number" && e.seq > max) max = e.seq;
  }
  return max;
}
