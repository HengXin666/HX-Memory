// tests/s2/link-bypass-gate.test.ts — 建边前置门必须与建边**同口径**。
//
// 为什么单独钉住: "索引侧兜底抽取 vs 真相字段" 这条断链在本项目**出现过两次** ——
//   ① planStructuralLinks 本身只读 entry.entities (已修, 改用 entitiesOf 兜底);
//   ② `withStructuralLinks` 的**前置门**仍只看真相字段 (2026-09-18 修)。
// 第二次的后果可量化: 真实库 193 条里只有 30 条 (16%) 有出边, 而实体兜底抽取的实际覆盖是 82%
// —— 大量"有实体"的条目在进建边函数**之前**就被那道门挡掉了。
//
// 本文件的断言方式: 直接构造"**真相字段为空、但正文含可抽取实体**"的条目, 断言它仍被建边
// —— 这正是两次断链的共同特征。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "linkgate-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 无 entities 字段但正文含可抽取专名的文本 (启发式结构化器的常态)。
 *
 * 注意文本必须能**通过捕获判据** (否则第一条不落盘, 第二条就没邻居可连 —— 这是
 * 测试用例的选择问题, 不是实现缺陷; 实测 `prestep.ts 的注入时机…` 这种纯陈述会被
 * 判成 context 丢弃, 故用"踩坑:/决定:"这类带信号的措辞)。
 */
const A = "踩坑: prestep.ts 的注入时机由 injectMode 控制";
const B = "决定: prestep.ts 读 trigger-cache 的 revision 决定是否重算";

describe("建边前置门: 口径必须与建边一致", () => {
  it("**真相字段为空但正文含实体** → 仍建边 (两次断链的共同特征)", async () => {
    const store = new FileBackend({ root });
    // 用启发式结构化器 (不产 entities) —— 这就是真实默认路径
    const pipe = new CapturePipeline(store, { reviewRoot: root });
    const r1 = await pipe.run({ session: "s", turn: 1, text: A, answer: "已记录。" } as never);
    const r2 = await pipe.run({ session: "s", turn: 2, text: B, answer: "已记录。" } as never);
    expect(r1.entries.length + r2.entries.length).toBeGreaterThan(0);

    const all = store.all();
    const withRelates = all.filter((e) => (e.relations ?? []).some((x) => x.type === "relates"));
    // 两条共享 prestep.ts, 应当被连起来
    expect(withRelates.length).toBeGreaterThan(0);
    store.close();
  });

  it("既无实体也无标签的条目不被强行建边 (不能为凑数连边)", async () => {
    const store = new FileBackend({ root });
    const pipe = new CapturePipeline(store, { reviewRoot: root });
    await pipe.run({ session: "s", turn: 1, text: "今天天气不错", answer: "是的。" } as never);
    const all = store.all();
    for (const e of all) {
      expect((e.relations ?? []).filter((x) => x.type === "relates")).toHaveLength(0);
    }
    store.close();
  });

  it("maxStructuralLinks=0 时完全关闭 (配置生效)", async () => {
    const store = new FileBackend({ root });
    const pipe = new CapturePipeline(store, { reviewRoot: root, maxStructuralLinks: 0 });
    await pipe.run({ session: "s", turn: 1, text: A, answer: "已记录。" } as never);
    await pipe.run({ session: "s", turn: 2, text: B, answer: "已记录。" } as never);
    for (const e of store.all()) {
      expect((e.relations ?? []).filter((x) => x.type === "relates")).toHaveLength(0);
    }
    store.close();
  });
});
