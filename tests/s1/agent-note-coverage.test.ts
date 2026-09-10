// tests/s1/agent-note-coverage.test.ts — "非平凡改动必须带 Note" 的判定逻辑 (硬约束的核心)。
//
// 这条规则最容易做成"永远通过"的样子 (因为判定涉及 git diff)。这里把它拆成纯函数并逐个断言,
// 确保它**真的会拒绝** src 改动而无 Note 的情况。
import { describe, expect, it } from "vitest";
import { classifyChange } from "../../scripts/verify-agent-note-coverage.ts";

describe("Agent Note 覆盖判定", () => {
  it("改了 src 且带了 Note → 通过", () => {
    const result = classifyChange([
      "src/kernel/ports.ts",
      ".agents/notes/implemented/architecture/2026-09-10-x.md",
    ]);
    expect(result.ok).toBe(true);
    expect(result.nonTrivial).toContain("src/kernel/ports.ts");
  });

  it("改了 src 但没带 Note → 拒绝", () => {
    const result = classifyChange(["src/kernel/ports.ts", "src/app/facade.ts"]);
    expect(result.ok).toBe(false);
    expect(result.nonTrivial).toEqual(["src/kernel/ports.ts", "src/app/facade.ts"]);
  });

  it("只改测试/文档/README → 通过 (豁免)", () => {
    expect(classifyChange(["tests/s1/x.test.ts", "docs/adr.md", "README.md"]).ok).toBe(true);
    expect(classifyChange(["docs/architecture-v2.md"]).ok).toBe(true);
  });

  it("改规则文件 .agents/rules/** 也算非平凡", () => {
    expect(classifyChange([".agents/rules/engineering.md"]).ok).toBe(false);
  });

  it("改脚本/CI/包配置/tsconfig 都算非平凡", () => {
    for (const file of [
      "scripts/verify.sh",
      ".github/workflows/ci.yml",
      "package.json",
      "tsconfig.json",
    ]) {
      expect(classifyChange([file]).ok, file).toBe(false);
    }
  });

  it("Note 自身的变化不会自己满足条件 (必须在同一批改动里)", () => {
    // 只改 Note 而不改源码 → 仍是"没有非平凡改动", 通过 (无需 Note)
    expect(classifyChange([".agents/notes/proposed/feature/2026-09-10-x.md"]).ok).toBe(true);
  });

  it("大规模改动只要带了 Note 就通过", () => {
    const files = Array.from({ length: 50 }, (_, i) => "src/mod" + i + ".ts");
    files.push(".agents/notes/implemented/process/2026-09-10-y.md");
    const result = classifyChange(files);
    expect(result.ok).toBe(true);
    expect(result.nonTrivial.length).toBe(50);
  });

  it("空改动 → 通过 (无可判定内容)", () => {
    expect(classifyChange([]).ok).toBe(true);
  });
});
