// adapters/dsh/session-text.ts — 从会话事件/消息里**取文本** (从 runtime.ts 拆出)。
//
// 为什么独立成文件 (§710 行数上限): 这是"读事件的工具", 而 runtime 是"事件状态机" 
// 两类变化的原因不同 (前者随宿主事件形状变, 后者随捕获策略变)。
//
// ## 一个真实缺陷留下的教训 (2026-09, 见 runtime 的原始注释)
//
// `assistant/message` 的 `data` 是**信封** `{ turn, step, message }`  正文在 `data.message.content`,
// 不在 `data.content` 上。只读后者会让助手输出恒为空字符串: 实测 315 条 episode 全是 user、
// 账本 `aChars` 恒为 0、结构化器永远读不到"回答", 于是沉淀的全是用户原话。
// 而 `user/message` 相反, 直接把 message 展开在 data 上。两种都要认。
//
// 取文本的判据只该有**一处**  两处各写一遍必然只有一处是对的 (这正是那个缺陷的成因)。

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 取一段 message content 里的正文 (content 可以是 string 或 parts 数组)。 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part) || typeof part.text !== "string") return "";
        // 只认正文块: assistant/message 里 reasoning (思维链) 也是 {type, text},
        // 全收下来会把"想的过程"当成回答沉淀进记忆。
        // 缺 type 的块按正文处理  别把未知形状静默丢掉 (user/message 的块常常没有 type)。
        if (typeof part.type === "string" && part.type !== "text") return "";
        return part.text;
      })
      .join("");
  }
  return "";
}

/**
 * 从一个会话事件的 `data` 里取正文 (**同时认两种形状**)。
 *
 * user/message: message 展开在 data 上 (content/source/role/id);
 * assistant/message: data 是信封 { turn, step, message }, 正文在 data.message.content。
 */
export function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";
  const direct = contentText(data.content);
  if (direct) return direct;
  const message = data.message;
  if (isRecord(message)) return contentText(message.content);
  return "";
}
