export type Decision = {
  id: string;
  scope: string;
  concern: string;
  claim: string;
  status: "active" | "superseded";
  kind: "decision" | "hard";
  evidence: string;
  taskIntent: string;
  mistake: string;
  match: string[];
};

export type Signal = { hit: boolean; reasons: string[] };

export type TurnInput = {
  text: string;
  diff: string;
  workingSet: string[];
};

export type TurnResult = {
  signal: Signal;
  injected: Decision[];
  written: Decision | null;
  discard: string | null;
  decisions: Decision[];
  redo: boolean;
  pack: string;
};

const INSULT =
  /妈的|他妈|操你|废物|垃圾|傻逼|智障|脑子有|滚|有病|白痴|dumb|stupid|idiot|trash|wtf/i;
const CORRECTION =
  /不对|别再|不是这|不要再|别动|我说过|上次就|搞什么|错了|别改|不行|不是要的|重做|改回去|don't touch|stop rewriting|you (?:rewrote|broke|ignored)|do not touch/i;

export function detectSignal(text: string): Signal {
  const reasons: string[] = [];
  if (INSULT.test(text)) reasons.push("骂人");
  if (CORRECTION.test(text)) reasons.push("纠正");
  return { hit: reasons.length > 0, reasons };
}

function fileInText(text: string): string | null {
  const m = text.match(/[\w./-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|md)\b/);
  return m ? m[0] : null;
}

function stripInsult(text: string): string {
  return text
    .replace(/你他妈|他妈的|操你妈|操你|真废物|废物|垃圾东西|垃圾|傻逼|智障|白痴|有病|给我滚/g, "")
    .replace(/\b(?:dumb|stupid|idiot|trash|wtf)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function claimOf(text: string): string | null {
  const clean = stripInsult(text).replace(/^[\uff0c\u3002\uff01\s]+/, "");
  const parts = clean
    .split(/[\u3002\uff01\uff1f\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const useful = parts.filter((s) =>
    /只要|只能|不要|别|必须|保持|改回|不是|应该|不能|only|must|don't|do not/i.test(s),
  );
  if (useful.length) return useful.join("\u3002");
  if (clean.length >= 8 && /加|改|解析|兼容|开关|需求|接口|文件|flag|parser/i.test(clean)) return clean;
  return null;
}

function concernOf(text: string): string {
  if (/兼容|backward/i.test(text)) return "backward-compat";
  if (/只加|只改|别动|别再|重写|开关|扩大|only add|stop rewriting|don't touch/i.test(text))
    return "edit-scope";
  if (/解析|parser|qs|简单模式|扩展模式/i.test(text)) return "parser-mode";
  if (/架构|分层/.test(text)) return "architecture";
  return "correction";
}

function pickScope(text: string, workingSet: string[]): { scope: string; match: string[] } | null {
  const file = fileInText(text);
  if (file) return { scope: file, match: [] };
  const aboutEdit = /重写|只加|只改|开关|别动|这个文件|中间件|flag|rewrit/i.test(text);
  const aboutReq = /兼容|需求|产品|架构|不是要的/.test(text);
  if (aboutReq && !aboutEdit) {
    if (/兼容/.test(text)) return { scope: "req:backward-compat", match: ["兼容"] };
    if (/架构/.test(text)) return { scope: "req:architecture", match: ["架构"] };
    if (/查询|query/i.test(text)) return { scope: "req:query", match: ["查询", "query"] };
    return { scope: "req:current", match: ["需求"] };
  }
  const fileScope = workingSet.map((s) => s.trim()).find(Boolean);
  if (fileScope) return { scope: fileScope, match: [] };
  return null;
}

function taskIntent(claim: string): string {
  const hit = claim.split("\u3002").find((s) => /只要|只能|必须|only|must/i.test(s));
  return hit?.trim() || claim;
}

function mistakeOf(text: string, diff: string): string {
  const line = diff
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !s.startsWith("---") && !s.startsWith("+++"));
  if (line) return `本轮改动与纠正不符：${line.slice(0, 80)}`;
  if (/重写|扩大|rewrit/i.test(text)) return "扩大了改动范围";
  return "方案被否定";
}

export function analyze(
  input: TurnInput,
): { ok: true; card: Omit<Decision, "id" | "status" | "kind"> } | { ok: false; discard: string } {
  const claim = claimOf(input.text);
  if (!claim) return { ok: false, discard: "只有情绪，没有「下次怎么做」。不入库。" };
  const scope = pickScope(input.text, input.workingSet);
  if (!scope) return { ok: false, discard: "对不上文件，也对不上一条需求。不入库。" };
  const diff = input.diff.trim();
  return {
    ok: true,
    card: {
      scope: scope.scope,
      concern: concernOf(input.text),
      claim,
      evidence: diff ? `本轮 diff：${diff.slice(0, 160)}` : `本轮被否定的方案：${claim}`,
      taskIntent: taskIntent(claim),
      mistake: mistakeOf(input.text, input.diff),
      match: scope.match,
    },
  };
}

function covers(decision: Decision, workingSet: string[], task: string): boolean {
  if (decision.status !== "active") return false;
  if (decision.scope.startsWith("req:")) {
    const hay = task.toLowerCase();
    return decision.match.some((token) => hay.includes(token.toLowerCase()));
  }
  const files = new Set(workingSet.map((s) => s.trim()).filter(Boolean));
  const mentioned = fileInText(task);
  if (mentioned) files.add(mentioned);
  for (const file of files) {
    if (file === decision.scope || file.startsWith(`${decision.scope}/`) || decision.scope.startsWith(`${file}/`)) {
      return true;
    }
  }
  return false;
}

export function inject(decisions: Decision[], workingSet: string[], task: string): Decision[] {
  return decisions.filter((d) => covers(d, workingSet, task));
}

export function packContext(decisions: Decision[]): string {
  if (!decisions.length) return "（这个范围没有当前决定）";
  return decisions
    .map((d) => `[${d.kind === "hard" ? "硬约束" : "决定"} ${d.scope} #${d.concern}] ${d.claim}`)
    .join("\n");
}

export function applyCard(
  decisions: Decision[],
  card: Omit<Decision, "id" | "status" | "kind">,
  id: string,
): Decision[] {
  const retired = decisions.map((d) =>
    d.scope === card.scope && d.concern === card.concern && d.status === "active"
      ? { ...d, status: "superseded" as const }
      : d,
  );
  return [...retired, { ...card, id, status: "active", kind: "decision" }];
}

export function promote(decisions: Decision[], id: string): Decision[] {
  return decisions.map((d) => (d.id === id && d.status === "active" ? { ...d, kind: "hard" as const } : d));
}

/**
 * 代码任务上的纠正按范围沉淀，不存骂人原话
 * .agents/notes/implemented/feature/2026-10-31-code-task-precipitate.md
 */
export function runTurn(decisions: Decision[], input: TurnInput, id: string): TurnResult {
  const signal = detectSignal(input.text);
  if (!signal.hit) {
    const injected = inject(decisions, input.workingSet, input.text);
    return { signal, injected, written: null, discard: null, decisions, redo: false, pack: packContext(injected) };
  }
  const analyzed = analyze(input);
  if (!analyzed.ok) {
    const injected = inject(decisions, input.workingSet, input.text);
    return {
      signal,
      injected,
      written: null,
      discard: analyzed.discard,
      decisions,
      redo: false,
      pack: packContext(injected),
    };
  }
  const next = applyCard(decisions, analyzed.card, id);
  const injected = inject(next, input.workingSet, input.text);
  return {
    signal,
    injected,
    written: next.find((d) => d.id === id) ?? null,
    discard: null,
    decisions: next,
    redo: true,
    pack: packContext(injected),
  };
}
