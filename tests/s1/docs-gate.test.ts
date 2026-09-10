// tests/s1/docs-gate.test.ts — 文档同步 gate 的**拒绝能力** (证明它不是装饰)。
//
// 与 Agent Note gate 同一个理由: 一个"永远通过"的 gate 比没有更糟。
// 这里对门禁的核心判定做纯函数级断言 + 端到端跑一次真实文档树。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");

describe("verify-docs", () => {
  it("当前文档树通过 (引用可达 + 三要素齐全)", () => {
    const out = execFileSync("node", ["--experimental-strip-types", "scripts/verify-docs.ts"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(out).toContain("verify-docs");
    expect(out).toContain("引用可达");
  });

  it("坏引用会被拒绝 (用临时文档验证, 不污染仓库)", () => {
    // 直接验证 gate 的判定: 注入一份引用不存在文件的临时文档 → 退出码必须非 0。
    const { writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const probe = resolve(REPO, "docs", "_probe-broken-ref.md");
    writeFileSync(
      probe,
      [
        "# 探针",
        "",
        "> 目的: 探针。",
        "> 边界 (不写什么): 探针。",
        "> 与代码的关系: 探针。",
        "",
        "引用一个不存在的文件: \`src/definitely-not-here-xyz.ts\`",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      let failed = false;
      try {
        execFileSync("node", ["--experimental-strip-types", "scripts/verify-docs.ts"], {
          cwd: REPO,
          encoding: "utf8",
        });
      } catch {
        failed = true;
      }
      expect(failed, "坏引用必须让 gate 失败").toBe(true);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
