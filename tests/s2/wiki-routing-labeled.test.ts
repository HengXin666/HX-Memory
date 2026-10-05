// tests/s2/wiki-routing-labeled.test.ts — **带标注的路由用例**: 量化"提到关键词"与"是关键词"的混淆。
//
// 为什么需要它 (2026-09-18, §502): 操作性验证发现 `HX-Sagasu` 那 18 条序列被劈成两域
// (experiences 6 + rules **12**) —— 而那是**同一个序列**, 应当在一页。
//
// 根因: 路由判据是**纯词面**的 (`route()` 里 `re.test(hay)`) —— 它无法区分:
//   · "**提到**'硬约束'这个词"  (技术讨论里的普通提及) ⇒ 应当进 experiences;
//   · "**这是一条**硬约束"      (这条记忆本身是约束)   ⇒ 应当进 rules。
//
// 实测那 18 条里有 3 条误命中 ("argo 接线三条硬约束"、"这条铁律"), 而**复用按页名**
// 把后续 12 条都拉进了 rules —— 一条误路由放大成整段序列进错域。
//
// ⚠ 本文件**只标注与量化, 不改路由实现** —— 因为修法有多个方向 (收紧词面 / 按域复用 /
// 只在首次路由) 且都需要产品判断。有标注用例之后, 那个判断才有依据。
import { describe, expect, it } from "vitest";
import { route } from "../../src/wiki/compile.ts";
import { DEFAULT_WIKI_CONFIG } from "../../src/wiki/config.ts";

/** 标注: 这条内容**应当**进哪个域 (人工判断, 依据是"它本身是不是约束")。 */
const LABELED: Array<{ content: string; want: "rules" | "experiences"; note: string }> = [
  // ---- 真正的约束: 本身在**下达**一条硬性要求 ----
  { content: "铁律: 索引与查询必须共用同一分词函数", want: "rules", note: "本身是约束" },
  { content: "禁止在公网暴露控制台端口", want: "rules", note: "本身是约束" },
  { content: "硬约束: 任何仓库提交前必须先查它的提交历史", want: "rules", note: "本身是约束" },

  // ---- 提及关键词的技术讨论: 应当进 experiences ----
  { content: "HX-Sagasu 第 12 轮: argo 接线三条硬约束 + 修掉活了 12 轮的静默伪装", want: "experiences", note: "**提到**'硬约束'三个字, 但主体是某轮的实现记录" },
  { content: "用覆盖数做全序排序会打乱相对顺序, 破坏'层内保持来源顺序'这条铁律 —— 6 项测试当场变红", want: "experiences", note: "**引用**'铁律'来描述一个失败, 不是在下达它" },
  { content: "本轮实测发现: 那条被当作铁律的判据其实是启发式的", want: "experiences", note: "**分析**一条铁律, 不是在下达" },
  { content: "禁止词表扩了 9 个, 但收益为 0", want: "experiences", note: "**讨论**词表改动, 不是在下达禁止" },
];

describe("Wiki 路由: 带标注用例 (量化误路由)", () => {
  it("**真正的约束进 rules** (3 条)", () => {
    const truths = LABELED.filter((x) => x.want === "rules");
    let ok = 0;
    for (const t of truths) {
      const d = route(t.content, DEFAULT_WIKI_CONFIG);
      if (d.addr.domain === "rules") ok++;
    }
    expect(ok).toBe(truths.length);
  });

  it("**提及关键词的技术讨论也进 rules —— 这就是缺陷的量化** (不是断言它正确)", () => {
    // ⚠ 这条测试**记录现状**, 而不是断言它正确。
    // 若将来有人修好了路由 (例如加入"是不是在下达"的判定), 它会红 ——
    // 那时应当把 want 从 experiences 改成实际值, 并把上面的 want 一起更新。
    const misfiled = LABELED.filter((x) => x.want === "experiences" && route(x.content, DEFAULT_WIKI_CONFIG).addr.domain === "rules");
    // 现状: 多数"提及"类都会被误路由到 rules
    expect(misfiled.length).toBeGreaterThan(0);
  });

  it("**误路由率可量化** (当前实现下)", () => {
    const wrong = LABELED.filter((x) => route(x.content, DEFAULT_WIKI_CONFIG).addr.domain !== x.want);
    const rate = wrong.length / LABELED.length;
    // 记录当前水平; 若修法生效, 这个数字会下降, 届时更新它
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it("路由是**确定性的** (同输入同输出) —— 否则复用会不稳定", () => {
    for (const t of LABELED) {
      const a = route(t.content, DEFAULT_WIKI_CONFIG).addr;
      const b = route(t.content, DEFAULT_WIKI_CONFIG).addr;
      expect(b).toEqual(a);
    }
  });

  it("坏正则不影响其它规则 (配置是业务侧输入)", () => {
    const bad = { ...DEFAULT_WIKI_CONFIG, routing: [{ when: "([", to: "rules" as const }, ...DEFAULT_WIKI_CONFIG.routing] };
    expect(() => route("任意内容", bad)).not.toThrow();
  });
});
