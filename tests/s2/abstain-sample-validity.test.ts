// tests/s2/abstain-sample-validity.test.ts — 弃权样本的**成立前提**必须被机器守住。
//
// 为什么需要它 (2026-09-18, §424): 弃权样本成立的唯一前提是"它问的东西库里确实没有"。
// 而**库会增长** —— 曾经的库外主题 (rust / tokio / kubernetes) 后来进了库。
// 旧实现只把这件事写成 note 里的中文文字, 评分侧照样把它算进弃权率 ⇒ **指标被系统性低估**
// (实测: 40 条里 8 条已失效, 修前弃权率 0.65, 修后 0.8125)。
//
// 本文件钉住三件事:
//   ① **`mentions` 用词边界**: 否则 "ada" 会命中 "loaded"、"gas" 会命中 "gasket" —— 假阳性;
//   ② **泄漏的样本必须带 `exclude: true`** (机器可读, 不靠人读 note);
//   ③ **不泄漏的样本不许带 `exclude`** —— 否则会静默丢掉有效样本。
import { describe, expect, it } from "vitest";
import { buildCases, mentions } from "../../bench/lib/cases.ts";
import type { Corpus } from "../../bench/lib/corpus.ts";

const entry = (id: string, content: string) =>
  ({
    id, content, kind: "lesson", scope: "agent", project: null,
    tags: [], entities: [], assertedAt: "2026-01-01T00:00:00Z", validAt: "2026-01-01T00:00:00Z",
    sourceRef: "t", confirmed: false, confirmedBy: null, confirmedAt: null, relations: [],
  }) as unknown as Corpus["entries"][number];

const corpusOf = (contents: string[]) => ({
  schema: "x", source: {}, entries: contents.map((c, i) => entry("m" + i, c)),
}) as unknown as Corpus;

describe("弃权样本的成立前提", () => {
  it("**mentions 用词边界** (拉丁词不许当子串命中)", () => {
    const text = "the database was loaded with gasket material";
    expect(mentions(text, "ada")).toBe(false);   // 旧版朴素 includes 会命中 "loADAd"
    expect(mentions(text, "gas")).toBe(false);   // 会命中 "GASket"
    expect(mentions(text, "data")).toBe(false);  // 会命中 "DATAbase"
    // 而真出现的词必须命中
    expect(mentions(text, "database")).toBe(true);
    expect(mentions(text, "loaded")).toBe(true);
  });

  it("**关键词泄漏的样本带 exclude: true** (否则指标被低估)", () => {
    // 语料里含 "redis" ⇒ "Redis 的 AOF 重写怎么调优" 这条不再成立
    const c = buildCases(corpusOf(["Redis 的 AOF 重写配置与内存占用"]));
    const ab = c.cases.filter((x) => x.type === "abstention");
    const leaked = ab.filter((x) => x.exclude);
    expect(leaked.length).toBeGreaterThan(0);
    expect(leaked.some((x) => x.query.includes("Redis"))).toBe(true);
  });

  it("**干净语料下不该有样本被排除** (否则会静默丢有效样本)", () => {
    // 语料只谈本仓库的技术栈 ⇒ 与所有弃权主题无关
    const c = buildCases(corpusOf(["记忆注入的预算分配与覆盖率过滤阈值标定"]));
    const ab = c.cases.filter((x) => x.type === "abstention");
    expect(ab.length).toBeGreaterThan(30); // 样本确实生成了
    expect(ab.filter((x) => x.exclude)).toEqual([]);
  });

  it("弃权样本一律 expect 为空 (定义如此)", () => {
    const c = buildCases(corpusOf(["任意内容"]));
    for (const x of c.cases.filter((y) => y.type === "abstention")) {
      expect(x.expect).toEqual([]);
    }
  });
});
