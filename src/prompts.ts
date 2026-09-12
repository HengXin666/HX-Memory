// src/prompts.ts — AI 参与记忆的提示词 (抽离, 不硬编码)。
// 设计:
//   - 默认提示词是"地板": 允许用户经设置面板覆盖 (structurerPrompt / abstractorPrompt);
//   - 提示词应当持续优化: 常量导出 + 单测断言非空/含占位符, 后续可做 A/B 量化;
//   - 占位符 {{...}} 在调用时被替换 (input / theme / instances)。
export const DEFAULT_STRUCTURER_PROMPT = [
  "你是记忆系统的结构化器。给你一轮**问答**: {{input}}",
  "",
  "任务: 提炼这一轮的**结论**, 不是复述提问。问句本身没有价值, 有价值的是问题背后的场景、",
  "最后采纳了什么、为什么采纳它、以及否掉了什么。",
  "",
  "输出严格 JSON (不要其他文字):",
  '{"conclusion":"结论本身, 一句话, 独立可读 (30-80字)","summary":"一句话摘要",' +
    '"tags":["标签1","标签2"],"entities":["实体1","实体2"],"points":["理由1","否掉的方案与原因"]}',
  "",
  "规则:",
  "- 如果这一轮没有形成结论 (只是提问/闲聊/还在讨论中), conclusion 留空字符串;",
  "- conclusion 里不要出现\"用户问\"\"用户说\"这类转述, 直接写事实与决策;",
  "- entities 是**可复用的专名**: 项目/仓库/文件/服务/工具/库/具体组件 (如 HX-Memory、prestep.ts、",
  "  bge-small-zh、FTS5)。**不要**把泛指词 (记忆、系统、接口、问题、方案) 或整句话放进 entities;",
  "- entities 拿不准就留空数组 —— 错的实体会把不相关的记忆连成一团, 比没有更糟;",
  "- 不要编造没出现的理由。",
].join("\n");

export const DEFAULT_ABSTRACTOR_PROMPT = [
  "你是记忆系统的规则提炼器。根据给定的同类实例, 提炼一条跨项目通用规则。",
  "输出严格两行:",
  "RULE: <一条可执行的跨项目规则, 中文, 30字内>",
  "CONFIDENCE: <0-1的小数>",
  "只输出这两行, 不要解释。",
].join("\n");

/** 占位符替换: {{name}} → value。缺省保留原文。 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(
    /\{\{([a-zA-Z0-9_]+)\}\}/g,
    (_m, name: string) => vars[name] ?? "{{" + name + "}}",
  );
}