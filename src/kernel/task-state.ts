// src/kernel/task-state.ts — 从 pre-step 已有输入算出「当前任务」(纯函数, 无 IO, 无 LLM)。
//
// 输入只用 pre-step 本来就拿得到的东西: cwd、会话消息全量、项目键/祖先链。
// 输出 TaskState: 涉及模块、动作类型、最近碰过的文件、最近报错、一句话子目标、可信度。
// 全部是确定性计算 (词表匹配 + 计数), 同一输入永远得到同一输出。

import { findContinuation, isContinuationUtterance, type TurnSignal } from "./task-continuation.ts";

export interface TaskSignalInput {
  cwd: string;
  /** pre-step 拿到的会话历史 (DSH message 形状: role + content 为 string 或 parts 数组)。 */
  messages: readonly unknown[];
  project?: string;
  lineage?: string[];
  /** 只看最近多少个直接用户轮 (含其后的助手/工具消息)。默认 40; 更早的按 0.2 权重也已基本无影响。 */
  windowTurns?: number;
}

export interface TaskState {
  /** 涉及的模块 (目录前缀, 至多两段), 例如 ["src/storage", "src/kernel"]。 */
  modules: string[];
  /** 修改 / 排查 / 新增 / 删除 / 执行 / 未知 */
  action: string;
  project: string;
  /** 最近被提到的文件路径, 按出现次数降序 (平局取更近出现的), 至多 8 个。 */
  files: string[];
  /** 最近一次报错的上下文 (关键词前后各 120 字); 无则 null。 */
  error: string | null;
  /** 命中的报错关键词 (例如 ECONNREFUSED); 无则 null。 */
  errorKeyword: string | null;
  /** 一句话当前子目标; 拼不出来为空串。 */
  goal: string;
  /** 0..1: 对「当前任务是什么」有多确定, 判据见 confidenceOf。 */
  confidence: number;
  /** 当前轮是不是续接短句 (next / 继续 / 嗯 ...)。 */
  continuing: boolean;
  /** 「继续什么」: 上一个明确动作 / 那轮原话 / 涉及文件 / 未闭合的失败 (字段语义见 task-continuation.ts)。 */
  previousAction: string | null;
  previousTurn: string | null;
  previousFiles: string[];
  blockedOn: string | null;
  /** 每个字段的信息来自当前轮还是历史 (给面板/调试)。 */
  evidence: { fromCurrentTurn: string[]; fromHistory: string[] };
}

const MAX_FILES = 8;
const ERROR_CONTEXT = 120;

/** 动作词表: 顺序即同一位置并列时的优先级。只做子串匹配, 不用正则。 */
const ACTION_WORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["修改", ["重写", "重构", "改", "修"]],
  ["排查", ["为什么", "哪里", "查", "看"]],
  ["新增", ["新增", "实现", "加"]],
  ["删除", ["移除", "删", "清"]],
  ["执行", ["部署", "执行", "deploy", "跑"]],
];
/** 含动作字但不是动作的常见词 (避免「清楚」被当成删除、「看起来」被当成排查)。 */
const ACTION_STOPWORDS = ["清楚", "清晰", "看起来", "好看", "加油", "修养", "改变主意"];

/** 报错关键词 (英文按大小写不敏感匹配)。 */
const ERROR_WORDS = ["ECONNREFUSED", "ENOENT", "Error", "failed", "timeout", "失败", "报错"];

/** 路径段里允许的字符: 字母数字、下划线、点、连字符、中日韩字符。 */
function isPathChar(ch: string): boolean {
  return /[\w.\-\u3400-\u9fff]/.test(ch);
}

interface PathHit {
  path: string;
  isDir: boolean;
}

/** 从一段文本里扫出路径 (相对 a/b.ts、./a/b.py、../x/y、/abs/path、~/x/y, 以及 src/xxx/ 这种目录)。 */
export function extractPaths(rawText: string): PathHit[] {
  const out: PathHit[] = [];
  // 工具参数常是 JSON 字符串, 里面的 \n \t 是字面转义; 不先换掉会把 "\nworkspaces/a.py" 读成 "nworkspaces/a.py"。
  const text = rawText.replace(/\\[ntr]/g, "  ");
  const re = /(?:~|\.{1,2})?\/?(?:[\w.\-\u3400-\u9fff]+\/)+[\w.\-\u3400-\u9fff]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let raw = m[0];
    const start = m.index;
    // URL 不是路径: 前面紧跟 "://" 或本身含 "//"。
    if (text.slice(Math.max(0, start - 3), start).endsWith(":/") || text.slice(Math.max(0, start - 1), start) === ":") continue;
    if (raw.includes("//")) continue;
    if (start > 0 && isPathChar(text[start - 1] ?? "")) continue;
    raw = raw.replace(/\.+$/, ""); // 句末句号不属于路径
    const isDir = raw.endsWith("/");
    const segs = raw.replace(/^(~|\.{1,2})?\//, "").split("/").filter(Boolean);
    if (segs.length < 2 && !isDir) continue;
    if (!isDir) {
      const last = segs[segs.length - 1] ?? "";
      // 文件必须带扩展名 (字母开头), 排除 2026/11/03 这种日期与 a/b 这种比值。
      if (!/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(last)) continue;
    } else if (segs.length < 1 || segs.every((s) => /^\d+$/.test(s))) continue;
    out.push({ path: raw, isDir });
  }
  return out;
}

type Msg = { role?: string; source?: { kind?: string }; content?: unknown; [k: string]: unknown };

/** 插件注入的 role:user 消息 (记忆块、AGENTS.md 基线等) 不是任务信号: 它们会把旧路径灌进来。 */
function isInjected(m: Msg): boolean {
  return m.role === "user" && m.source?.kind !== undefined && m.source.kind !== "user";
}

function isDirectUser(m: Msg): boolean {
  return m.role === "user" && !isInjected(m);
}

const SKIP_KEYS = new Set(["id", "role", "source", "signature", "callId", "toolCallId", "type", "image", "data"]);

/** 递归取出消息里的文本 (content parts、工具参数、工具结果), 跳过 reasoning 与元数据。 */
export function messageText(m: unknown, depth = 0): string {
  if (depth > 6 || m === null || m === undefined) return "";
  if (typeof m === "string") return m;
  if (typeof m !== "object") return "";
  if (Array.isArray(m)) return m.map((x) => messageText(x, depth + 1)).filter(Boolean).join("\n");
  const o = m as Record<string, unknown>;
  if (o.type === "reasoning") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (SKIP_KEYS.has(k)) continue;
    const t = messageText(v, depth + 1);
    if (t) parts.push(t);
  }
  return parts.join("\n");
}

/** 取最近 windowTurns 个直接用户轮开始到末尾的消息 (已排除插件注入)。 */
function recentWindow(messages: readonly unknown[], windowTurns: number): Msg[] {
  const msgs = messages.filter((m): m is Msg => typeof m === "object" && m !== null && !isInjected(m as Msg)) as Msg[];
  let seen = 0;
  let start = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isDirectUser(msgs[i]!)) {
      seen++;
      if (seen === windowTurns) {
        start = i;
        break;
      }
    }
  }
  return msgs.slice(start);
}

function normalizePath(p: string, cwd: string): string {
  let s = p;
  const base = cwd.replace(/\/+$/, "");
  if (base && s.startsWith(base + "/")) s = s.slice(base.length + 1);
  s = s.replace(/^\.\//, "");
  return s;
}

/** 已知的顶层目录: 绝对路径落在仓库外时, 从这些段开始截取模块。 */
// 不含 components/packages 这类"装仓库的目录": 宿主仓库本身就在 .../components/HX-Memory 下, 算进来会把仓库根误判成模块。
const TOP_MARKERS = ["src", "tests", "test", "scripts", "bench", "docs", "lib"];

/** 路径 → 模块 (目录前缀至多两段)。根目录下的文件没有模块。 */
/** 不像模块名的目录段: 相对跳转、单字符、依赖目录、哈希。 */
function isNoiseSegment(seg: string): boolean {
  return seg === "." || seg === ".." || seg.length < 2 || seg === "node_modules" || /^[0-9a-f]{12,}$/i.test(seg);
}

export function moduleOf(path: string, isDir = false): string | null {
  const all = path.replace(/^(~|\.{1,2})?\//, "").split("/").filter(Boolean);
  if (all.some((x) => x === "node_modules" || x === "..")) return null;
  const segs = all;
  const dirs = isDir ? segs : segs.slice(0, -1);
  if (!dirs.length || dirs.some(isNoiseSegment)) return null;
  if (path.startsWith("/") || path.startsWith("~")) {
    const at = dirs.findLastIndex((d) => TOP_MARKERS.includes(d));
    if (at >= 0) return dirs.slice(at, at + 2).join("/");
    return dirs.slice(-2).join("/");
  }
  return dirs.slice(0, 2).join("/");
}

/**
 * cwd 兜底: 只有 cwd 已经落在某个顶层目录之下 (例如 .../repo/src/storage) 才能推出模块。
 * cwd 是仓库根时它不携带"在改哪一块"的信息, 返回空 (否则「嗯」也会被判成有模块)。
 */
export function moduleFromCwd(cwd: string): string | null {
  const segs = cwd.split("/").filter(Boolean);
  const at = segs.findLastIndex((d) => TOP_MARKERS.includes(d));
  if (at < 0) return null;
  return segs.slice(at, at + 2).join("/");
}

/** 在一条用户消息里找最先出现的动作词; 返回动作类型或 null。 */
export function actionOf(text: string): string | null {
  let masked = text;
  for (const w of ACTION_STOPWORDS) masked = masked.split(w).join(" ".repeat(w.length));
  const lower = masked.toLowerCase();
  let best: { pos: number; rank: number; action: string } | null = null;
  ACTION_WORDS.forEach(([action, words], rank) => {
    for (const w of words) {
      const pos = lower.indexOf(w.toLowerCase());
      if (pos < 0) continue;
      if (!best || pos < best.pos || (pos === best.pos && rank < best.rank)) best = { pos, rank, action };
    }
  });
  return (best as { action: string } | null)?.action ?? null;
}

/** 报错关键词前后各 ERROR_CONTEXT 字, 压成一行。 */
function errorContext(text: string, e: { keyword: string; at: number }): string {
  return text.slice(Math.max(0, e.at - ERROR_CONTEXT), e.at + e.keyword.length + ERROR_CONTEXT).replace(/\s+/g, " ").trim();
}

/** 在文本里找最后一次出现的报错关键词。 */
function lastError(text: string): { keyword: string; at: number } | null {
  let best: { keyword: string; at: number } | null = null;
  for (const w of ERROR_WORDS) {
    const ascii = /^[\x00-\x7f]+$/.test(w);
    const hay = ascii ? text.toLowerCase() : text;
    const at = hay.lastIndexOf(ascii ? w.toLowerCase() : w);
    if (at >= 0 && (!best || at > best.at)) best = { keyword: w, at };
  }
  return best;
}

/**
 * 可信度判据 (二修, 决策见 .agents/notes/implemented/feature/2026-11-03-task-state-what-to-continue.md ):
 *   - 当前轮是续接短句 (next/继续/嗯): 历史里有明确上一任务且有文件 → 0.8, 只有动作 → 0.6, 历史空白 → 0.1
 * 非续接轮 (一修: 只看**当前轮**用户消息, 历史里有多少路径都不加分):
 *   - 当前轮有动作词 且 有路径                    → 0.8
 *   - 当前轮只有动作词 (或只有路径)               → 0.4
 *   - 当前轮两者都没有 → 长度 < 10 字 0.1, 否则 0.2 (一修前用整个窗口算, "yes" 得 0.9)
 */
export function confidenceOf(current: {
  length: number;
  hasAction: boolean;
  hasPath: boolean;
  /** 续接短句时历史里能否找到上一任务 (见 task-continuation)。缺省 = 非续接轮。 */
  continuation?: { previousAction: string | null; previousFiles: readonly string[] };
}): number {
  // 续接短句: 确定性取决于**历史里上一件事有多明确**, 不取决于这句话多短; 历史空白才低。
  const c = current.continuation;
  if (c) return c.previousAction ? (c.previousFiles.length ? 0.8 : 0.6) : 0.1;
  if (current.hasAction && current.hasPath) return 0.8;
  if (current.hasAction || current.hasPath) return 0.4;
  return current.length < 10 ? 0.1 : 0.2;
}

/** 历史衰减权重: turnAgo = 距当前轮几轮 (0 = 当前轮)。最近 5 轮 1.0, 6-20 轮 0.5, 20 轮以上 0.2。 */
export function turnWeight(turnAgo: number): number {
  if (turnAgo < 5) return 1;
  if (turnAgo < 20) return 0.5;
  return 0.2;
}

/** error 只在最近 3 轮 (turnAgo 0..2) 的工具输出里找。 */
const ERROR_TURNS = 3;

export function computeTaskState(input: TaskSignalInput): TaskState {
  const cwd = input.cwd ?? "";
  const project = input.project ?? input.lineage?.[input.lineage.length - 1] ?? "";
  const window = recentWindow(Array.isArray(input.messages) ? input.messages : [], input.windowTurns ?? 40);
  const fromCurrentTurn = new Set<string>();
  const fromHistory = new Set<string>();

  // 每条消息距当前轮几轮: 最后一条直接用户消息及其后的消息为 0。
  const turnAgo: number[] = new Array(window.length).fill(0);
  let users = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    turnAgo[i] = users;
    if (isDirectUser(window[i]!)) {
      turnAgo[i] = users;
      users++;
    }
  }
  const userIdx = window.map((m, i) => (isDirectUser(m) ? i : -1)).filter((i) => i >= 0);
  const currentIdx = userIdx[userIdx.length - 1];
  const prevIdx = userIdx[userIdx.length - 2];
  const currentText = currentIdx === undefined ? "" : messageText(window[currentIdx]!.content).trim();

  // files / modules: 可以用历史, 但按轮次衰减加权; 排序用加权分 (平局取更近)。
  const fileScore = new Map<string, { w: number; last: number }>();
  const dirScore = new Map<string, { w: number; last: number }>();
  let order = 0;
  window.forEach((m, i) => {
    const w = turnWeight(turnAgo[i]!);
    for (const hit of extractPaths(messageText(m))) {
      order++;
      const p = normalizePath(hit.path, cwd);
      const map = hit.isDir ? dirScore : fileScore;
      const prev = map.get(p);
      map.set(p, { w: (prev?.w ?? 0) + w, last: order });
      (turnAgo[i] === 0 ? fromCurrentTurn : fromHistory).add(hit.isDir ? "modules" : "files");
    }
  });
  const ranked = (map: Map<string, { w: number; last: number }>) =>
    [...map.entries()].sort((a, b) => b[1].w - a[1].w || b[1].last - a[1].last);
  const files = ranked(fileScore).slice(0, MAX_FILES).map(([p]) => p);
  const modules: string[] = [];
  const addModule = (mod: string | null) => {
    if (mod && !modules.includes(mod) && modules.length < MAX_FILES) modules.push(mod);
  };
  for (const f of files) addModule(moduleOf(f));
  // 目录提及只补加权分 ≥ 2 的 (一次性的目录字样多半是日志/示例噪声)。
  for (const [d, c] of ranked(dirScore)) {
    if (c.w < 2) break;
    addModule(moduleOf(d, true));
  }
  if (!fileScore.size && !dirScore.size) {
    const mod = moduleFromCwd(cwd);
    if (mod) {
      addModule(mod);
      fromCurrentTurn.add("modules(cwd)");
    }
  }

  // action: 只看最近 1-2 轮用户消息。当前轮命中就用当前轮; 当前轮是低信息短句 (<10 字) 时不回看。
  let action = "未知";
  const curAction = actionOf(currentText);
  if (curAction) {
    action = curAction;
    fromCurrentTurn.add("action");
  } else if (currentText.length >= 10 && prevIdx !== undefined) {
    const prev = actionOf(messageText(window[prevIdx]!.content));
    if (prev) {
      action = prev;
      fromHistory.add("action(上一轮)");
    }
  }

  // error: 只在最近 3 轮的工具输出里找, 找不到就 null。
  let error: string | null = null;
  let errorKeyword: string | null = null;
  for (let i = window.length - 1; i >= 0; i--) {
    if (turnAgo[i]! >= ERROR_TURNS) break;
    const m = window[i]!;
    if (m.role !== "tool") continue;
    const t = messageText(m);
    const e = lastError(t);
    if (!e) continue;
    errorKeyword = e.keyword;
    error = errorContext(t, e);
    (turnAgo[i] === 0 ? fromCurrentTurn : fromHistory).add("error");
    break;
  }

  // 续接: 用户只说 next/继续/嗯 → 从历史里找「继续什么」(上一个明确动作 + 涉及文件 + 未闭合的失败)。
  const signals: TurnSignal[] = window.map((m) => {
    const isUser = isDirectUser(m);
    const text = isUser ? messageText(m.content) : messageText(m);
    const e = m.role === "tool" ? lastError(text) : null;
    const paths = extractPaths(text).filter((h) => !h.isDir).map((h) => normalizePath(h.path, cwd));
    const error = e ? { keyword: e.keyword, context: errorContext(text, e) } : null;
    return { isUser, role: String(m.role ?? ""), text, action: isUser ? actionOf(text) : null, paths, error };
  });
  const cont = currentIdx === undefined ? null : findContinuation(signals, currentIdx);
  const continuing = curAction === null && isContinuationUtterance(currentText);
  if (continuing && cont?.previousAction) {
    action = cont.previousAction;
    fromHistory.add("action(续接上一任务)");
  }

  const confidence = confidenceOf({
    length: currentText.length,
    hasAction: curAction !== null,
    hasPath: extractPaths(currentText).length > 0,
    ...(continuing ? { continuation: { previousAction: cont?.previousAction ?? null, previousFiles: cont?.previousFiles ?? [] } } : {}),
  });

  // goal: 动作只来自最近 1-2 轮; 当前轮低信息 (≤0.2) 时不拿历史模块编目标。
  const where = modules.slice(0, 2).join("、");
  const doing = action !== "未知" ? action : "";
  let goal = "";
  if (confidence > 0.2) {
    if (where && doing) goal = "在 " + where + " " + doing;
    else if (where) goal = "涉及 " + where;
    else if (doing) goal = doing;
  }
  if (continuing && cont?.previousAction) {
    const what = cont.previousFiles.slice(0, 2).join("、") || where;
    goal = "继续上一任务「" + (cont.previousTurn ?? "").slice(0, 40) + "」: " + cont.previousAction + (what ? " " + what : "");
    if (cont.blockedOn) goal += ", 卡在 " + cont.blockedOn.slice(0, 60);
  } else if (errorKeyword) goal = goal ? goal + ", 最近报错 " + errorKeyword : "最近报错 " + errorKeyword;

  return {
    modules,
    action,
    project,
    files,
    error,
    errorKeyword,
    goal,
    confidence,
    continuing,
    previousAction: cont?.previousAction ?? null,
    previousTurn: cont?.previousTurn ?? null,
    previousFiles: cont?.previousFiles ?? [],
    blockedOn: cont?.blockedOn ?? null,
    evidence: { fromCurrentTurn: [...fromCurrentTurn], fromHistory: [...fromHistory] },
  };
}
