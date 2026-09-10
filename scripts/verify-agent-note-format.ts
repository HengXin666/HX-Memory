/**
 * Gate: Agent Note 的头部与章节骨架 (硬约束)。
 *
 * 校验什么 (与 .agents/notes/README.md § 文件格式 一一对应):
 *   1. 前三行固定: `# Agent Note: <title>` / 空行 / `Status: ...`, 第四行空行;
 *   2. Status 的写法必须与所在生命周期目录一致 (交叉校验, 不允许"文件在 implemented 却写 proposed");
 *   3. 正文第一节必须是 `## Problem`;
 *   4. 各生命周期各自的必需章节:
 *        proposed    → Proposal / Acceptance criteria / Risks
 *        implemented → Decision / Consequences
 *        rejected    → Proposal
 *   5. implemented 里禁止出现提案期措辞 (Proposal/Plan/Migration plan/Acceptance criteria);
 *   6. `## Alternatives considered` 强制存在 (记录"why not", 防止同一个决策被反复重新争论);
 *   7. archived/ 是冻结区: 只校验"有 Archived: 日期行", 内容不再校验 (不可改);
 *   8. 全文件只允许一行 Status:。
 *
 * 为什么这些要写成 gate 而不是文档: 文档靠自觉, gate 不靠。CI 与提交前都会跑。
 * 用法: node --experimental-strip-types scripts/verify-agent-note-format.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentNoteRoot, walkAgentNoteTree } from "./agent-note-tree.ts";

/** Status 行的语法 (按生命周期)。 */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
};

/** 每个生命周期在 `## Problem` 之外必需的章节。 */
const REQUIRED: Record<string, string[]> = {
  proposed: ["## Proposal", "## Acceptance criteria", "## Risks"],
  implemented: ["## Decision", "## Consequences"],
  rejected: ["## Proposal"],
};

/** implemented 里被禁的提案期措辞 (说"将来要做"而不是"现在是什么")。 */
const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i;

/** 归档 Note 必须有的元数据行 (归档动作唯一允许新增的内容)。 */
const ARCHIVED_MARKER = /^Archived: \d{4}-\d{2}-\d{2}$/;

/**
 * 校验单篇 Note 的头部与骨架。**导出是为了可测试** ——
 * 一个"永远返回通过"的 gate 比没有 gate 更糟, 所以它必须被证明会拒绝违规。
 * @returns 违规描述 (空数组 = 通过)
 */
export function validateAgentNote(
  note: { lifecycle: string; rel: string; date: string },
  content: string,
): string[] {
  const errors: string[] = [];
  const fail = (msg: string): void => {
    errors.push(`format: ${note.rel} — ${msg}`);
  };
  const lines = content.split("\n");
  // 围栏代码块里的示例不算文档结构。
  let inFence = false;
  const prose = lines.filter((line) => {
    if (line.startsWith("```")) {
      inFence = !inFence;
      return false;
    }
    return !inFence;
  });

  if (!/^# Agent Note: \S/.test(lines[0] ?? "")) fail("第 1 行必须是 `# Agent Note: <title>`");
  if (lines[1] !== "") fail("第 2 行必须为空行");

  if (note.lifecycle === "archived") {
    // 冻结区: 只确认归档元数据存在, 内容不再校验 (改了就是违规, 由 verify-archived 负责)。
    if (!prose.some((line) => ARCHIVED_MARKER.test(line))) {
      fail("归档 Note 必须带 `Archived: YYYY-MM-DD` 行 (紧跟 Status 之后)");
    }
    return errors;
  }

  const status = STATUS[note.lifecycle];
  if (status !== undefined && !status.test(lines[2] ?? "")) {
    fail(`第 3 行必须匹配 ${note.lifecycle} 的 Status 语法 (${String(status)})`);
  }
  if (lines[3] !== "") fail("第 4 行必须为空行");
  const statusLines = prose.filter((line) => line.startsWith("Status:") && line !== lines[2]);
  if (statusLines.length > 0) fail("全文件只允许一行 Status:, 且必须在第 3 行");
  if (prose.filter((line) => line === lines[2]).length > 1) fail("Status: 行重复出现");

  const h2s = prose.filter((line) => line.startsWith("## ")).map((line) => line.trimEnd());
  if (h2s[0] !== "## Problem") {
    fail(`第一节必须是 \`## Problem\` (实际 ${JSON.stringify(h2s[0] ?? "<无>")})`);
  }
  for (const required of REQUIRED[note.lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`缺少必需章节 \`${required}\``);
  }
  if (note.lifecycle === "implemented") {
    for (const h2 of h2s.filter((heading) => BANNED_IMPLEMENTED.test(heading))) {
      fail(
        `\`${h2}\` 是提案期措辞; implemented 只陈述"现在是什么" (折进 Decision/Consequences/Testing)`,
      );
    }
  }
  if (!h2s.includes("## Alternatives considered")) {
    fail(
      "缺少 \`## Alternatives considered\` (必须记录被否掉的方案与原因, 否则决策会被反复重新争论)",
    );
  }
  return errors;
}

/** CLI 驱动: 走整棵树并决定退出码。仅在直接执行时运行 (被 import 时不跑)。 */
function main(): void {
  const { notes, errors } = walkAgentNoteTree();
  for (const note of notes) {
    const content = readFileSync(resolve(agentNoteRoot, note.rel), "utf8");
    errors.push(...validateAgentNote(note, content));
  }
  if (errors.length === 0) {
    console.log(
      `verify-agent-note-format: 检查 ${notes.length} 篇 Agent Note, 全部符合 .agents/notes/README.md § 文件格式。`,
    );
    process.exit(0);
  }
  console.error("verify-agent-note-format: 发现违规:");
  for (const error of errors) console.error("  " + error);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
