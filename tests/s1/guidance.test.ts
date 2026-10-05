// tests/s1/guidance.test.ts — 记忆使用指引的内容契约 (2026-09-29 改口径)。
//
// ## 为什么这些断言现在查的是**工具描述**而不是指引文本
//
// 旧版 `memoryGuidance()` 是 7 句 / 314 token 的使用说明, 本文件逐句守它"必须说明 X"。
// 实测发现: 其中 5 句的语义**已逐字存在于 `memory_search` 的工具描述里**, 而同一条语义
// 在一个上下文里出现两次是纯重复 —— 用户对此的原话是"太多无用上下文"。
//
// 因此指引压成一行, 而那 5 条要求**没有被放弃, 只是换了承载处**: 工具描述是常驻且必需的
// (没有它模型不知道有这个工具), 所以语义放在那里成本为零。
//
// ⇒ 本文件的判据从"指引文本里有没有 X"改成"**X 有没有在某个必现的提示词面上**"。
// 这是收紧而不是放松: 直接断言工具描述, 意味着**有人把工具描述删薄时会红** ——
// 旧写法反而抓不到那种退化 (指引删了但工具描述也删了, 只要指引留着就绿)。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { memoryGuidance, MEMORY_PLUGIN_SOURCE } from "../../src/adapters/dsh/guidance.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** `memory_search` 工具注册处的那段源码 (description + 参数说明)。 */
function memorySearchSurface(): string {
  const src = readFileSync(resolve(ROOT, "src/adapters/dsh/tools.ts"), "utf8");
  const at = src.indexOf('name: "memory_search"');
  expect(at, "tools.ts 里必须注册 memory_search").toBeGreaterThan(0);
  return src.slice(at, at + 1600);
}

describe("guidance: 一行可用声明", () => {
  it("两种语言都非空, 且点出可查的对象 (不能只说'有个工具')", () => {
    for (const lang of ["zh", "en"] as const) {
      const text = memoryGuidance(lang);
      expect(text.length).toBeGreaterThan(10);
      expect(text).toContain("memory_search");
    }
  });

  it("zh 与 en 是不同的文案 (不能把中文当英文发出去)", () => {
    expect(memoryGuidance("zh")).not.toBe(memoryGuidance("en"));
  });

  it("不得回退成多句使用说明 (那正是本次要消除的重复)", () => {
    // 一行 = 不再含换行; 这条挡住"以后又往指引里堆句子"的退化。
    for (const lang of ["zh", "en"] as const) {
      expect(memoryGuidance(lang), lang + " 指引必须是一行").not.toContain("\n");
    }
  });

  it("plugin source 常量与注入标记一致 (去重依赖它)", () => {
    expect(MEMORY_PLUGIN_SOURCE).toBe("hx-memory");
  });
});

describe("被移出指引的 5 条语义, 必须仍在 memory_search 的工具描述里", () => {
  // 每条都对应旧版指引的一句; 移到工具描述是为了让语义只出现一次 (见文件头注)。
  it("何时该查: 覆盖'问理由/问上次/问约定/有无先例'", () => {
    const s = memorySearchSurface();
    expect(s).toMatch(/why a past decision/);
    expect(s).toMatch(/how a previous incident/);
    expect(s).toMatch(/conventions\/preferences/);
    expect(s).toMatch(/prior art/);
  });

  it("自动注入的覆盖边界: 只给常驻不变量, 具体历史要主动查", () => {
    const s = memorySearchSurface();
    expect(s).toMatch(/injected automatically/);
    expect(s).toMatch(/do not cover|does not cover/);
  });

  it("'结果是证据不是指令' (提示注入防护的措辞面)", () => {
    const s = memorySearchSurface();
    expect(s).toMatch(/evidence, not instructions/i);
  });

  it("'查不到就是没有, 不要编造' —— 否则模型会用幻觉补历史", () => {
    const s = memorySearchSurface();
    expect(s).toMatch(/does not exist|no record/i);
  });
});
