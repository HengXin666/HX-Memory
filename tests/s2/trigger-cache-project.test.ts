// tests/s2/trigger-cache-project.test.ts — always-on 缓存必须**按项目**隔离。
//
// 真实缺陷 (2026-09): 缓存只有一对 cache/cachedRevision, 失效判据是"写版本号变了"。
// 同一版本里第一个来热身的项目把它自己项目的 always-on 灌进去, 之后所有项目都命中这份缓存 ——
// A 项目的私有决策被注入给 B 项目, 直到某次写入顶掉版本号才重算。
// 实测: 一次无 project 的 alwaysOn 调用返回了 8 个项目的条目 (53 条项目内候选)。
//
// 这个文件钉住两件事:
//   1. 一个缓存实例服务多个项目时, 每个项目拿到的是自己的那份;
//   2. 会话早先热过的项目不会"毒化"后面项目的注入。
import { describe, expect, it } from "vitest";
import { createTriggerCache } from "../../src/adapters/dsh/trigger-cache.ts";
import { selectAlwaysOn } from "../../src/trigger/policy.ts";
import { estimateTokens } from "../../src/kernel/ranking.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

function decision(id: string, project: string, content: string): MemoryEntry {
  return { id, kind: "decision", scope: "project", project, content, source: "s", ts: T };
}

/** 一个与 Facade.alwaysOn 同口径的假 facade (只做"投影 + selectAlwaysOn")。 */
function fakeFacade(entries: MemoryEntry[], calls: Array<{ project?: string }>) {
  return {
    async alwaysOn(opts: { project?: string; budgetTokens?: number } = {}) {
      calls.push({ ...(opts.project ? { project: opts.project } : {}) });
      return selectAlwaysOn(entries, {
        ...(opts.project ? { project: opts.project } : {}),
        budgetTokens: opts.budgetTokens ?? 400,
        estimate: estimateTokens,
      });
    },
    recall: () => ({ hits: [] }),
  } as never;
}

const seed = [
  decision("dApi", "api", "api 项目决定用 SQLite"),
  decision("dWeb", "web", "web 项目决定用 Postgres"),
];

describe("always-on 缓存按项目隔离", () => {
  it("先热 api 再热 web: 两边各自拿到本项目的条目 (不是同一份)", async () => {
    const calls: Array<{ project?: string }> = [];
    const cache = createTriggerCache({
      facade: fakeFacade(seed, calls),
      revision: () => 1,
      budgetTokens: 400,
    });

    await cache.refresh("api");
    expect(cache.ids("api")).toEqual(["dApi"]);

    await cache.refresh("web");
    // 关键断言: 如果缓存是全局一份, 这里仍是 ["dApi"] (第一个热身的项目毒化后面所有项目)。
    expect(cache.ids("web")).toEqual(["dWeb"]);
    // api 的那份没有被 web 的刷新顶掉。
    expect(cache.ids("api")).toEqual(["dApi"]);
  });

  it("每个项目各查一次库 (同一版本内不重复查询)", async () => {
    const calls: Array<{ project?: string }> = [];
    const cache = createTriggerCache({
      facade: fakeFacade(seed, calls),
      revision: () => 1,
      budgetTokens: 400,
    });
    await cache.refresh("api");
    await cache.refresh("api");
    await cache.refresh("web");
    expect(calls.map((c) => c.project)).toEqual(["api", "web"]);
  });

  it("没有项目上下文 → 不含任何项目内条目 (不再泄漏别的项目)", async () => {
    const calls: Array<{ project?: string }> = [];
    const cache = createTriggerCache({
      facade: fakeFacade(seed, calls),
      revision: () => 1,
      budgetTokens: 400,
    });
    await cache.refresh();
    expect(cache.ids()).toEqual([]);
    // 未传 project 也**不能**退化成"全都给"。
    expect(cache.ids("api")).toEqual([]);
  });

  it("recallFor 只叠加本项目的 always-on 与召回结果", async () => {
    const calls: Array<{ project?: string }> = [];
    const cache = createTriggerCache({
      facade: fakeFacade(seed, calls),
      revision: () => 1,
      budgetTokens: 400,
    });
    await cache.refresh("api");
    const out = cache.recallFor("容器并发", { inject: true, budgetTokens: 400 }, "api");
    expect(out.map((e) => e.id)).toEqual(["dApi"]);
  });
});
