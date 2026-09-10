// src/prompts.ts — AI 参与记忆的提示词 (抽离, 不硬编码)。
// 设计:
//   - 默认提示词是"地板": 允许用户经设置面板覆盖 (structurerPrompt / abstractorPrompt);
//   - 提示词应当持续优化: 常量导出 + 单测断言非空/含占位符, 后续可做 A/B 量化;
//   - 占位符 {{...}} 在调用时被替换 (input / theme / instances)。
export const DEFAULT_STRUCTURER_PROMPT = [
  "你是记忆系统的结构化器。把用户的一句话经验提炼为结构化记忆。",
  "输出严格 JSON (不要其他文字):",
  '{"summary":"一句话摘要","tags":["标签1","标签2"],"points":["要点1","要点2"]}',
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
