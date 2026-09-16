// tests/s2/schedule-log.test.ts — 注入调度账本: "为什么这一轮注入/没注入" 必须落盘且可查。
//
// 为什么必须有这些断言: 触发层的设计目标 ("'为什么没注入'必须和'注入了什么'一样可查")
// 此前是**没有实现**的 —— TriggerDecision 只活在 Binder 的私有字段里。账本把这条目标变成
// 可执行事实, 而"没注入"的那几种恰恰是最容易漏记的 (只记成功的账本等于没有账本)。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleLog, type ScheduleRecord } from "../../src/adapters/dsh/schedule-log.ts";
import { makePreStepHandler, type PreStepRecord } from "../../src/adapters/dsh/prestep.ts";
import { Binder, type BindingConfig } from "../../src/kernel/binder.ts";
import type { MemoryEntry, Query } from "../../src/kernel/types.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-schedule-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    at: "2026-06-01T10:00:00.000Z",
    session: "s1",
    step: 1,
    channel: "trigger",
    mode: "always-on",
    outcome: "injected",
    intent: null,
    confidence: 0,
    topicDrift: 1,
    reason: "always-on 保底通道",
    selected: ["r1"],
    ids: ["r1"],
    tokens: 42,
    ...over,
  };
}

describe("ScheduleLog: 追加与读取", () => {
  it("按天分文件, 追加而不是改写", () => {
    const log = new ScheduleLog({ root });
    log.append(record({ at: "2026-06-01T10:00:00.000Z", step: 1 }));
    log.append(record({ at: "2026-06-02T10:00:00.000Z", step: 2, session: "s2" }));
    expect(log.size().files).toBe(2);
    expect(log.size().records).toBe(2);
    const tail = log.recent(10);
    expect(tail[0]?.session).toBe("s2"); // 新→旧
    expect(tail[1]?.step).toBe(1);
  });

  it("坏行只跳过, 不让整份账本不可读", () => {
    const log = new ScheduleLog({ root });
    log.append(record());
    writeFileSync(join(log.dirPath, "2026-06-01.jsonl"), "{ not json\n", { flag: "a" });
    expect(log.recent(10).length).toBe(1);
  });

  it("单日行数上限: 到顶就拒写 (账本不许长成拖垮宿主的东西)", () => {
    const log = new ScheduleLog({ root, maxLinesPerDay: 2 });
    expect(log.append(record({ step: 1 }))).toBe(true);
    expect(log.append(record({ step: 2 }))).toBe(true);
    expect(log.append(record({ step: 3 }))).toBe(false);
  });

  it("保留期按整天文件清理; 0 = 永久", () => {
    const log = new ScheduleLog({ root, retentionDays: 3 });
    log.append(record({ at: "2026-06-01T10:00:00.000Z" }));
    log.append(record({ at: "2026-06-10T10:00:00.000Z" }));
    expect(log.prune("2026-06-10T10:00:00.000Z")).toBe(1);
    expect(log.size().files).toBe(1);
    const forever = new ScheduleLog({ root, retentionDays: 0 });
    expect(forever.prune("2030-01-01T00:00:00.000Z")).toBe(0);
  });
});

describe("ScheduleLog: 按会话聚合 (面板主视图)", () => {
  it("计数 / 模式分布 / token 求和 / last* 取最新一条", () => {
    const log = new ScheduleLog({ root });
    log.append(record({ session: "s1", step: 1, at: "2026-06-01T10:00:00.000Z", tokens: 10 }));
    log.append(
      record({
        session: "s1",
        step: 2,
        at: "2026-06-01T10:00:05.000Z",
        outcome: "nothing-new",
        mode: "skip-similar",
        reason: "同一话题上一轮已注入过",
        ids: [],
        tokens: 0,
      }),
    );
    log.append(record({ session: "s2", step: 1, at: "2026-06-01T10:00:09.000Z", tokens: 7 }));
    const sessions = log.sessions(100);
    const s1 = sessions.find((s) => s.session === "s1");
    expect(s1?.steps).toBe(2);
    expect(s1?.injected).toBe(1);
    expect(s1?.skipped).toBe(1);
    expect(s1?.tokens).toBe(10);
    expect(s1?.modes["always-on"]).toBe(1);
    expect(s1?.modes["skip-similar"]).toBe(1);
    expect(s1?.lastOutcome).toBe("nothing-new");
    expect(s1?.lastReason).toContain("同一话题");
    // 会话本身按"最近活动"排序 (第一条记录 = 最新的会话)。
    expect(sessions[0]?.session).toBe("s2");
  });
});

describe("pre-step: 每一次判定都落账 (含没注入的那几种)", () => {
  const rule: MemoryEntry = {
    id: "rA",
    kind: "rule",
    content: "所有容器都要显式设计并发上限",
    source: "t",
    scope: "global",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    confirmedBy: "u",
    confirmedAt: "t",
  };
  const configs: BindingConfig[] = [
    {
      project: "proj-web",
      bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
    },
  ];
  const binder = new Binder(
    (q: Query) => [rule].filter((e) => (q.kind ? e.kind === q.kind : true)),
    () => configs,
  );

  function msg(role: string, text: string) {
    return { role, content: [{ type: "text", text }] };
  }
  function handler(records: PreStepRecord[], options: Record<string, unknown> = {}) {
    return makePreStepHandler(binder, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      onDecision: (d: PreStepRecord) => records.push(d),
      ...options,
    } as never);
  }

  it("注入成功 → outcome=injected, 带 channel/mode/ids/tokens", async () => {
    const records: PreStepRecord[] = [];
    const claimed = [msg("user", "帮我部署一个容器, 注意并发")];
    const decision = await handler(records)(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 7 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    const d = decision as { messages: unknown[] };
    expect(d.messages.length).toBe(2); // 注入确实发生了
    expect(records.length).toBe(1);
    expect(records[0]?.outcome).toBe("injected");
    expect(records[0]?.channel).toBe("binding");
    expect(records[0]?.ids).toContain("rA");
    expect(records[0]?.tokens).toBeGreaterThan(0);
    expect(records[0]?.step).toBe(7);
    expect(records[0]?.session).toBe("proj-web");
  });

  it("没有任何绑定可走 → 仍然记一条 (不能只有成功的账)", async () => {
    const records: PreStepRecord[] = [];
    const plain = new Binder(
      (q: Query) => [rule].filter((e) => e.kind === q.kind),
      () => [],
    );
    const h = makePreStepHandler(plain, {
      rootAgentsOnly: () => false,
      enabled: () => true,
      onDecision: (x: PreStepRecord) => records.push(x),
    } as never);
    const claimed = [msg("user", "把函数改名")];
    await h(
      { agent: { session: { id: "no-bind" } }, messages: claimed, step: 1 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    );
    expect(records.length).toBe(1);
    // 没有任何通道可走 → "empty" (而不是"选了但被挡掉", 那会把真正的原因归咎于判重)。
    expect(records[0]?.outcome).toBe("empty");
    expect(records[0]?.channel).toBe("none");
    expect(records[0]?.ids).toEqual([]);
  });

  it("first 模式下一轮不再注入 → 记 skipped (而不是静默消失)", async () => {
    const records: PreStepRecord[] = [];
    const claimed = [msg("user", "部署容器")];
    const h = handler(records, { injectMode: () => "first" });
    const first = (await h(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 1 } as never,
      async () => ({ kind: "enter", messages: [...claimed] }),
    )) as { messages: unknown[] };
    expect(records[0]?.outcome).toBe("injected");
    await h(
      { agent: { session: { id: "proj-web" } }, messages: claimed, step: 2 } as never,
      async () => ({ kind: "enter", messages: [...first.messages] }),
    );
    expect(records[1]?.outcome).toBe("skipped");
    expect(records[1]?.step).toBe(2);
  });

  it("账本写失败不许拖垮注入 (best-effort)", () => {
    // root 是一个**文件**而不是目录: mkdir 必然失败。断言 append 返回 false 而不是抛错。
    // (不拿 /proc 之类特殊路径当"不可写": 那类路径在某些内核上会让 mkdir 卡住,
    //  把一条单元断言变成挂起 —— 真实的坑, 已踩过。)
    const asFile = join(root, "not-a-dir");
    writeFileSync(asFile, "x");
    const log = new ScheduleLog({ root: asFile });
    expect(() => log.append(record())).not.toThrow();
    expect(log.append(record())).toBe(false);
    expect(log.hasWriteFailed()).toBe(true);
  });
});

describe("落盘格式对得上 (面板与人都按同一份字段读)", () => {
  it("写出去的行能被 parseRecord 原样读回", () => {
    const log = new ScheduleLog({ root });
    log.append(record({ project: "api", step: 3, selected: ["a", "b"], ids: ["b"] }));
    const line = readFileSync(join(log.dirPath, "2026-06-01.jsonl"), "utf8").trim();
    const back = log.recent(1)[0];
    expect(line).toContain('"project":"api"');
    expect(back?.selected).toEqual(["a", "b"]);
    expect(back?.ids).toEqual(["b"]);
  });
});
