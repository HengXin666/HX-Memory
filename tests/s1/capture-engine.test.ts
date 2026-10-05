// tests/s1/capture-engine.test.ts — S1: capture engine pure logic. No network, no harness.
import { describe, expect, it } from "vitest";
import { captureTurn } from "../../src/capture/engine.ts";

const base = { session: "s1" };

describe("captureTurn: explicit capture", () => {
  it('"记住 X" becomes a fact entry with content X', () => {
    const r = captureTurn({ ...base, text: "记住: 队列并发上限是 4" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("fact");
    expect(r.entries[0]!.content).toBe("队列并发上限是 4");
    expect(r.entries[0]!.source).toBe("session:s1");
  });

  it("explicit capture gets bitemporal timestamps", () => {
    const r = captureTurn({ ...base, text: "记一下: 生产库禁止直连" });
    expect(r.entries[0]!.ts.validAt).toBeTruthy();
    expect(r.entries[0]!.ts.assertedAt).toBeTruthy();
  });
});

describe("captureTurn: kind inference", () => {
  it("detects lesson signal (踩坑/concurrency)", () => {
    const r = captureTurn({ ...base, text: "后端队列并发踩坑了, 下次要注意幂等" });
    expect(r.entries[0]!.kind).toBe("lesson");
  });

  it("detects decision signal", () => {
    const r = captureTurn({ ...base, text: "决定采用 pnpm 作为包管理器" });
    expect(r.entries[0]!.kind).toBe("decision");
  });

  it("detects rule/pattern signal (所有容器)", () => {
    const r = captureTurn({ ...base, text: "规则: 所有容器都要显式设计并发上限" });
    expect(r.entries[0]!.kind).toBe("pattern");
  });

  it("detects preference signal", () => {
    const r = captureTurn({ ...base, text: "我更喜欢用英文标点写文档" });
    expect(r.entries[0]!.kind).toBe("preference");
  });

  it("plain chit-chat yields no capture (context filtered)", () => {
    const r = captureTurn({ ...base, text: "你好, 今天天气不错" });
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toContain("no-signal");
  });

  // ---- 祈使式禁令 (2026-09-18 新增) ----
  // 为什么单独一组: 判据此前只有"以后都要/规则/不变量"这些**名词式**信号, 而真实对话里
  // 约束更常以**祈使句**给出。实测真库的丢弃样本里 "不要每次都在本桌面启动浏览器!" 这类
  // 用户直接下达的行为边界全部落进 context 兜底被丢掉 —— 而它们正是下次做同类任务时
  // 最需要的约束 (丢掉 = 让助手重复犯同一个错)。下列用例取自真实丢弃样本。
  it("识别祈使式禁令 (不要每次都…)", () => {
    const r = captureTurn({ ...base, text: "all 不要每次都在本桌面启动浏览器!" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("pattern");
  });

  it("识别句首祈使纠正 (别接入写错了)", () => {
    const r = captureTurn({ ...base, text: "别接入写错了, 这是另一个项目" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("pattern");
  });

  it("识别标点后的祈使约束 (不要猜端点、字段名)", () => {
    const r = captureTurn({
      ...base,
      text: "动手前先读接入文档, 不要猜端点、字段名或枚举值",
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe("pattern");
  });

  it("识别约定式统一表述 (统一设为)", () => {
    const r = captureTurn({ ...base, text: "日志格式统一用 JSON, 方便机器解析" });
    expect(r.entries).toHaveLength(1);
  });

  // 反向风险: 放宽判据后不能把普通叙述里的"不要"也当成约束。
  it("正文里的 '不要' 不算约束 (不引入噪声)", () => {
    // 描述代码行为, 不是在给助手下约束
    const r = captureTurn({ ...base, text: "那段测试片段现在不要了, 已经删掉" });
    expect(r.entries).toHaveLength(0);
  });

  it("继续/确认类短指令仍不捕获 (不因放宽而捡回噪声)", () => {
    for (const t of ["next", "继续啊", "yes", "run", "结论说中文"]) {
      expect(captureTurn({ ...base, text: t }).entries).toHaveLength(0);
    }
  });
});

describe("captureTurn: scoping + dedupe", () => {
  it("project present → scope:project; absent → scope:agent", () => {
    const withProj = captureTurn({ ...base, text: "记住: X", project: "hx-memory" });
    expect(withProj.entries[0]!.scope).toBe("project");
    const noProj = captureTurn({ ...base, text: "记住: Y" });
    expect(noProj.entries[0]!.scope).toBe("agent");
  });

  it("identical content dedupes via hash", () => {
    const first = captureTurn({ ...base, text: "记住: 幂等键用 UUID" });
    // entry id = "c" + contentHash; the dedupe set holds the raw hash
    const hash = first.entries[0]!.id.slice(1);
    const hashes = new Set([hash]);
    const second = captureTurn({ ...base, text: "记住: 幂等键用 UUID" }, {}, hashes);
    expect(second.entries).toHaveLength(0);
    expect(second.deduped).toBe(1);
  });

  it("off mode captures nothing", () => {
    const r = captureTurn({ ...base, text: "记住: 这个不重要" }, { mode: "off" });
    expect(r.entries).toHaveLength(0);
    expect(r.signal).toBe("off");
  });

  it("forceKind overrides inference", () => {
    const r = captureTurn({ ...base, text: "生产库禁止直连" }, { forceKind: "fact" });
    expect(r.entries[0]!.kind).toBe("fact");
  });
});
