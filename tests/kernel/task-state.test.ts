import { describe, expect, it } from "vitest";
import { computeTaskState, extractPaths } from "../../src/kernel/task-state.ts";

const CWD = "/home/hx/Loli/code/HXLoLis/components/HX-Memory";
const user = (text: string) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const tool = (text: string) => ({ role: "tool", source: { kind: "tool" }, content: [{ type: "text", text }] });
const injected = (text: string) => ({ role: "user", source: { kind: "plugin" }, content: [{ type: "text", text }] });

describe("computeTaskState", () => {
  it("改文件的消息 → files/modules 正确, action=修改", () => {
    const s = computeTaskState({
      cwd: CWD,
      project: "HX-Memory",
      messages: [
        user("帮我改一下 src/storage/file-store.ts 的写入逻辑"),
        assistant("先读 src/storage/file-store.ts 和 src/kernel/types.ts"),
        tool("export class FileStore { ... } // src/storage/file-store.ts"),
      ],
    });
    expect(s.files[0]).toBe("src/storage/file-store.ts");
    expect(s.files).toContain("src/kernel/types.ts");
    expect(s.modules).toEqual(["src/storage", "src/kernel"]);
    expect(s.action).toBe("修改");
    expect(s.project).toBe("HX-Memory");
    expect(s.confidence).toBeGreaterThanOrEqual(0.8);
    expect(s.goal).toBe("在 src/storage、src/kernel 修改");
  });

  it("只有报错 → error 与关键词抓到", () => {
    const s = computeTaskState({
      cwd: CWD,
      messages: [tool("fetch http://127.0.0.1:4399/v1/embeddings\nError: connect ECONNREFUSED 127.0.0.1:4399\n    at TCPConnectWrap")],
    });
    expect(s.errorKeyword).toBe("ECONNREFUSED");
    expect(s.error).toContain("connect ECONNREFUSED 127.0.0.1:4399");
    expect(s.goal).toBe("最近报错 ECONNREFUSED");
  });

  it("「嗯」「继续」→ confidence < 0.2, modules 空", () => {
    const s = computeTaskState({ cwd: CWD, messages: [user("嗯"), assistant("好的"), user("继续")] });
    expect(s.confidence).toBeLessThan(0.2);
    expect(s.modules).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.action).toBe("未知");
    expect(s.goal).toBe("");
  });

  it("空 messages / 非法输入不抛异常", () => {
    expect(() => computeTaskState({ cwd: "", messages: [] })).not.toThrow();
    expect(() => computeTaskState({ cwd: CWD, messages: [null, 3, "x", {}, { role: "user" }] as unknown[] })).not.toThrow();
    const s = computeTaskState({ cwd: "", messages: [] });
    expect(s).toMatchObject({ modules: [], files: [], action: "未知", error: null, goal: "" });
    expect(s.confidence).toBe(0.1);
  });

  it("多个路径 → 按出现次数排序, 平局取更近", () => {
    const s = computeTaskState({
      cwd: CWD,
      messages: [
        user("看看 src/a/one.ts"),
        tool("src/b/two.ts src/b/two.ts src/b/two.ts src/c/three.ts src/c/three.ts"),
        assistant("src/d/four.ts src/a/one.ts"),
      ],
    });
    expect(s.files).toEqual(["src/b/two.ts", "src/a/one.ts", "src/c/three.ts", "src/d/four.ts"]);
    expect(s.action).toBe("排查");
  });

  it("中文路径与英文路径混用, 绝对路径归一到 cwd 相对", () => {
    const s = computeTaskState({
      cwd: CWD,
      messages: [
        user("删掉 docs/设计/记忆衰减.md 里过期那节, 再看 " + CWD + "/src/kernel/cjk.ts"),
      ],
    });
    expect(s.files).toEqual(expect.arrayContaining(["docs/设计/记忆衰减.md", "src/kernel/cjk.ts"]));
    expect(s.modules).toEqual(expect.arrayContaining(["docs/设计", "src/kernel"]));
    expect(s.action).toBe("删除");
  });

  it("插件注入的记忆块不算任务信号", () => {
    const s = computeTaskState({
      cwd: CWD,
      messages: [injected("【相关记忆】 src/old/legacy.ts 曾经报错 failed"), user("嗯")],
    });
    expect(s.files).toEqual([]);
    expect(s.error).toBeNull();
  });

  it("消息里没有路径时用 cwd 兜底推模块 (cwd 是仓库根则不推)", () => {
    const s = computeTaskState({ cwd: CWD + "/src/trigger", messages: [user("修一下这里的意图判断")] });
    expect(s.modules).toEqual(["src/trigger"]);
    expect(s.files).toEqual([]);
    expect(s.confidence).toBe(0.4);
  });

  it("URL 与日期不当路径; 「清楚」不算删除", () => {
    expect(extractPaths("见 https://example.com/a/b.js 和 2026/11/03")).toEqual([]);
    const s = computeTaskState({ cwd: CWD, messages: [user("我说清楚了吗")] });
    expect(s.action).toBe("未知");
  });

  // ---- 2026-11-03 回归: 历史淹没当前轮 (真实样例 yes / next / 修代理) ----
  const noisyHistory = (n: number): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < n / 4; i++) {
      out.push(user("新增一个接口, 改 workspaces/browser-auto/app/m" + i + ".py"));
      out.push(assistant("读 services/hx-browser/src/x" + i + ".py 和 vendor/genspark2api/a" + i + ".json"));
      out.push(tool("Error: 失败 ECONNREFUSED 7890 端口未监听 /tmp/batch" + i + ".log"));
      out.push(assistant("已修改 deepseek-ai/dsh-ptc-runtime-node/lib/p" + i + ".js"));
    }
    return out;
  };

  // 2026-11-03 二修改断言 (不是删): 这两条原先断言 "yes/next → confidence ≤ 0.2, action 未知"。
  // 那是把 confidence 当成「这句话有多少信息」; 新语义是「对当前任务判断有多确定」。
  // 这段历史最后一个用户轮是明确任务 ("新增一个接口, 改 .../m19.py"), 且其后的报错已被 "已修改" 闭合,
  // 所以续接短句的当前任务是确定的 → confidence 高, action 取上一任务。仍保留原意: 动作**不来自当前轮**。
  it("回归: 80 条历史 + 当前轮 yes → 续接上一明确任务, confidence 高, 动作来自历史而非当前轮", () => {
    const s = computeTaskState({ cwd: CWD, messages: [...noisyHistory(80), user("yes")] });
    expect(s.continuing).toBe(true);
    expect(s.confidence).toBeGreaterThanOrEqual(0.8);
    expect(s.action).toBe("新增");
    expect(s.previousAction).toBe("新增");
    expect(s.previousFiles[0]).toBe("workspaces/browser-auto/app/m19.py");
    expect(s.blockedOn).toBeNull();
    expect(s.evidence.fromCurrentTurn).not.toContain("action");
    expect(s.evidence.fromHistory).toContain("action(续接上一任务)");
  });

  it("回归: 80 条历史 + 当前轮 next → 同上 (goal 说清继续的是哪件事)", () => {
    const s = computeTaskState({ cwd: CWD, messages: [...noisyHistory(80), user("next")] });
    expect(s.confidence).toBeGreaterThanOrEqual(0.8);
    expect(s.previousAction).toBe("新增");
    expect(s.goal).toContain("继续上一任务");
    expect(s.goal).toContain("m19.py");
  });

  it("next + 历史空白 → confidence 低 (0.1), 没有可继续的任务", () => {
    const s = computeTaskState({ cwd: CWD, messages: [user("next")] });
    expect(s.continuing).toBe(true);
    expect(s.confidence).toBe(0.1);
    expect(s.previousAction).toBeNull();
    expect(s.previousFiles).toEqual([]);
    expect(s.goal).toBe("");
  });

  it("confidence 不由当前轮字数决定: 同样是 next, 历史明确 vs 历史空白差别巨大", () => {
    const withTask = computeTaskState({ cwd: CWD, messages: [user("改一下 src/trigger/policy.ts 的短路顺序"), assistant("好"), user("next")] });
    const blank = computeTaskState({ cwd: CWD, messages: [user("next")] });
    expect(withTask.confidence).toBe(0.8);
    expect(blank.confidence).toBe(0.1);
    // 历史里只有动作没有文件 → 中等 (0.6), 仍高于 "历史空白"
    expect(computeTaskState({ cwd: CWD, messages: [user("帮我修一下代理"), user("继续")] }).confidence).toBe(0.6);
  });

  it("blockedOn: 上一任务之后报了错且没有修复迹象 → 给出卡点; 有修复迹象 → null", () => {
    const base = [user("改一下 src/storage/file-store.ts 的写入逻辑"), assistant("跑测试"), tool("Error: ENOENT no such file /tmp/x.json")];
    const open = computeTaskState({ cwd: CWD, messages: [...base, user("继续")] });
    expect(open.previousAction).toBe("修改");
    expect(open.previousFiles[0]).toBe("src/storage/file-store.ts");
    expect(open.blockedOn).toContain("ENOENT");
    expect(open.goal).toContain("卡在");
    const closed = computeTaskState({ cwd: CWD, messages: [...base, assistant("已修复, 测试通过"), user("继续")] });
    expect(closed.blockedOn).toBeNull();
  });

  it("回归: 历史里有报错, 最近 3 轮没有 → error 为 null", () => {
    const s = computeTaskState({
      cwd: CWD,
      messages: [
        ...noisyHistory(40),
        user("看一下面板布局"), assistant("好"), tool("ok 200"),
        user("再调一下间距"), assistant("好"), tool("done"),
        user("你帮我修一下代理吧, 让他自己能控制这个数据面"),
      ],
    });
    expect(s.error).toBeNull();
    expect(s.errorKeyword).toBeNull();
    expect(s.goal).not.toContain("报错");
  });

  it("回归: 当前轮有动作词有路径, 历史全是噪声 → confidence ≥ 0.8, 当前轮文件排第一", () => {
    const s = computeTaskState({ cwd: CWD, messages: [...noisyHistory(80), user("改一下 src/trigger/policy.ts 的阈值")] });
    expect(s.confidence).toBeGreaterThanOrEqual(0.8);
    expect(s.action).toBe("修改");
    expect(s.files[0]).toBe("src/trigger/policy.ts");
    expect(s.evidence.fromCurrentTurn).toEqual(expect.arrayContaining(["action", "files"]));
    expect(s.evidence.fromHistory).toContain("files");
  });

  // 2026-11-03 二修改断言: 原第三行是 "噪声历史 + 嗯 → 0.1"。「嗯」是续接短句, 历史里有明确任务时按新语义该是高的
  // (上面的回归已覆盖); 这里改成 "历史空白 + 嗯 → 0.1", 保住 "短句且无从判断时低" 这一档的原意。
  it("confidence 档位: 有动作无路径 → 0.4; 长句无动作无路径 → 0.2; 无历史的短句 → 0.1", () => {
    expect(computeTaskState({ cwd: CWD, messages: [...noisyHistory(20), user("帮我修一下代理")] }).confidence).toBe(0.4);
    expect(computeTaskState({ cwd: CWD, messages: [...noisyHistory(20), user("这个数据面现在到底是谁在维护的呢")] }).confidence).toBe(0.2);
    expect(computeTaskState({ cwd: CWD, messages: [user("嗯")] }).confidence).toBe(0.1);
  });

  it("files 按轮次衰减加权: 20 轮前出现 4 次 (0.8) 排在最近出现 1 次 (1.0) 之后", () => {
    const old = [user("看 src/old/a.ts src/old/a.ts src/old/a.ts src/old/a.ts")];
    for (let i = 0; i < 22; i++) old.push(user("好的继续往下走吧谢谢你"));
    const s = computeTaskState({ cwd: CWD, messages: [...old, user("看 src/new/b.ts")] });
    expect(s.files).toEqual(["src/new/b.ts", "src/old/a.ts"]);
  });
});
