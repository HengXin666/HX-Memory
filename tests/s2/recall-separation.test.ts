// tests/s2/recall-separation.test.ts — 检索分层: "注入" 与 "显式搜索/面板浏览" 必须给出不同答案。
//
// 用户实测的困惑: 面板搜索任何内容, 前几条永远是那几条已确认规则, 与查询毫无关系。
// 根因是**同一个检索语义被两种目的复用**: 注入要"不变量永远在场"(规则保底通道),
// 而浏览要"哪条最相关"。规则通道不受覆盖率过滤 + 权重 1.5 + boost 0.5, 数学上碾压字面命中。
//
// 本文件钉住三件事:
//   1. purpose:"recall" 时规则不再霸榜 (无关规则不出现; 相关规则仍能被召回);
//   2. purpose:"inject" (默认) 的保底行为**没有被破坏** (回归保护);
//   3. always-on 预算分仓: 规则不能吃光预算, 项目事实要能进来。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { selectAlwaysOn } from "../../src/trigger/policy.ts";
import { estimateTokens } from "../../src/kernel/ranking.ts";
import type { MemoryEntry, MemoryEntryInput } from "../../src/kernel/types.ts";

let root: string;
let store: FileBackend;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-recallsep-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function add(input: MemoryEntryInput): MemoryEntry {
  return store.add({ ts: T, ...input });
}

/** 一条与并发相关的规则 + 一条与并发**完全无关**的规则 + 一条并发项目经验。 */
function seed(): void {
  add({
    id: "r-conc",
    kind: "rule",
    scope: "global",
    content: "涉及容器并发时必须显式设计并发上限",
    source: "review:1",
    confirmedBy: "user:test",
    confirmedAt: T.assertedAt,
  });
  add({
    id: "r-ts",
    kind: "rule",
    scope: "global",
    content: "Node strip-only 模式不支持构造器参数属性",
    source: "review:2",
    confirmedBy: "user:test",
    confirmedAt: T.assertedAt,
  });
  add({
    id: "m-pool",
    kind: "lesson",
    scope: "project",
    project: "api",
    content: "上次并发问题是因为没设连接池上限",
    source: "session:s1",
  });
}

describe("检索分层: recall (显式搜索) vs inject (注入)", () => {
  it("recall: 与查询无关的规则不再出现在结果里", () => {
    seed();
    const retriever = new HybridRetriever(store);
    const hits = retriever.retrieveSync({
      text: "连接池上限怎么设",
      purpose: "recall",
      limit: 10,
      tokenBudget: 2000,
    });
    const ids = hits.hits.map((h) => h.entry.id);
    // 与查询无关的那条规则不该被"保底"塞进来 (修复前它必在前排)。
    expect(ids).not.toContain("r-ts");
    expect(ids).toContain("m-pool");
  });

  it("recall: 规则**相关**时仍会被召回 (关掉的是保底, 不是规则本身)", () => {
    seed();
    const retriever = new HybridRetriever(store);
    const hits = retriever.retrieveSync({
      text: "容器并发上限怎么设计",
      purpose: "recall",
      limit: 10,
      tokenBudget: 2000,
    });
    expect(hits.hits.map((h) => h.entry.id)).toContain("r-conc");
  });

  it("inject (默认): 规则保底没有被破坏 —— 无关查询也会带上已确认规则", () => {
    seed();
    const retriever = new HybridRetriever(store);
    const hits = retriever.retrieveSync({
      text: "连接池上限怎么设",
      limit: 10,
      tokenBudget: 2000,
    });
    const ids = hits.hits.map((h) => h.entry.id);
    expect(ids).toContain("r-ts");
    expect(ids).toContain("r-conc");
  });

  it("显式 channels.rules.enabled 可以覆盖 recall 的默认关闭", () => {
    seed();
    const retriever = new HybridRetriever(store);
    const hits = retriever.retrieveSync({
      text: "连接池上限怎么设",
      purpose: "recall",
      limit: 10,
      tokenBudget: 2000,
      channels: { rules: { enabled: true } },
    });
    expect(hits.hits.map((h) => h.entry.id)).toContain("r-conc");
  });
});

describe("always-on 预算分仓: 规则不能吃光预算", () => {
  const estimate = estimateTokens;
  function rule(id: string, n: number): MemoryEntry {
    return {
      id,
      kind: "rule",
      scope: "global",
      content: "规则".repeat(n),
      source: "r",
      ts: T,
      confirmedBy: "u",
      confirmedAt: T.assertedAt,
    };
  }
  function fact(id: string, content: string): MemoryEntry {
    return {
      id,
      kind: "fact",
      scope: "project",
      project: "api",
      content,
      source: "s",
      ts: T,
    };
  }

  it("规则与事实并存时, 事实仍能进入注入 (修复前被规则挤光)", () => {
    const entries = [
      rule("r1", 20),
      rule("r2", 20),
      rule("r3", 20),
      rule("r4", 20),
      fact("f1", "本项目用 pnpm 而不是 npm"),
    ];
    const picked = selectAlwaysOn(entries, { project: "api", budgetTokens: 400, estimate });
    const ids = picked.map((e) => e.id);
    expect(ids).toContain("f1");
    // 规则仍占大头 (不变量优先), 但不是全部。
    expect(ids.filter((i) => i.startsWith("r")).length).toBeGreaterThan(0);
  });

  it("没有事实候选时规则可用满预算 (分仓不造成浪费)", () => {
    const entries = [rule("r1", 20), rule("r2", 20)];
    const picked = selectAlwaysOn(entries, { project: "api", budgetTokens: 400, estimate });
    expect(picked.map((e) => e.id)).toEqual(["r1", "r2"]);
  });

  it("ruleBudgetRatio 越大, 规则能占的预算越多 (1 = 旧的'规则优先填满')", () => {
    // 实测: 每条规则 ("规则"×60) 约 128 token, 事实 f1 约 13 token。
    // 预算 200: 0.6 → ruleCap=120, 一条规则都放不下; 1.0 → 两条都放得下。
    const entries = [rule("r1", 60), rule("r2", 60), fact("f1", "很短的约定")];
    const tight = selectAlwaysOn(entries, {
      project: "api",
      budgetTokens: 200,
      estimate,
      ruleBudgetRatio: 0.6,
    });
    const loose = selectAlwaysOn(entries, {
      project: "api",
      budgetTokens: 200,
      estimate,
      ruleBudgetRatio: 1,
    });
    // 规则被压到 120 token 以内 → 一条也进不来; 事实那组拿满 200, f1 能进。
    expect(tight.map((e) => e.id)).toEqual(["f1"]);
    expect(loose.map((e) => e.id)).toEqual(["r1", "f1"]);
  });

  it("scope:agent 的关键事实是跨工作区共享层, 对每个项目都常驻", () => {
    const shared: MemoryEntry = {
      id: "a1",
      kind: "fact",
      scope: "agent",
      content: "用户偏好中文注释",
      source: "s",
      ts: T,
    };
    const other: MemoryEntry = {
      id: "p1",
      kind: "fact",
      scope: "project",
      project: "web",
      content: "web 项目的约定",
      source: "s",
      ts: T,
    };
    const picked = selectAlwaysOn([shared, other], {
      project: "api",
      budgetTokens: 400,
      estimate,
    });
    const ids = picked.map((e) => e.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("p1"); // 别的项目的约定不注入
  });
});
