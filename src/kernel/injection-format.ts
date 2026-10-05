// kernel/injection-format.ts — 注入块里**条目行**的格式 (单一事实源, 与 format-frame.ts 同层)。
//
// ## 2026-09-29: id 句柄从正文移出, 改走消息 source (用户实测 "太多无用上下文")
//
// 实测代价 (真实首轮注入, 仓库自己的 estimateTokens 口径): 整块 **581 token**, 其中
// `<!--hx-memory:id=…-->` 9 条共 **88 token (15%)** —— 而模型**从不读它** (它是去重判据,
// 不是给模型看的)。用户原话: "太多无用上下文"。
//
// 业界依据 (不是我们自己拍的):
//   · Claude Code 官方文档明载块级 HTML 注释 "are stripped before the content is injected
//     into Claude's context. Use them to leave notes for human maintainers **without spending
//     context tokens on them**" —— 即"机器注记不该进上下文"是官方认可的实践;
//   · Anthropic "Writing effective tools for agents" 明确要求 "eschew low-level technical
//     identifiers (for example: uuid…)", 并指出把 UUID 换成语义化/0-indexed 形态能提升精度。
//
// 因此 id 不再出现在正文里, 而是随**消息 source** 同行: `source.entryIds = [...]`。
// 已实测该扩展字段能通过 v4 真实准入 (`assertV4RowAdmission`) 并经受 JSONL 往返 ——
// 正文与元数据分离, 模型看到的只有记忆内容本身。
//
// ## 为什么当初是行尾注释 (历史, 保留理由)
//
// 注入块此前只用"整块文本相等"判重: ①会话开始的块与预步的块永不相等 → 首次预步必然重复;
// ②条目集合变一条整块文本就变 → 已注入条目被整份重发 (实测一条 14 轮会话注入 7 次)。
// 引入稳定 id 标记修掉了它。**id 仍是去重与差量注入的唯一判据**, 变的只是它住在哪里。
//
// ## 向后兼容 (必须保留)
//
// 历史会话日志里有大量行尾标记形态的注入块 (实测 68 个会话 / 2556 处旧格式)。读取侧
// (`parseInjectedIds`) 必须**同时**认两种来源: 消息 source 的 `entryIds`, 与正文里的
// 行尾标记。只认新形态会让旧会话的"已注入"基线瞬间清空 → 已注入过的常驻记忆被整份重发。
//
// 位置: kernel 层, 与 format-frame.ts (标题/框架句) 同一职责域 —— 三者共同定义"注入块长什么样"。
// 放在 adapters 下会违反分层铁律 (kernel/app 不得依赖宿主适配层), 由 tests/s1/architecture.test.ts 强制。

/** 旧的正文行尾 id 标记前缀 (新注入不再产出, 但读取侧仍需解析)。 */
export const ENTRY_ID_MARKER = "<!--hx-memory:id=";

/** 行尾标记的解析器 (带 g 标志, 每次 parse 前重置 lastIndex)。 */
const ENTRY_ID_RE = /<!--hx-memory:id=([A-Za-z0-9_-]+)-->/g;

/**
 * 一条注入行: `- [kind] 内容`。
 *
 * 行首保留 `[kind]` 而**不含** id: `[id]` 是给机器的句柄 (已实测几乎从未被模型使用, 且
 * Anthropic 明确要求正文远离技术标识符), 而 `[kind]` 是**给模型的语义标记** ——
 * 框架句要说明"标记为规则(rule)的条目是用户确认过的约束", 没有 kind 标记那句话就指代不到
 * 任何对象 (实测症状: 8 条平铺, 模型无法区分"已确认规则"与"某项目的普通决策")。
 *
 * `kind` 省略时不加前缀 (向后兼容: 调用方只想给纯内容时行为与加 kind 之前逐字一致)。
 *
 * ## 为什么签名里还留着 `id` 参数
 *
 * 它**不进正文**, 但调用方本来就持有它 (注入路径要把同一批 id 写进消息 source)。
 * 保留参数让"id 与内容同源"这件事在类型上可见 —— 调用方一眼看到"这条行属于哪个 id",
 * 而不是拿到一段无主的文本。`void id` 是刻意的: 它声明"参数被有意忽略", 防止
 * 后来者以为忘了用而顺手删掉 (删了会让上游被迫改成位置参数, 反而更容易传错)。
 */
export function formatEntryLine(id: string, content: string, kind?: string): string {
  void id; // id 不进正文 —— 由调用方放进消息 source (见本文件头注), 签名保留见上。
  const tag = kind ? "[" + kind + "] " : "";
  return "- " + tag + content;
}

/**
 * 检索结果行 (**带 id**) —— 与注入行刻意不同。
 *
 * 为什么两个出口要分开 (2026-09-29 实测): 被动注入的块**必须**让模型少看噪声 (省下的
 * id 句柄是 88 token/块), 而**模型主动检索**的结果是要被引用的 —— `memory_flag` /
 * `memory_rule_propose` 都按 id 操作, 删了它模型就没有可操作的句柄。
 *
 * 判据是**出口方向**, 不是"id 有没有用":
 *   · 被动注入 (`formatEntryLine`): 模型没要, 我们主动给 ⇒ 越短越好, id 走 source;
 *   · 主动检索 (本函数): 模型要了, 结果可能立刻被引用 ⇒ 带上 id 才可操作。
 * 这正是旧版笔记里"按 id 操作的能力保留在 memory_search 的结果里"那句话的落实 ——
 * 当时是把句柄从**行首**挪到行尾标记, 现在进一步: 从注入块里**整个移走**,
 * 只在检索结果出口保留。
 *
 * 形态: `- [kind] [id] 内容` (id 夹在 kind 之后, 紧邻内容便于模型对应)。
 */
export function formatHitLine(id: string, content: string, kind?: string): string {
  const tag = kind ? "[" + kind + "] " : "";
  return "- " + tag + "[" + id + "] " + content;
}

/**
 * 从注入文本里解析出全部已注入条目 id (顺序保留、去重)。
 *
 * ⚠ 新注入的正文里**已经没有** id 了 (它们走消息 source.entryIds) —— 本函数只服务两件事:
 *   · 读取**历史会话**里的旧格式块 (兼容, 见文件头注);
 *   · 兜底: 万一某条路径仍产出标记, 也能被认出来。
 * 新注入的 id 由 `idsOfMessage` 从 source 取, 两者在 `prior-injections` 处合并。
 */
export function parseInjectedIds(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  ENTRY_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTRY_ID_RE.exec(text)) !== null) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 消息 source 上承载条目 id 的字段名 (读取侧与写入侧共用的单一来源)。 */
export const SOURCE_ENTRY_IDS_FIELD = "entryIds";

/**
 * 从一条消息的 source 上取条目 id (新形态)。
 *
 * 判据只看**形状** (字符串数组), 不校验归属来源 —— 归属由调用方的 `isMemorySource` 把关,
 * 与 source 字段解析是两件正交的事。非数组/含非字符串一律返回空 (宁可漏认, 不可臆造)。
 */
export function entryIdsOfSource(source: unknown): string[] {
  if (typeof source !== "object" || source === null) return [];
  const raw = (source as Record<string, unknown>)[SOURCE_ENTRY_IDS_FIELD];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}
