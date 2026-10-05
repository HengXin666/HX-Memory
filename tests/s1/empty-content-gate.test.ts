// tests/s1/empty-content-gate.test.ts — **两个引擎**都必须拒绝空内容条目。
//
// 为什么需要它 (2026-09-18, §701 实测): `store.add({content: ""})` 此前被**接受**, 而那样的条目
// **会进 always-on** —— 一个空条目占保底预算、注入一块空白。
//
// 上游其实已有两道防线 (`memory_save` 工具的 "content cannot be empty" 与
// `facade.remember` 的 "remember: content is required"), 真库实测 **0 条空内容** ⇒ 上游足够。
// 但在**存储层**补它是"不变量该在最低层成立" —— 与 `rule` 那条确认闸门同一个理由:
// **换引擎或新调用点绕不过**。
//
// ⚠ 本测试覆盖**两个引擎** (FileBackend / MemoryStore) —— 它们的**不变量必须一致**
// ("换引擎不等于换规则")。实测第一版我只补了 MemoryStore, 而 FileBackend 仍接受空内容。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";
import type { MemoryEntryInput } from "../../src/kernel/types.ts";

const T = { validAt: "2026-01-01T00:00:00Z", assertedAt: "2026-01-01T00:00:00Z" };
const mk = (content: string): MemoryEntryInput =>
  ({ kind: "fact", content, source: "t", scope: "agent", ts: T }) as MemoryEntryInput;

describe("存储层: 空内容闸门 (两引擎同口径)", () => {
  it("**FileBackend 拒绝空与纯空白 content**", () => {
    const root = mkdtempSync(join(tmpdir(), "empty-fb-"));
    const store = new FileBackend({ root });
    try {
      expect(() => store.add(mk(""))).toThrow(/must not be empty/);
      expect(() => store.add(mk("   \n\t "))).toThrow(/must not be empty/);
      // 而正常内容必须能进 (闸门不能过宽)。
      expect(store.add(mk("正常内容")).content).toBe("正常内容");
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**MemoryStore 同样拒绝** (两引擎口径一致)", () => {
    const store = new MemoryBackend();
    expect(() => store.add(mk(""))).toThrow(/must not be empty/);
    expect(() => store.add(mk("   "))).toThrow(/must not be empty/);
    expect(store.add(mk("正常内容")).content).toBe("正常内容");
  });

  it("### 负例: 闸门**不**误伤首尾带空白的正常内容 (trim 只用于判空, 不改写)", () => {
    const store = new MemoryBackend();
    const e = store.add(mk("  有价值的内容  "));
    // 判空用 trim, 而**存下来的仍是原文** —— 闸门不该顺手改写数据。
    expect(e.content).toBe("  有价值的内容  ");
  });
});
