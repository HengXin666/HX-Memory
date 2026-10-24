// external/policy.ts — 何时读、何时写、骂人时当轮怎么处理。词表判定复用 kernel, 不另起一份。
import { detectNegative, type NegativeSignal } from "../kernel/negativity.ts";
import type { CanonicalMemory } from "./canonical.ts";

/** 约 600 token。按字符粗算, 中文大约 2 字 1 token。 */
export const SESSION_TOKEN_BUDGET = 600;

export const FRUSTRATION_DISPOSITION =
  "用户否定了上一步。只根据给出的上下文和已有记忆, 指出具体错在哪、违反了哪条预期、涉及哪个文件或符号, 并给出一条下次能执行的避免规则。证据不足时只回答 insufficient, 禁止编造规则, 禁止复述辱骂原话。";

export const INSUFFICIENT_INJECT = "用户在否定上一步。先对齐错在哪, 不要解释, 也不要继续改。";

/** 弱触发词。强触发仍走 kernel 里更重的辱骂。 */
const STRONG =
  /傻逼|傻b|沙比|脑残|智障|弱智|白痴|废物|蠢货|蠢驴|蠢牛|操你妈|草你妈|艹你妈|操尼玛|fuck|idiot|stupid|useless|wtf|stfu|去死|滚蛋|你他妈/i;

/** 技术用语, 包住命中片段时不算骂人。 */
const SUPPRESS = ["垃圾回收", "垃圾收集", "滚日志", "滚动", "废物利用", "没用到"];

const KIND_RANK: Record<CanonicalMemory["kind"], number> = {
  correction: 0,
  decision: 1,
  preference: 2,
  episode: 3,
};

export interface FrustrationDecision {
  fire: boolean;
  reason: string;
  signal?: NegativeSignal;
}

export function judgeFrustration(text: string, opts?: { priorEdit?: boolean }): FrustrationDecision {
  const signal = detectNegative(text);
  if (!signal.hit) return { fire: false, reason: "no-hit" };
  const hits = signal.hits.filter((hit) => survives(text, hit.matched));
  if (!hits.length) return { fire: false, reason: "suppressed" };
  const blame = hits.filter((hit) => hit.kind !== "correction");
  if (!blame.length) return { fire: false, reason: "correction-only" };
  const strong = blame.some((hit) => STRONG.test(hit.matched));
  if (!strong && !hasReferent(text, opts?.priorEdit === true)) {
    return { fire: false, reason: "weak-without-referent" };
  }
  return {
    fire: true,
    reason: strong ? "strong" : "weak-with-referent",
    signal: { ...signal, hits: blame },
  };
}

export function shouldTurnRecall(text: string): boolean {
  return /上次|继续|还是|别再|Error\b|Exception\b|Traceback|[A-Za-z0-9_./-]+\.[A-Za-z]{1,6}/.test(text);
}

export function shouldRetain(turn: {
  user: string;
  assistant: string;
  filesChanged?: boolean;
  errorResolved?: boolean;
}): { retain: boolean; reason: string } {
  if (judgeFrustration(turn.user).fire) return { retain: false, reason: "frustration-handled-apart" };
  if (turn.filesChanged || turn.errorResolved) return { retain: true, reason: "change" };
  const assistant = turn.assistant.trim();
  if (!assistant) return { retain: false, reason: "no-conclusion" };
  if (/[?？]\s*$/.test(turn.user.trim()) && assistant.length < 40) {
    return { retain: false, reason: "question-without-conclusion" };
  }
  return { retain: true, reason: "conclusion" };
}

/** 开场只钉仍有效的纠正和决定, 不灌最近原文。 */
export function selectSessionCard(
  records: readonly CanonicalMemory[],
  budget = SESSION_TOKEN_BUDGET,
): CanonicalMemory[] {
  const sorted = records
    .filter((row) => row.status === "active" && row.kind !== "episode")
    .slice()
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.createdAt.localeCompare(a.createdAt));
  const picked: CanonicalMemory[] = [];
  let used = 0;
  for (const row of sorted) {
    const cost = Math.ceil(row.text.length / 2) + 8;
    if (picked.length > 0 && used + cost > budget) break;
    picked.push(row);
    used += cost;
    if (used >= budget) break;
  }
  return picked;
}

export function episodeText(user: string, assistant: string): string {
  return "意图: " + user.trim() + "\n结果: " + assistant.trim();
}

function survives(text: string, matched: string): boolean {
  const lower = text.toLowerCase();
  const needle = matched.toLowerCase();
  if (!needle) return false;
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(needle, from);
    if (at < 0) return false;
    const covered = SUPPRESS.some((phrase) => covers(lower, at, needle.length, phrase.toLowerCase()));
    if (!covered) return true;
    from = at + 1;
  }
  return false;
}

function covers(text: string, at: number, len: number, phrase: string): boolean {
  let start = 0;
  while (start < text.length) {
    const found = text.indexOf(phrase, start);
    if (found < 0 || found > at) return false;
    if (found + phrase.length >= at + len) return true;
    start = found + 1;
  }
  return false;
}

function hasReferent(text: string, priorEdit: boolean): boolean {
  if (priorEdit) return true;
  return /你|上次|别再/.test(text) || /[A-Za-z0-9_./-]+\.[A-Za-z]{1,6}/.test(text);
}
