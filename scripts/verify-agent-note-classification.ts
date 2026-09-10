/**
 * Gate: Agent Note 的分类与路径 (硬约束)。
 *
 * 校验: lifecycle/class 封闭集合、文件名日期格式、禁止历史路径 (docs/rfc 等)。
 * 结构规则由 agent-note-tree.ts 提供 (单一来源), 本脚本只负责"把它跑起来并决定退出码"。
 * 用法: node --experimental-strip-types scripts/verify-agent-note-classification.ts
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FORBIDDEN_NOTE_ROOTS, walkAgentNoteTree } from "./agent-note-tree.ts";

const { notes, errors } = walkAgentNoteTree();

// 历史位置保持不可用: 否则新 Note 会悄悄长出第二棵树。
for (const legacyRoot of FORBIDDEN_NOTE_ROOTS) {
  if (existsSync(resolve(import.meta.dirname, "..", legacyRoot))) {
    errors.push(`legacy-path: ${legacyRoot}/ 已废弃 — Agent Note 一律放在 .agents/notes/ 下`);
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-classification: 检查 ${notes.length} 篇 Agent Note, 结构一致。`);
  process.exit(0);
}
console.error("verify-agent-note-classification: 发现违规:");
for (const error of errors) console.error("  " + error);
process.exit(1);
