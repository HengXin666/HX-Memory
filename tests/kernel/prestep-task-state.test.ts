// tests/kernel/prestep-task-state.test.ts — task-state 接进 pre-step: 用户只说「继续」时注入「继续什么」。
// 见 PRESTEP-WIRING.md。全量历史走 session-events.ts (这里用 session.events 喂真实事件形状)。
import { describe, expect, it } from "vitest";
import { makePreStepHandler, taskStateLine, historyForTaskState, type PreStepPayload } from "../../src/adapters/dsh/prestep.ts";
import { Binder } from "../../src/kernel/binder.ts";
import { computeTaskState } from "../../src/kernel/task-state.ts";

const CWD = "/home/hx/Loli/code/HXLoLis/components/HX-Memory";
// 库里没有任何条目: 证明「继续什么」不依赖记忆库 (39 行账本的根因正是库里没有这条信息)。
const binder = new Binder(() => [], () => []);
const handler = makePreStepHandler(binder, { rootAgentsOnly: () => false, enabled: () => true, projectOf: () => "HX-Memory" });

let seq = 0;
const userEv = (text: string) => ({ type: "user/message", seq: ++seq, data: { role: "user", id: "u" + seq, content: [{ type: "text", text }], source: { kind: "user" } } });
const asstEv = (text: string) => ({ type: "assistant/message", seq: ++seq, data: { message: { role: "assistant", content: [{ type: "text", text }] } } });
const toolEv = (text: string) => ({ type: "tool/result", seq: ++seq, data: { message: { role: "tool", content: [{ type: "text", text }] } } });
const claimed = (text: string) => ({ role: "user", id: "cur" + ++seq, content: [{ type: "text", text }], source: { kind: "user" } });

async function run(events: unknown[], text: string) {
  const cur = claimed(text);
  const payload: PreStepPayload = { agent: { session: { id: "s-ts", header: { cwd: CWD }, events } }, messages: [cur], step: 1 };
  const d = (await handler(payload, async () => ({ kind: "enter", messages: [cur] }))) as { messages: unknown[] };
  const block = d.messages.find((m) => JSON.stringify(m).includes("HX-Memory"));
  return block ? ((block as { content: { text: string }[] }).content[0]!.text) : null;
}

describe("pre-step × task-state: 裸「继续」", () => {
  it("a 历史有明确上一动作 → 注入块里出现上一动作与涉及文件", async () => {
    const text = await run([userEv("修一下 src/trigger/policy.ts 的短路顺序"), asstEv("好, 我先看 policy.ts")], "继续");
    expect(text).not.toBeNull();
    expect(text).toContain("【当前任务】");
    expect(text).toContain("动作: 修改");
    expect(text).toContain("src/trigger/policy.ts");
    expect(text).toContain("修一下 src/trigger/policy.ts 的短路顺序");
  });

  it("b 历史空白 → 不注入, 不伪造上一任务", async () => {
    const text = await run([], "继续");
    expect(text).toBeNull();
    const line = taskStateLine(computeTaskState({ cwd: CWD, messages: [claimed("继续")] }), "继续", "zh");
    expect(line).toEqual({ line: "", force: false });
  });

  it("c 同一句「继续」在两个任务状态下文本不同, 且判重不再误杀", async () => {
    const histA = [userEv("修一下 src/trigger/policy.ts 的短路顺序"), asstEv("好")];
    const histB = [userEv("新增 src/kernel/task-state.ts 的续接测试"), asstEv("好")];
    const a = await run(histA, "继续");
    const b = await run(histB, "继续");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    // A 的块已在会话日志里 (prior.texts 含它), 任务切到 B 后再说「继续」: 仍要注入。
    const injectedA = { type: "user/message", seq: ++seq, data: { role: "user", content: [{ type: "text", text: a }], source: { kind: "plugin:hx-memory", form: "instructions" } } };
    const again = await run([...histA, injectedA, ...histB], "继续");
    expect(again).toBe(b);
    // 同一状态下再说一次「继续」: 同一块 → 判重照常挡掉 (去重没被拆)。
    const injectedB = { ...injectedA, seq: ++seq, data: { ...injectedA.data, content: [{ type: "text", text: b }] } };
    expect(await run([...histB, injectedB], "继续")).toBeNull();
  });

  it("d previousAction 为空时 blockedOn 不许出现", async () => {
    // 历史里只有报错, 没有任何带动作词的用户轮。
    const text = await run([userEv("嗯"), toolEv("Error: ECONNREFUSED 127.0.0.1:7890 failed")], "继续");
    expect(text).toBeNull();
    const s = computeTaskState({ cwd: CWD, messages: [{ role: "user", content: "嗯" }, { role: "tool", content: "Error: ECONNREFUSED" }, { role: "user", content: "继续" }] });
    expect(s.previousAction).toBeNull();
    expect(s.blockedOn).toBeNull();
    // 即使上游给出了不一致的状态, 行里也不许出现失败信息。
    expect(taskStateLine({ ...s, blockedOn: "ECONNREFUSED: x" }, "继续", "zh").line).toBe("");
  });

  it("e 有上一动作且其后工具报错未修复 → blockedOn 随块出现", async () => {
    const text = await run([userEv("修一下 src/adapters/dsh/proxy.ts 的重连"), toolEv("Error: ECONNREFUSED 127.0.0.1:7890")], "next");
    expect(text).toContain("未闭合的失败: ECONNREFUSED");
    expect(text).toContain("用户本轮只说「next」");
  });

  it("f historyForTaskState: 会话事件 + claimed 批次按 id 去重, 跳过非消息事件", () => {
    const u = userEv("修 a/b.ts");
    const h = historyForTaskState({ events: [u, { type: "step/start", seq: ++seq, data: {} }, asstEv("ok")] }, [u.data, claimed("继续")]);
    expect(h.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "user"]);
  });
});
