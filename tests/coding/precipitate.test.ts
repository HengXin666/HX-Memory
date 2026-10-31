import { describe, expect, it } from "vitest";
import { detectSignal, inject, promote, runTurn } from "../../src/coding/precipitate.ts";

const FILE = "lib/middleware/query.js";
const DIFF = "rewrite parse() instead of adding a flag";

/**
 * 代码任务上的纠正按范围沉淀，不存骂人原话
 * .agents/notes/implemented/feature/2026-10-31-code-task-precipitate.md
 */
function writesFileScopedDecisionFromScolding(): void {
  const scold = "你他妈又把整个 query 中间件重写了。我只要加一个开关，解析方式上次就定了，别再动。";
  const first = runTurn([], { text: scold, diff: DIFF, workingSet: [FILE] }, "d1");
  expect(first.signal.reasons).toEqual(["骂人", "纠正"]);
  expect(first.redo).toBe(true);
  expect(first.written?.scope).toBe(FILE);
  expect(first.written?.concern).toBe("edit-scope");
  expect(first.written?.claim).toMatch(/只要加一个开关/);
  expect(first.written?.evidence).toMatch(/rewrite parse/);
  expect(first.pack).toMatch(/只要加一个开关/);

  const later = runTurn(first.decisions, { text: "给 query parser 加一个开关", diff: "", workingSet: [FILE] }, "d2");
  expect(later.signal.hit).toBe(false);
  expect(later.injected.map((d) => d.id)).toEqual(["d1"]);
  expect(later.pack).toMatch(/edit-scope/);
}

describe("code precipitate", () => {
  it("does not fire on a normal coding task", () => {
    const turn = runTurn([], { text: "给 query parser 加一个日志", diff: "", workingSet: [FILE] }, "d1");
    expect(turn.signal.hit).toBe(false);
    expect(turn.written).toBeNull();
    expect(turn.decisions).toHaveLength(0);
  });

  it("discards a bare insult", () => {
    const turn = runTurn([], { text: "你真废物", diff: "", workingSet: [FILE] }, "d1");
    expect(turn.signal.hit).toBe(true);
    expect(turn.written).toBeNull();
    expect(turn.discard ?? "").toMatch(/不入库/);
    expect(turn.decisions).toHaveLength(0);
  });

  it("writes a file-scoped decision from a scolding and injects it on a later task", () => {
    writesFileScopedDecisionFromScolding();
  });

  it("supersedes the active decision on the same scope and concern", () => {
    const first = runTurn([], { text: "别再重写。只要加开关。", diff: DIFF, workingSet: [FILE] }, "d1");
    const second = runTurn(
      first.decisions,
      { text: "又错了。不要加开关，只改注释。", diff: "added a flag", workingSet: [FILE] },
      "d2",
    );
    const active = second.decisions.filter((d) => d.status === "active");
    expect(active.map((d) => d.id)).toEqual(["d2"]);
    expect(second.decisions.find((d) => d.id === "d1")?.status).toBe("superseded");
    expect(inject(second.decisions, [FILE], "继续改这个文件")).toHaveLength(1);
  });

  it("stores a requirement correction off any file and reloads it by topic", () => {
    const turn = runTurn(
      [],
      { text: "这不是要的，查询必须向后兼容，别再做成破坏旧客户端的。", diff: "", workingSet: [FILE] },
      "d1",
    );
    expect(turn.written?.scope).toBe("req:backward-compat");
    expect(turn.written?.concern).toBe("backward-compat");
    expect(inject(turn.decisions, ["lib/response.js"], "查询协议要不要向后兼容")).toHaveLength(1);
    expect(inject(turn.decisions, ["lib/response.js"], "给响应头加日志")).toHaveLength(0);
  });

  it("promotes a decision to a hard rule without dropping it", () => {
    const turn = runTurn([], { text: "别再动解析。只要加开关。", diff: "", workingSet: [FILE] }, "d1");
    const hard = promote(turn.decisions, "d1");
    expect(hard[0]?.kind).toBe("hard");
    expect(inject(hard, [FILE], "改 query.js")).toHaveLength(1);
  });

  it("stays quiet without insult or correction", () => {
    expect(detectSignal("实现查询的扩展模式").hit).toBe(false);
  });
});
