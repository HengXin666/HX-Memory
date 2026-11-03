// 只读: 从 ~/.dsh/sessions 抽出每个真实用户轮 (session / bucket / 轮次 / 时间 / 原文), 供无偏评测集取 query 侧素材。
import { writeFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
import { listSessionFiles, parseSession } from "../../../../../scripts/lib/dsh-session-log.ts";
import { textOf } from "../../../../../src/adapters/dsh/session-text.ts";
const out: string[] = []; let files = 0, bad = 0;
for (const f of listSessionFiles(join(homedir(), ".dsh", "sessions"))) {
  const p = parseSession(f); files++; if (!p) { bad++; continue; }
  const parts = f.split("/"); const bucket = parts[parts.length - 3]!, session = parts[parts.length - 2]!;
  let turn = 0, t0 = 0;
  for (const e of p.events) {
    if (e.type === "turn/start") { turn++; t0 = e.time ?? 0; }
    if (e.type === "user/message" && e.data?.source?.kind === "user") {
      const text = textOf(e.data); if (text) out.push(JSON.stringify({ session, bucket, cwd: p.header.cwd ?? null, turn, time: e.time ?? t0, text }));
    }
  }
}
writeFileSync(process.argv[2] ?? ".tmp/unbiased/user-turns.jsonl", out.join("\n") + "\n");
console.log(JSON.stringify({ files, bad, userTurns: out.length }));
