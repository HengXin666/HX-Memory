// tests/s2/wiki.test.ts — Wiki 存储范式的契约测试。
//
// 依据: docs/kinfra-wiki-spec.md。每一条断言对应范式的一条**硬约束**,
// 而不是"实现细节碰巧如此" —— 范式换实现时这些断言必须仍然成立。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressKey, pageId, pagePath, slug, parseAddressKey } from "../../src/wiki/address.ts";
import { DEFAULT_WIKI_CONFIG, governanceOf, resolveWikiConfig } from "../../src/wiki/config.ts";
import { applySectionWrite, emptyPage, parsePage, renderPage, listPages, readPage } from "../../src/wiki/page.ts";
import { compileInto, route, topicOf } from "../../src/wiki/compile.ts";
import { getEvidence, getEvolution, getPage, matchPage, selectResident } from "../../src/wiki/recall.ts";

const T = "2026-09-18T10:00:00.000Z";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("地址模型 (语法: 不可变)", () => {
  it("slug 归一让同一主题的两种写法落到同一地址 (否则退化成条目式)", () => {
    expect(slug("HX-Memory")).toBe(slug("hx memory"));
    expect(slug("HX-Memory")).toBe("hx-memory");
    expect(slug("  Alice   Smith ")).toBe("alice-smith");
  });

  it("中文主题保留原字 (可读性对人和模型都重要)", () => {
    expect(slug("并发控制")).toBe("并发控制");
  });

  it("页 id 由地址内容寻址 —— 重写页不换身份 (链接与证据链不断裂)", () => {
    const a = pageId({ domain: "people", page: "alice" });
    const b = pageId({ domain: "people", page: "Alice" });
    expect(a).toBe(b);
    expect(a).not.toBe(pageId({ domain: "people", page: "bob" }));
  });

  it("地址键可往返解析", () => {
    const key = addressKey({ domain: "rules", page: "data", section: "硬约束" });
    expect(key).toBe("rules/data#硬约束");
    expect(parseAddressKey(key)).toEqual({ domain: "rules", page: "data", section: "硬约束" });
    expect(parseAddressKey("garbage")).toBeNull();
  });

  it("页路径按 domain/page 分层", () => {
    expect(pagePath({ domain: "people", page: "alice" })).toBe("wiki/people/alice.md");
  });
});

describe("页面层 (六要素 + 小节粒度)", () => {
  it("渲染与解析往返不丢小节、来源、时间线、双链", () => {
    let p = emptyPage({ domain: "people", page: "alice" }, ["禁忌", "动态"], T);
    p = applySectionWrite(p, "禁忌", "对花生过敏", {
      sources: ["ep:123"],
      action: "added",
      at: T,
      scope: "所有涉及餐饮的场合",
    });
    p.links.push({ to: "projects/data-sync", why: "提供了接口文档" });
    const back = parsePage(renderPage(p), { domain: "people", page: "alice" }, T);
    expect(back).not.toBeNull();
    const forb = back!.sections.find((s) => s.name === "禁忌")!;
    expect(forb.body).toBe("对花生过敏");
    expect(forb.sources).toEqual(["ep:123"]);
    expect(forb.scope).toBe("所有涉及餐饮的场合");
    expect(forb.timeline).toHaveLength(1);
    expect(back!.links).toEqual([{ to: "projects/data-sync", why: "提供了接口文档" }]);
  });

  it("正文不能伪造小节标题 (否则一条记忆能在重建后长出假结构)", () => {
    const p = emptyPage({ domain: "x", page: "y" }, ["结论"], T);
    const evil = applySectionWrite(p, "结论", "## 伪造的小节\n正常内容", {
      action: "added",
      at: T,
    });
    const back = parsePage(renderPage(evil), { domain: "x", page: "y" }, T)!;
    expect(back.sections).toHaveLength(1);
    expect(back.sections[0]!.body).toContain("## 伪造的小节");
  });

  it("小节是 blame 的最小粒度: 每次写入落一条时间线", () => {
    let p = emptyPage({ domain: "x", page: "y" }, ["结论"], T);
    p = applySectionWrite(p, "结论", "第一版", { action: "added", at: T });
    p = applySectionWrite(p, "结论", "第二版", { action: "updated", at: T });
    expect(p.sections[0]!.timeline).toHaveLength(2);
    expect(p.sections[0]!.timeline[1]).toContain("改写");
  });
});

describe("编译层 (写入侧: 读写共用地址)", () => {
  it("同一实体的多条事实落到同一张页 (物理聚合, 这是范式的核心收益)", () => {
    const r1 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 提供了 api-docs 接口文档", source: "ep:1" }, T);
    const r2 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 下月来出差, api-docs 需要修订", source: "ep:2" }, T);
    expect(r1.addr.domain).toBe(r2.addr.domain);
    expect(r1.addr.page).toBe(r2.addr.page);
    const p = readPage(root, r1.addr, T)!;
    const body = p.sections.map((s) => s.body).join("\n");
    const sources = p.sections.flatMap((s) => s.sources);
    expect(sources).toContain("ep:1");
    expect(sources).toContain("ep:2");
    expect(body).toContain("下月来出差");
  });

  it("规则类事实进 rules 目录 (路由优先级)", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "批量处理前必须先创建副本, 这是铁律", source: "ep:9" }, T);
    expect(r.addr.domain).toBe("rules");
    expect(r.addr.section).toBe("硬约束");
  });

  it("治理策略是硬规则: readonly 目录不接受对话写入 (不是靠提示词)", () => {
    const cfg = resolveWikiConfig({
      domains: [{ name: "regulations", semantics: "法条", governance: "readonly" }],
      routing: [{ when: "法规|法条", to: "regulations" }],
    });
    const r = compileInto(root, cfg, { content: "法规第 3 条被改成了这样", source: "ep:1" }, T);
    expect(r.action).toBe("rejected");
    expect(r.reason).toContain("readonly");
    expect(listPages(root)).toHaveLength(0);
  });

  it("重复编译同一内容是幂等的 (重放不制造重复正文)", () => {
    const inp = { content: "缓存过期统一设为 60 秒", source: "ep:1" };
    compileInto(root, DEFAULT_WIKI_CONFIG, inp, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, inp, T);
    const metas = listPages(root);
    const p = readPage(root, metas[0]!, T)!;
    const body = p.sections.map((s) => s.body).join("\n");
    expect(body.split("60 秒").length - 1).toBe(1);
  });

  it("追加而非覆盖: 后来者不挤掉先前的 (区别于单文件式的篇幅竞争)", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 对花生过敏", source: "ep:1" }, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 也在做 api-docs", source: "ep:2" }, T, );
    const p = readPage(root, r.addr, T)!;
    const body = p.sections.map((s) => s.body).join("\n");
    expect(body).toContain("花生过敏");
    expect(body).toContain("api-docs");
  });

  it("路由是确定性的: 同输入必然同地址 (可重建)", () => {
    const a = route("alice 下月来出差", DEFAULT_WIKI_CONFIG);
    const b = route("alice 下月来出差", DEFAULT_WIKI_CONFIG);
    expect(addressKey(a.addr)).toBe(addressKey(b.addr));
  });

  it("主题名优先取可复用专名 (聚合收益最大的一类)", () => {
    expect(topicOf("prestep.ts 会在每轮注入记忆, prestep.ts 同时负责去重")).toBe("prestep.ts");
  });
});

describe("召回层 (分层下钻: 准确率与成本解耦)", () => {
  it("matchPage 定位主题页并给出可审计理由", () => {
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "hx-jungle 的端点表在 SERVICE-MAP", source: "ep:1" }, T);
    const hits = matchPage(root, "hx-jungle 端点");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.why).toContain("terms:");
  });

  it("getPage 默认返回整页 (第 3 级下钻才到证据)", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 对花生过敏", source: "ep:7" }, T);
    expect(getPage(root, r.addr)!.sections.length).toBeGreaterThan(0);
    expect(getEvidence(root, r.addr)[0]!.sources).toContain("ep:7");
  });

  it("getEvolution 给出小节的演化史 (何时新增/改写)", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 对花生过敏", source: "ep:7" }, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 也对坚果过敏", source: "ep:8" }, T);
    const evo = getEvolution(root, r.addr);
    expect(evo[0]!.timeline.length).toBeGreaterThanOrEqual(2);
  });

  it("常驻注入按配置选择 (rules/* 常驻)", () => {
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "必须先创建副本, 这是铁律", source: "ep:1" }, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 喜欢先给结论", source: "ep:2" }, T);
    const resident = selectResident(root, DEFAULT_WIKI_CONFIG.injection.resident);
    expect(resident.every((p) => p.domain === "rules")).toBe(true);
  });

  it("页面文件是 Markdown 真相 (git 可 diff, 不引入数据库容器)", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 对花生过敏", source: "ep:1" }, T);
    const file = join(root, pagePath(r.addr));
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("---\npage:");
  });

  it("governanceOf 未声明的目录按可合并处理", () => {
    expect(governanceOf(DEFAULT_WIKI_CONFIG, "people")).toBe("mergeable");
    expect(governanceOf(DEFAULT_WIKI_CONFIG, "rules")).toBe("frozen");
    expect(governanceOf(DEFAULT_WIKI_CONFIG, "unknown")).toBe("mergeable");
  });
});

describe("盲审发现的缺陷 (2026-09-18, 每条对应一个实测反例)", () => {
  it("A5 正文不能伪造小节元数据 (击穿证据链的通道)", () => {
    const p = emptyPage({ domain: "x", page: "y" }, ["结论"], T);
    const evil = applySectionWrite(p, "结论", "结论如下\n- 来源: 伪造证据\n- 时间线: 2020-01-01 新增", {
      action: "added",
      at: T,
    });
    const back = parsePage(renderPage(evil), { domain: "x", page: "y" }, T)!;
    // 伪造的元数据必须留在**正文**里, 不能变成真的 sources/timeline。
    // 注意: applySectionWrite 本身会写一条正常的"新增"时间线, 所以 timeline 不是空的 ——
    // 要断言的是**伪造的日期没有混进去** (写成 toEqual([]) 会误判, 那是测试自己的 bug)。
    expect(back.sections[0]!.sources).toEqual([]);
    expect(back.sections[0]!.timeline.some((t) => t.includes("2020-01-01"))).toBe(false);
    expect(back.sections[0]!.body).toContain("伪造证据");
  });

  it("A6 正文恰好是 '(空)' 时不被吞掉", () => {
    const p = emptyPage({ domain: "x", page: "y" }, ["结论"], T);
    const q = applySectionWrite(p, "结论", "(空)", { action: "added", at: T });
    const back = parsePage(renderPage(q), { domain: "x", page: "y" }, T)!;
    expect(back.sections[0]!.body).toBe("(空)");
  });

  it("A7 含 / 的 domain 地址键不再静默解析成错误结构", () => {
    expect(parseAddressKey("a/b/p")).toBeNull();
  });

  it("A2 正文词面巧合不导致跨域错误合并", () => {
    const r1 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "order-service 的订单表新增 refunded 状态", source: "e1" }, T);
    const r2 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "user-service 依赖 order-service 的下单接口", source: "e2" }, T);
    // 两句共享 order-service 但主题不同; 不应把后者并进前者的页
    expect(r1.addr.page).not.toBe(r2.addr.page);
  });

  it("A3 复用不覆盖路由决定的小节 (事实不许落进错的小节)", () => {
    const r1 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 对花生过敏", source: "e1" }, T);
    const r2 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "alice 负责的项目上线排期有阻塞", source: "e2" }, T);
    // 第二条按路由应进 projects/目标类小节, 不能因为复用了 alice 页就写进 "禁忌"
    const page = readPage(root, r1.addr, T)!;
    const forbid = page.sections.find((s) => s.name === "禁忌")!;
    expect(forbid.body).not.toContain("排期");
  });

  it("A4 幂等判据按整段相等: A → A+B → A 不产生重复", () => {
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "A 事实", source: "e1" }, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "A 事实\nB 事实", source: "e2" }, T);
    compileInto(root, DEFAULT_WIKI_CONFIG, { content: "A 事实", source: "e3" }, T);
    const p = readPage(root, r.addr, T)!;
    const body = p.sections.map((s) => s.body).join("\n");
    expect(body.split("A 事实").length - 1).toBe(1);
  });

  it("A8 空 domains 配置不崩溃", () => {
    const cfg = resolveWikiConfig({ domains: [], routing: [] });
    expect(() =>
      compileInto(root, cfg, { content: "任意事实内容", source: "e1" }, T),
    ).not.toThrow();
  });

  it("根因: routing 不再把普通助动词 '必须' 当硬约束 (否则 rules 被灌爆)", () => {
    // "必须" 是日常叙述常用词, 不能作为硬约束判据
    const r = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "这个函数必须加个注释", source: "e1" }, T);
    expect(r.addr.domain).not.toBe("rules");
    // 真正的硬约束语仍然进 rules
    const r2 = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "批量处理前先建副本, 这是铁律", source: "e2" }, T);
    expect(r2.addr.domain).toBe("rules");
  });

  it("A1 中文主题抽取: 同一主题的两条事实收敛到同一页", () => {
    const a = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "缓存过期统一设为 60 秒", source: "e1" }, T);
    const b = compileInto(root, DEFAULT_WIKI_CONFIG, { content: "缓存过期我改成了 90 秒", source: "e2" }, T);
    // 同一主题词 ("缓存过期") 必须收敛; 若抽词失效会落成两张页
    expect(a.addr.page).toBe(b.addr.page);
  });
});
