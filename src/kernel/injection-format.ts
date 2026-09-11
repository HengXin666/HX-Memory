// kernel/injection-format.ts — 注入块里**条目行**的格式 (单一事实源, 与 format-frame.ts 同层)。
//
// 为什么需要它 (真实缺陷): 注入块此前只用"整块文本相等"判重。于是
//   ①会话开始注入的块 (无标题/无框架句) 与预步注入的块 (有标题+框架句) 永不相等 → 首次预步必然重复;
//   ②预步每步都会重新拼块, 只要条目集合变一条, 整块文本就变 → 已注入过的条目被整份重发。
// 结果是同一条常驻记忆在一次会话里出现多次, 且逐轮在历史里累积 (实测: 一条 14 轮的会话注入 7 次)。
//
// 标记形态刻意做成**行尾注释**: 人读注入块时它是可忽略的注记; 代码解析时它是稳定的机器接口。
// 只在"注入块"里出现 —— 记忆正文里若出现同样的行, 最坏后果只是被当作已注入过的条目 id (保守跳过一次)。
//
// 位置: kernel 层, 与 format-frame.ts (标题/框架句) 同一职责域 —— 三者共同定义"注入块长什么样"。
// 放在 adapters 下会违反分层铁律 (kernel/app 不得依赖宿主适配层), 由 tests/s1/architecture.test.ts 强制。

/** 注入条目行的 id 标记前缀 (行尾注释, 人可忽略)。 */
export const ENTRY_ID_MARKER = "<!--hx-memory:id=";

/** 行尾标记的解析器 (带 g 标志, 每次 parse 前重置 lastIndex)。 */
const ENTRY_ID_RE = /<!--hx-memory:id=([A-Za-z0-9_-]+)-->/g;

/** 一条注入行: `- [id] 内容 <!--hx-memory:id=id-->`。 */
export function formatEntryLine(id: string, content: string): string {
  return "- [" + id + "] " + content + " " + ENTRY_ID_MARKER + id + "-->";
}

/** 从注入文本里解析出全部已注入条目 id (顺序保留、去重)。 */
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
