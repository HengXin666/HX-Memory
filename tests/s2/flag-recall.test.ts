// tests/s2/flag-recall.test.ts — 负面标注的端到端 (s2, 真实文件 IO)。
//
// 钉住三件在真实使用里会静默变坏的事:
//   1. 标注必须**落盘且可重建** —— 只写在索引里的质量数据, 删索引就没了;
//   2. 坏评超标的记忆**只提议、不改动** —— "这条是错的"是需要人担责的判断 (治理铁律);
//   3. 零标注时**零副作用** —— 沉默是默认状态, 不能凭空产生队列项。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryFacade } from "../../src/app/facade.ts";
import { HybridRetriever } from "../../src/retrieval/hybrid.ts";
import { REVIEW_MIN_EXPOSURE } from "../../src/kernel/feedback.ts";

let root: string;
const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-flag-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一条可标注的记忆 + 一个接了 generalizer 的 facade (提议落进队列)。 */
function make() {
  const store = new FileBackend({ root });
  const retriever = new HybridRetriever(store);
  const proposals: Array<{ rule: string; covers?: string[]; sourceRun?: string }> = [];
  const facade = new MemoryFacade(
    { store, retriever },
    {
      now: () => "2026-06-02T00:00:00.000Z",
      generalizer: {
        enqueueProposal: (input) => {
          proposals.push(input);
          return { id: "p-test-" + proposals.length };
        },
      },
    },
  );
  store.add({
    id: "mFlag1",
    kind: "lesson",
    content: "某条可能不准的记忆",
    source: "t",
    scope: "project",
    project: "p1",
    ts: T,
  });
  return { store, facade, proposals };
}

describe("flagRecall: 只记坏的", () => {
  it("irrelevant 与 wrong 分别累加, 不混成一个分数", async () => {
    const { store, facade } = make();
    await facade.flagRecall("mFlag1", "irrelevant");
    await facade.flagRecall("mFlag1", "wrong");
    await facade.flagRecall("mFlag1", "wrong");
    const e = await store.get("mFlag1");
    expect(e?.feedback).toEqual({ irrelevant: 1, wrong: 2 });
    store.close();
  });

  it("非法 reason 被拒 (没有 'useful' 这类正向入口)", async () => {
    const { store, facade } = make();
    await expect(facade.flagRecall("mFlag1", "useful" as never)).rejects.toThrow(/irrelevant\|wrong/);
    store.close();
  });

  it("不存在的 id 返回 ok:false 而不是抛错 (不拖垮调用方)", async () => {
    const { store, facade } = make();
    const r = await facade.flagRecall("nope", "wrong");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not-found");
    store.close();
  });
});

describe("标注必须落盘且可重建", () => {
  it("标注写进真相文件 (删索引也不丢)", async () => {
    const { store, facade } = make();
    await facade.flagRecall("mFlag1", "wrong", "实测不符");
    store.close();
    const dir = join(root, "digest");
    const file = join(dir, readdirSync(dir)[0]!);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("feedback:");
    expect(JSON.parse(/^feedback: (.+)$/m.exec(text)![1]!)).toEqual({ irrelevant: 0, wrong: 1 });

    // 重新打开: 从文件重建也要读回同样的标注
    const store2 = new FileBackend({ root });
    const e = await store2.get("mFlag1");
    expect(e?.feedback).toEqual({ irrelevant: 0, wrong: 1 });
    store2.close();
  });
});

describe("坏评超标: 只提议、不改动记忆", () => {
  it("曝光不足时不产生提议", async () => {
    const { store, facade, proposals } = make();
    await store.update("mFlag1", { reinforcement: REVIEW_MIN_EXPOSURE - 1 });
    for (let i = 0; i < REVIEW_MIN_EXPOSURE - 1; i++) await facade.flagRecall("mFlag1", "wrong");
    expect(proposals).toHaveLength(0);
    store.close();
  });

  it("曝光够且占比够 → 产出提议, 且目标记忆本身未被改动", async () => {
    const { store, facade, proposals } = make();
    // 曝光 (reinforcement) 是阈值的分母: 从未被展示过的条目不该被人审 —— 先给足曝光。
    await store.update("mFlag1", { reinforcement: REVIEW_MIN_EXPOSURE });
    const before = await store.get("mFlag1");
    for (let i = 0; i < REVIEW_MIN_EXPOSURE; i++) await facade.flagRecall("mFlag1", "wrong");
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]!.covers).toEqual(["mFlag1"]);
    expect(proposals[0]!.sourceRun).toBe("recall-feedback");
    // 治理铁律: 只提议, 内容与状态都不许动
    const after = await store.get("mFlag1");
    expect(after?.content).toBe(before?.content);
    expect(after?.status).toBe(before?.status);
    store.close();
  });
});

describe("零标注零副作用", () => {
  it("没有任何标注时不产生队列项、不写 feedback 字段", async () => {
    const { store, facade, proposals } = make();
    expect(proposals).toHaveLength(0);
    const e = await store.get("mFlag1");
    expect(e?.feedback).toBeUndefined();
    store.close();
    const dir = join(root, "digest");
    const text = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
    expect(text).not.toContain("feedback:");
  });
});
