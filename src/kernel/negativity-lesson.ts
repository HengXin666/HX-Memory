// kernel/negativity-lesson.ts — 负面信号 → **可沉淀的教训正文** (从 negativity.ts 拆出)。
//
// 为什么独立成文件 (§710 行数上限): 它与判定是**两类变化** —— 判定随"什么词算负面"变
// (用户改词表), 而本文件随"落库那句话该长什么样"变 (读者是谁、要什么形态)。
// 第一版就错在这里: 判定完全正确, 而落库的句子写成"用户对做法不满…", 用户实测否决。
//
// ## 两条铁律 (读者是下一轮的我)
//
//   1. **主语必须是约束本身**, 不是用户, 也不是"某轮对话"。禁止出现"用户""不满""生气"
//      这类**描述他人**的词 —— 它们不改变我下一次的动作。
//      形态固定 `禁止<做法>。改为: <改法>。` 或 `必须<做法>。`
//   2. **抽不出内容就说抽不出**, 绝不编一个具体方案。此时退到按类别的**行为禁令**
//      (见 BEHAVIOR_BANS) —— 它们是"被否决之后我该改什么"的通用答案, 不是胡编的具体内容。
//
// ## 为什么"禁止"要当稳定前缀
//
// 它在面板里可被直接搜到 ("搜 禁止 就列出所有被否决过的做法"), 也让下一轮的我能一眼分清
// "这是约束"还是"这是当时的情况描述"。代价是一点中文语感 —— 那是刻意的取舍。
import { directionOf, type NegativeKind, type NegativeSignal } from "./negativity.ts";

/**
 * 三类负面信号各自对应的行为禁令 (**抽不出具体方向时的退路**; 都不含"用户"二字)。
 *
 * 措辞要求: 必须是**下一次我能直接照做的**, 不是"要注意""要重视"这类废话。
 * 句式统一 `禁止<做法>。改为: <改法>。` —— 前半是刹车, 后半是方向盘。
 */
export const BEHAVIOR_BANS: Record<NegativeKind, string> = {
  // 方案被否 → 病根通常是"没对齐就开干"。
  "blame-method": "禁止未经确认就开工。改为: 先说清方案要点与取舍, 等确认再动手。",
  // 执行被骂 → 病根通常是"在一条路上反复失败还继续试"。
  "blame-execution": "禁止在失败路径上反复硬试。改为: 卡住立刻换路径, 并主动报进展。",
  // 理解偏差 → 病根通常是"按自己的理解直接执行"。
  correction: "禁止按自己的理解直接开干。改为: 先复述理解到的方向, 确认后再做。",
};

/** 一条信号里最主要的那一类 (顺序: 执行 > 方法 > 纠正 —— 与严重度一致, 只用于退路模板)。 */
function primaryKind(signal: NegativeSignal): NegativeKind {
  if (signal.kinds.includes("blame-execution")) return "blame-execution";
  if (signal.kinds.includes("blame-method")) return "blame-method";
  return "correction";
}

/**
 * 把一条禁令式表述剥成"被禁止的行为"。
 *
 * "不要每次都重启服务" → "每次都重启服务" ⇒ "禁止每次都重启服务。"
 * 剥完太短 (<3 字) 说明原句不是禁令 ("别" 后面什么都没有), 返回 null 交给"必须"分支。
 */
function asBan(direction: string): string | null {
  const m = /^(?:不要|别|禁止|严禁|不准|无需|不用|不能|不可以)\s*(.+)$/.exec(direction.trim());
  const rest = m?.[1]?.trim() ?? "";
  return rest.length >= 3 ? stripTrailing(rest) : null;
}

/** 去掉句末标点 (模板自己会加句号, 否则会出现"。。")。 */
function stripTrailing(text: string): string {
  return text.replace(/[。！!？?；;,.，、\s]+$/, "");
}

/** 把负面信号换成可沉淀的教训正文 (形态见文件头注两条铁律)。 */
export function lessonDraftOf(
  signal: NegativeSignal,
  rawText: string,
  compiled?: Parameters<typeof directionOf>[1],
): string {
  const direction = directionOf(rawText, compiled);
  if (direction) {
    // 方向本身就是一条禁令 ("不要每次都重启服务" / "禁止直接操作生产库")?
    // 是 → 剥掉否定词, 拼成"禁止<行为>" (这才是我要遵守的那条)。
    const banned = asBan(direction);
    if (banned) return "禁止" + banned + "。";
    // 否则它是一条**正面要求** ("先跑测试再改代码") —— 那是我要照做的, 用"必须"。
    return "必须" + stripTrailing(direction) + "。";
  }
  // 抽不出方向: 退到按类别的**行为禁令** (见头注铁律 2)。
  return BEHAVIOR_BANS[primaryKind(signal)];
}
