// tests/s2/source-guards.test.ts — 源码级护栏: 挡住"编译期看不见的宿主 API 漂移"。
// DSH 0.1.2-rc.1 移除了 Session.events; 如果有人在 prestep/llm-agent 里直接读
// session.events, 编译期毫无反应, 运行时静默退化。这里用文本断言把它挡在门外。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join(import.meta.dirname, "../../src/adapters/dsh");

/** 去掉注释后再做源码断言 (注释里提到被禁用的 API 是允许的, 也是文档)。 */
function codeOf(file: string): string {
  return readFileSync(join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("宿主 API 只能从适配层读", () => {
  it("prestep/llm-agent/runtime/index 不直接读 session.events", () => {
    for (const file of ["prestep.ts", "llm-agent.ts", "runtime.ts", "index.ts"]) {
      expect(codeOf(file)).not.toMatch(/session\??\.events\b/);
    }
  });

  it("会话事件读取集中在 session-events.ts", () => {
    const source = readFileSync(join(SRC, "session-events.ts"), "utf8");
    expect(source).toContain("snapshotEvents");
    expect(source).toContain("eventAt");
    expect(source).toContain("surface");
  });

  it("AI 调用不走 agents.create (会造出带工具面、会被再次捕获的 agent)", () => {
    for (const file of ["llm-agent.ts", "llm-structurer.ts", "llm-abstractor.ts"]) {
      expect(codeOf(file)).not.toMatch(/agents\.create/);
    }
    expect(codeOf("llm-agent.ts")).toContain("llm.stream");
  });
});
