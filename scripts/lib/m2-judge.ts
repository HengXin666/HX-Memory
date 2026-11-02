// scripts/lib/m2-judge.ts — M2 引用核对的判据 (memory-recall.ts 用; 单测 tests/s2/fix-round-2.test.ts 钉住)。
// 判据说明见 scripts/eval/memory-recall.ts 头注。
/** 账本时间 "Sun 2026-10-11 2:49 PM CST (UTC+08:00)" → 毫秒 (分钟精度)。 */
export function parseAt(s: unknown): number {
  const t = String(s ?? "");
  const m = /(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM).*?UTC([+-]\d{2}):?(\d{2})/.exec(t);
  if (!m) return Date.parse(t);
  let h = Number(m[2]) % 12;
  if (m[5] === "PM") h += 12;
  return Date.parse(`${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}${m[6]}:${m[7]}`);
}

const STOP = new Set(["this", "that", "with", "from", "have", "will", "your", "what", "when", "then", "than", "them", "they", "were", "been", "into", "only", "also", "just", "like", "some", "more", "true", "false", "null", "none"]);
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z_][a-z0-9_.\-/]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const run of text.match(/[\u4e00-\u9fff]{4,}/g) ?? []) for (let i = 0; i + 4 <= run.length; i++) out.add(run.slice(i, i + 4));
  return out;
}

export function judge(entry: string, answer: string, userMsg: string): { strict: boolean; loose: boolean; usable: number } {
  const ans = answer.toLowerCase();
  const t = [...terms(entry)];
  const loose = t.some((w) => ans.includes(w));
  const u = userMsg.toLowerCase();
  const own = t.filter((w) => !u.includes(w));
  const hit = own.filter((w) => ans.includes(w)).length;
  return { strict: own.length >= 2 && hit / own.length >= 0.5, loose, usable: own.length };
}

