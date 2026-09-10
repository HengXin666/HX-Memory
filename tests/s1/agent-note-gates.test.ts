// tests/s1/agent-note-gates.test.ts — Agent Note 硬约束的**拒绝能力**测试。
//
// 为什么要有这个文件: 一个"永远返回通过"的 gate 比没有 gate 更糟 —— 它会给人虚假的保证。
// 这里逐个构造违规样本, 断言 gate 真的会拒绝; 同时断言合法样本会通过 (防止过严导致无法落地)。
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NOTE_CLASSES, walkAgentNoteTree } from "../../scripts/agent-note-tree.ts";
import { validateAgentNote } from "../../scripts/verify-agent-note-format.ts";

const T = "2026-09-10";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "hxmem-notes-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

/** 一个最小的合法 implemented Note。 */
function implementedNote(
  over: Partial<Record<"title" | "status" | "sections", string>> = {},
): string {
  const sections =
    over.sections ??
    "## Decision\n\n做了 X。\n\n## Alternatives considered\n\n**方案 B。** 因为 Y 被否。\n\n## Consequences\n\n代价是 Z。";
  return [
    `# Agent Note: ${over.title ?? "示例决策"}`,
    "",
    `Status: ${over.status ?? "implemented"}`,
    "",
    "## Problem",
    "",
    "有个问题。",
    "",
    sections,
    "",
  ].join("\n");
}

describe("结构 gate (verify-agent-note-classification)", () => {
  it("接受合法的 {lifecycle}/{class}/yyyy-mm-dd-topic.md", () => {
    const root = tree({
      "implemented/architecture/2026-09-10-ok.md": implementedNote(),
      "proposed/testing/2026-09-10-todo.md":
        "# Agent Note: x\n\nStatus: proposed\n\n## Problem\n\n## Proposal\n\n## Alternatives considered\n\n## Acceptance criteria\n\n## Risks\n",
    });
    const { notes, errors } = walkAgentNoteTree(root);
    expect(errors).toEqual([]);
    expect(notes.map((n) => n.rel).sort()).toEqual([
      "implemented/architecture/2026-09-10-ok.md",
      "proposed/testing/2026-09-10-todo.md",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝未知生命周期目录 (Note 会因此隐形)", () => {
    const root = tree({ "implementedx/architecture/2026-09-10-bad.md": implementedNote() });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.some((e) => e.includes("未知生命周期"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝未知类别目录 (类别是封闭集合)", () => {
    const root = tree({ "implemented/refactor/2026-09-10-bad.md": implementedNote() });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.some((e) => e.includes("未知类别"))).toBe(true);
    expect(AGENT_NOTE_CLASSES).not.toContain("refactor");
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝缺失类别层 (深度不是 3)", () => {
    const root = tree({ "implemented/2026-09-10-flat.md": implementedNote() });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.some((e) => e.includes("深度"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝没有日期的文件名", () => {
    const root = tree({ "implemented/architecture/no-date.md": implementedNote() });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.some((e) => e.includes("yyyy-mm-dd"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("拒绝集中式 INDEX.md", () => {
    const root = tree({ "INDEX.md": "# 索引\n" });
    const { errors } = walkAgentNoteTree(root);
    expect(errors.some((e) => e.includes("INDEX.md"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("格式 gate (verify-agent-note-format)", () => {
  const note = (lifecycle: string) => ({
    lifecycle,
    rel: `${lifecycle}/architecture/2026-09-10-x.md`,
    date: T,
  });

  it("接受合法的 implemented", () => {
    expect(validateAgentNote(note("implemented"), implementedNote())).toEqual([]);
  });

  it("接受合法的 proposed", () => {
    const content =
      "# Agent Note: x\n\nStatus: proposed\n\n## Problem\n\np\n\n## Proposal\n\nq\n\n## Alternatives considered\n\n**B.** why not\n\n## Acceptance criteria\n\n只要 A\n\n## Risks\n\n风险 R\n";
    expect(validateAgentNote(note("proposed"), content)).toEqual([]);
  });

  it("拒绝错误的第一行", () => {
    const errors = validateAgentNote(
      note("implemented"),
      implementedNote().replace("# Agent Note: 示例决策", "# 示例决策"),
    );
    expect(errors.some((e) => e.includes("第 1 行"))).toBe(true);
  });

  it("拒绝 Status 与目录不一致 (交叉校验)", () => {
    const errors = validateAgentNote(note("implemented"), implementedNote({ status: "proposed" }));
    expect(errors.some((e) => e.includes("Status"))).toBe(true);
  });

  it("拒绝 rejected 缺少一句话原因", () => {
    const content =
      "# Agent Note: x\n\nStatus: rejected\n\n## Problem\n\np\n\n## Proposal\n\nq\n\n## Alternatives considered\n\n**B.** why\n";
    const errors = validateAgentNote(note("rejected"), content);
    expect(errors.some((e) => e.includes("Status"))).toBe(true);
  });

  it("拒绝第一节不是 ## Problem", () => {
    const errors = validateAgentNote(
      note("implemented"),
      implementedNote().replace("## Problem", "## 背景"),
    );
    expect(errors.some((e) => e.includes("## Problem"))).toBe(true);
  });

  it("拒绝缺少必需章节 (implemented 缺 Decision / Consequences)", () => {
    const content =
      "# Agent Note: x\n\nStatus: implemented\n\n## Problem\n\np\n\n## Alternatives considered\n\n**B.** why\n";
    const errors = validateAgentNote(note("implemented"), content);
    expect(errors.some((e) => e.includes("## Decision"))).toBe(true);
    expect(errors.some((e) => e.includes("## Consequences"))).toBe(true);
  });

  it("拒绝 implemented 里的提案期措辞 (禁止把计划当现状)", () => {
    const errors = validateAgentNote(
      note("implemented"),
      implementedNote().replace("## Decision", "## Plan"),
    );
    expect(errors.some((e) => e.includes("提案期"))).toBe(true);
  });

  it("强制 ## Alternatives considered (没有它决策会被反复重新争论)", () => {
    const errors = validateAgentNote(
      note("implemented"),
      implementedNote().replace("## Alternatives considered\n\n**方案 B。** 因为 Y 被否。\n\n", ""),
    );
    expect(errors.some((e) => e.includes("Alternatives considered"))).toBe(true);
  });

  it("拒绝重复的 Status 行 (两个 Status 会让读者无法判断状态)", () => {
    const errors = validateAgentNote(
      note("implemented"),
      implementedNote() + "\nStatus: implemented\n",
    );
    expect(errors.some((e) => e.includes("Status"))).toBe(true);
  });

  it("围栏代码块里的示例标题不算结构 (否则无法写格式文档)", () => {
    const content = implementedNote().replace(
      "## Decision",
      "## Decision\n\n" + "\u0060".repeat(3) + "markdown\n## Proposal\n" + "\u0060".repeat(3),
    );
    expect(validateAgentNote(note("implemented"), content)).toEqual([]);
  });

  it("归档 Note 必须有 Archived: 日期行", () => {
    const archived = {
      lifecycle: "archived",
      rel: "archived/process/2026-01-01-x.md",
      date: "2026-01-01",
    };
    expect(
      validateAgentNote(archived, "# Agent Note: x\n\nStatus: implemented\n\n## Problem\n\n"),
    ).toHaveLength(1);
    const withMarker =
      "# Agent Note: x\n\nStatus: implemented\n\nArchived: 2026-01-02\n\n## Problem\n\n";
    expect(validateAgentNote(archived, withMarker)).toEqual([]);
  });
});
