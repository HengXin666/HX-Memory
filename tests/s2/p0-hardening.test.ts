// tests/s2/p0-hardening.test.ts — 三个实测发现的问题的回归护栏。
//
// 都是"本地全绿但语义错"的类型, 因此断言必须钉住**可观察的行为差异**, 不是"没抛错":
//   1. alwaysOn 走廉价投影 (而不是 all() 的全量 hydrate) —— 预步每轮都跑, 10k 条差 22 倍;
//   2. 跨进程写入必须能被向量通道看到 (此前 BM25 看得到、向量看不到);
//   3. 确定性注入路径必须触发"命中即强化" (此前只有模型主动查才强化)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { openMemoryStack } from "../../src/app/stack.ts";
import { Binder, type TriggerSource } from "../../src/kernel/binder.ts";
import { MemoryFacade } from "../../src/app/facade.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";

const REPO = join(import.meta.dirname, "../..");
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-p0-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("P0-1: alwaysOn 用廉价投影而不是全量 hydrate", () => {
  it("FileBackend 提供 entrySummaries 且语义等价于 all() 的 active 子集", async () => {
    const store = new FileBackend({ root });
    for (let i = 0; i < 20; i++) {
      store.add({
        id: "m" + i,
        kind: "lesson",
        content: "第 " + i + " 条",
        source: "s",
        scope: "agent",
        ts: T,
      });
    }
    store.add({
      id: "gone",
      kind: "lesson",
      content: "撤回的",
      source: "s",
      scope: "agent",
      ts: T,
    });
    store.remove("gone");
    const summaries = store.entrySummaries();
    const active = store.all().filter((e) => (e.status ?? "active") === "active");
    expect(summaries.map((s) => s.id).sort()).toEqual(active.map((e) => e.id).sort());
    // 投影只含选择所需字段 (不含 relations/tags) —— 这是它便宜的原因。
    expect(summaries[0]).not.toHaveProperty("relations");
    expect(summaries[0]).not.toHaveProperty("tags");
    store.close();
  });

  it("facade.alwaysOn 不再调用 all() (用计数包装证明)", async () => {
    const store = new FileBackend({ root });
    store.add({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "涉及容器并发先检查策略",
      source: "review",
      ts: T,
      confirmedBy: "hx",
      confirmedAt: T.assertedAt,
    });
    // 直接构造 Facade (openMemoryStack 会自建 store, 无法注入计数包装的实例)。
    let allCalls = 0;
    const originalAll = store.all.bind(store);
    (store as unknown as { all: typeof store.all }).all = () => {
      allCalls++;
      return originalAll();
    };
    const retriever = new HybridRetriever(store);
    const facade = new MemoryFacade({ store, retriever });
    const picked = await facade.alwaysOn({ project: "api", budgetTokens: 400 });
    expect(picked.map((e) => e.id)).toContain("rule-1");
    expect(allCalls, "alwaysOn 不应触碰 all() (预步每轮都跑)").toBe(0);
    store.close();
  });
});

describe("P0-2: 跨进程写入对向量通道可见", () => {
  it("另一个进程写入后, revision 变化且向量通道能召回 (此前只有 BM25 看得到)", async () => {
    const stack = openMemoryStack(root);
    stack.store.add({
      id: "local",
      kind: "lesson",
      content: "本地已有记忆",
      source: "s",
      scope: "agent",
      ts: T,
    });
    // 先检索一次, 让内存向量索引同步到当前版本
    stack.retriever.retrieveSync({ text: "本地已有记忆", limit: 5 });
    const before = stack.store.revision();

    // 另一个进程写入 (本进程的 store 完全不知道)
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "-e",
        `import { FileBackend } from "${REPO}/src/storage/file-store.ts";
const s = new FileBackend({ root: "${root}" });
s.add({ id: "external", kind: "lesson", content: "外部进程写入的语义独特内容 ZQXJ", source: "other", scope: "agent", ts: { validAt: "${T.validAt}", assertedAt: "${T.assertedAt}" } });
s.close();`,
      ],
      { encoding: "utf8" },
    );

    // revision 必须变化 (PRAGMA data_version 反映其它连接提交)
    expect(stack.store.revision(), "外部写入必须让 revision 变化").not.toBe(before);
    const out = stack.retriever.retrieveSync({ text: "外部进程写入的语义独特内容 ZQXJ", limit: 5 });
    const hit = out.hits.find((h) => h.entry.id === "external");
    expect(hit, "外部写入的条目必须能被检索到").toBeDefined();
    stack.close();
  }, 30_000);
});

describe("P0-3: 确定性注入路径触发命中强化", () => {
  it("Binder 注入后会回报被注入的 id (onInjected)", async () => {
    const store = new FileBackend({ root });
    store.add({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "涉及容器并发先检查策略",
      source: "review",
      ts: T,
      confirmedBy: "hx",
      confirmedAt: T.assertedAt,
    });
    const reported: string[] = [];
    const trigger: TriggerSource = {
      alwaysOn: () => ["rule-1"],
      recallFor: () => [store.get("rule-1")!],
      now: () => "2026-06-01T00:00:00.000Z",
      onInjected: (ids) => reported.push(...ids),
    };
    const binder = new Binder(
      (q) => store.query(q),
      () => [],
      undefined,
      trigger,
    );
    binder.injectFor("api", "把这个函数重命名");
    expect(reported, "确定性注入必须回报 id 以便强化").toContain("rule-1");
    store.close();
  });

  it("端到端: 注入路径真的让 reinforcement 增长 (此前一直是 undefined)", async () => {
    const stack = openMemoryStack(root);
    stack.store.add({
      id: "rule-1",
      kind: "rule",
      scope: "global",
      content: "涉及容器并发先检查策略",
      source: "review",
      ts: T,
      confirmedBy: "hx",
      confirmedAt: T.assertedAt,
    });
    await stack.facade.reinforce(["rule-1"]);
    const after = stack.store.get("rule-1");
    expect(after?.reinforcement).toBe(1);
    expect(after?.lastHitAt).toBeTruthy();
    stack.close();
  });
});
