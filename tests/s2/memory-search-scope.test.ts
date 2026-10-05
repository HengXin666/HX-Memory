// tests/s2/memory-search-scope.test.ts — memory_search 必须按工作区过滤 (跨项目泄露回归)。
//
// 回归的真实缺陷 (2026-09-27 实测): `memory_search` 调 `facade.recall()` 时
// **只传 text/limit/tokenBudget, 一个 scope 都没传** ⇒ 它搜的是**全库**。
// 实测真库 (706 条): 同一句查询不带 scope 返回 9 条, 其中 **7 条属于别的项目**
// (HX-OutlookRegister / HX-Jungle / ds-test); 带 scope 后才干净。
//
// 后果不是"多召回几条", 而是**把别的项目的私有结论当成当前项目的经验** ——
// 实测踩坑: 追问"这个项目的目标是什么"时, 命中的是别的项目的目标条目并被当成答案。
//
// ⚠ 与本仓另一处同型缺陷的关系: `trigger-cache.ts` 的 `recallFor` 此前也**完全不带 scope**,
// 修完那处后本处仍是漏的 —— 同一个缺陷形状出现在两个入口。本文件把"两个入口都必须带范围"
// 钉成断言, 因为只修一处的话, 另一处会**静默**泄漏 (没有报错, 只是答案来自别的项目)。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { registerMemoryTools } from "../../src/adapters/dsh/tools.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };

/** 收下注册的工具定义, 便于直接调它的 execute (不启任何宿主)。 */
function captureTools(): Map<string, { execute: (a: unknown, e: unknown) => Promise<string> }> {
  return new Map();
}

function makeCtx(tools: Map<string, unknown>) {
  return {
    tools: {
      register: (tool: { name: string }) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
  } as never;
}

describe("memory_search 的工作区过滤 (跨项目泄露回归)", () => {
  it("### 负例: 别的项目的私有记忆**不得**出现在结果里", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-scope-"));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      const put = (over: Record<string, unknown>) =>
        stack.store.add({ source: "t", scope: "project", project: "proj-a", ts: T, ...over } as never);

      await put({ id: "mine", kind: "decision", content: "本项目决定用 SQLite 存真相" });
      await put({ id: "theirs", kind: "decision", project: "proj-b", content: "别的项目决定用 Postgres 存真相" });
      await stack.store.add({
        id: "global-rule", kind: "rule", scope: "global", source: "t", ts: T,
        content: "跨项目规则: 提交前先查该仓库的提交历史", confirmedBy: "u", confirmedAt: T.assertedAt,
      } as never);

      const tools = captureTools();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        // 关键: 提供工作区范围 (生产路径由 runtime.scope() 提供)。
        scopeOf: () => ({ project: "proj-a", lineage: ["proj-a"] }),
      });

      const search = tools.get("memory_search")!;
      const out = await search.execute({ query: "决定用什么 存真相", limit: 10 }, {} as never);

      expect(out, "本项目的决策应当召回").toContain("SQLite");
      expect(out, "**别的项目的私有决策不得泄漏**").not.toContain("Postgres");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("### 负例: 没有工作区上下文时, 项目内条目一条都不给 (不退化)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-scope2-"));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({
        id: "p1", kind: "decision", scope: "project", project: "proj-a",
        source: "t", ts: T, content: "本项目决定用 SQLite 存真相",
      } as never);
      const tools = captureTools();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        // 不提供 scopeOf: 语义是"不知道是哪个工作区" ⇒ 只给跨项目内容。
        scopeOf: () => undefined,
      });
      const out = await tools.get("memory_search")!.execute({ query: "决定用什么 存真相", limit: 10 }, {} as never);
      expect(out, "不知道工作区时, 项目内条目一条都不该给 (退化成'全都给'就是泄漏)").not.toContain("SQLite");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("正例: scopeRequired 不误伤跨项目规则 (global 条目仍可见)", async () => {
    // 为什么单独钉: scopeRequired 挡的是"没有工作区的**项目内**条目";
    // 若它连 global 一起挡掉, 就会把"跨项目规则"这个本仓最核心的能力弄没 ——
    // 而那正是"修泄露时顺手把功能砍了"的典型形态, 用相关查询词单独测一次。
    const root = mkdtempSync(join(tmpdir(), "hxmem-scope4-"));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({
        id: "r", kind: "rule", scope: "global", source: "t", ts: T,
        content: "提交前必须先查该仓库的提交历史格式",
        confirmedBy: "u", confirmedAt: T.assertedAt,
      } as never);
      const tools = captureTools();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        scopeOf: () => undefined,   // 没有工作区
      });
      const out = await tools.get("memory_search")!.execute({ query: "提交前 要查什么 提交历史", limit: 10 }, {} as never);
      expect(out, "global 规则是共享不变量, 必须保留 (scopeRequired 只挡项目内条目)").toContain("提交历史");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("正例: 父工程 (祖先链) 的记忆在子仓库里可见", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-scope3-"));
    const stack = openMemoryStack(root, { embedder: null });
    try {
      await stack.store.add({
        id: "parent", kind: "decision", scope: "project", project: "HXLoLis",
        source: "t", ts: T, content: "父工程决定统一用 pnpm workspace",
      } as never);
      const tools = captureTools();
      registerMemoryTools(makeCtx(tools), {
        store: stack.store,
        generalizer: { propose: async () => ({}) } as never,
        facade: stack.facade,
        scopeOf: () => ({ project: "HX-Memory", lineage: ["HX-Memory", "HXLoLis"] }),
      });
      const out = await tools.get("memory_search")!.execute({ query: "统一用什么 workspace", limit: 10 }, {} as never);
      expect(out, "祖先链上的父工程记忆应当可见 (嵌套仓库不割裂)").toContain("pnpm");
    } finally {
      stack.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
