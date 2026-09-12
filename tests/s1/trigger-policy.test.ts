// tests/s1/trigger-policy.test.ts — 触发层契约: "AI 没意识到要查时, 记忆也必须生效"。
//
// 这是本项目最核心的可靠性问题: 模型无法可靠地知道自己不知道什么。
// 因此断言分三类:
//   1. always-on 保底 (与任何判定无关);
//   2. 意图门控 (识别"回忆型提问"的形状, 不依赖项目是否声明过绑定);
//   3. 预算与去重 (该省的省, 该重查的重查), 且每次决策都给出可审计 reason。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTENTS,
  TriggerPolicy,
  detectIntent,
  selectAlwaysOn,
  topicDriftOf,
} from "../../src/trigger/policy.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };
const entry = (over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry => ({
  kind: "lesson",
  source: "t",
  scope: "agent",
  ts: T,
  status: "active",
  ...over,
});

describe("话题漂移 (阈值由实测标定, 断言性质而非魔数)", () => {
  const policy = new TriggerPolicy();
  // 阈值与 policy 的默认值保持一致 (实现改了默认值, 测试必须跟着变 —— 不要在这里另抄一份)。
  const threshold = 0.9;

  it("同话题 (含改述与短追问) 落在阈值内, 换话题落在阈值外", () => {
    const sameTopic = [
      topicDriftOf("容器并发上限怎么设", "容器并发上限设多少合适"),
      topicDriftOf("日志采样率提高到 10% 方便排查", "那日志采样这块我们一般怎么配"),
    ];
    const switched = [
      topicDriftOf("容器并发上限怎么设", "前端按钮圆角改成 8px"),
      topicDriftOf("数据库连接池超时怎么配", "帮我写个单元测试"),
    ];
    for (const drift of sameTopic) expect(drift, "同话题").toBeLessThan(threshold);
    for (const drift of switched) expect(drift, "换话题").toBeGreaterThanOrEqual(threshold);
  });

  it("短追问不会因为自身短而被误判成换话题 (重叠系数 vs Jaccard 的关键差异)", () => {
    // "那这个下限呢" 很短但与"容器并发上限怎么设"共享 上限/限 等字面。
    const drift = topicDriftOf("那这个下限呢", "容器并发上限怎么设");
    expect(drift).toBeLessThanOrEqual(threshold);
  });

  it("无历史视为话题切换 (首次必然注入)", () => {
    expect(topicDriftOf("任意内容", undefined)).toBe(1);
    expect(policy.decide({ text: "我们上次怎么做", hasAlwaysOn: true }).topicDrift).toBe(1);
  });
});

describe("意图识别 (匹配提问的形状, 不是知识内容)", () => {
  it("命中各类回忆型提问", () => {
    for (const text of [
      "我们当时为什么选 pnpm 而不是 npm？",
      "上次这个并发问题是怎么解决的",
      "我们这边一般怎么写日志？",
      "这个库以前踩过什么坑吗",
      "这个项目的背景是什么",
      "我们之前有没有做过类似的鉴权？",
    ]) {
      expect(detectIntent(text), text).not.toBeNull();
    }
  });

  it("普通任务指令不误判 (避免每轮都注入)", () => {
    for (const text of [
      "把这个函数重命名为 parseConfig",
      "帮我写个单元测试",
      "这段代码有语法错误",
      "生成一个 8x8 的表格",
    ]) {
      expect(detectIntent(text), text).toBeNull();
    }
  });

  it("英文提问同样命中", () => {
    expect(detectIntent("why did we choose pnpm over npm?")).not.toBeNull();
    expect(detectIntent("where were we on this?")).not.toBeNull();
    expect(detectIntent("rename this function")).toBeNull();
  });

  it("话题词必须与提问形状同现: 陈述句里的裸词不算提问", () => {
    // 真实误报 (来自本仓库会话语料): 列举规格时出现"规范"二字, 却既不是提问也不关于约定。
    expect(
      detectIntent("HXLoLi支持的专用md格式/文风/目录命名规范/HXLoLiTag(汇总而不是每次都编)"),
    ).toBeNull();
    // 同一个词进了问句才是真信号 —— 两层判定的分界就在这里。
    expect(detectIntent("这个项目的命名规范是什么")).not.toBeNull();
    // 祈使式的风险提醒是信号 (用户在提醒别踩坑), 不需要问号。
    expect(detectIntent("注意避免并发超时")).not.toBeNull();
  });

  it("置信度反映证据强度, 不再钉死在下限", () => {
    const one = detectIntent("上次这个并发问题是怎么解决的");
    expect(one?.confidence).toBeCloseTo(0.5, 10);
    // 两条独立模式命中 → 更高; 断言单调而不是断言某个具体数字。
    const two = detectIntent("我们当初为什么选 pnpm");
    expect(two!.confidence).toBeGreaterThan(one!.confidence);
    // 上限仍然 <= 1 (再多命中也不会溢出)。
    expect(one!.confidence).toBeLessThanOrEqual(1);
    expect(two!.confidence).toBeLessThanOrEqual(1);
  });

  it("话题词与提问形状必须同分句: 分处两句不算 (同现 != 相关)", () => {
    // 真实误报 (300 字的长消息): 话题词"规范"在列举规格的句子里, 形状词"如何"在另一句,
    // 整段"同现"曾让它误判为"在问约定"。同分句门槛是能廉价消除它的一步。
    const long =
      "HXLoLi支持的专用md格式/文风/目录命名规范。\n重点关注两个问题，如何开始训练，以及如何评估。";
    expect(detectIntent(long)).toBeNull();
    // 两者落在同一句时仍然是命中 (门槛收紧不能把真信号一起收掉)。
    expect(detectIntent("目录命名规范是什么")).not.toBeNull();
  });

  it("'之前…过…吗' 这类口语回忆形状不再漏掉", () => {
    // 修复前: prior-art 要求显式"有没有/是否/曾经", 于是这句整条漏掉 (实测确认)。
    expect(detectIntent("我们之前遇到过幂等问题吗")).not.toBeNull();
  });
});

describe("触发决策: 四通道", () => {
  const policy = new TriggerPolicy();

  it("通道 1 always-on: 即使完全没命中意图也注入 (模型没意识时的唯一保证)", () => {
    const decision = policy.decide({ text: "把这个函数重命名为 parseConfig", hasAlwaysOn: true });
    expect(decision.inject).toBe(true);
    expect(decision.mode).toBe("always-on");
    expect(decision.budgetTokens).toBeGreaterThan(0);
    expect(decision.reason).toContain("always-on");
  });

  it("通道 2 intent: 没有 always-on 内容时, 回忆型提问仍然触发", () => {
    const decision = policy.decide({ text: "我们当时为什么选 pnpm？", hasAlwaysOn: false });
    expect(decision.inject).toBe(true);
    expect(decision.mode).toBe("intent");
    expect(decision.intent).not.toBeNull();
    expect(decision.reason).toContain("回忆意图");
  });

  it("无信号时不注入 (不为注入而注入)", () => {
    const decision = policy.decide({ text: "把这段代码格式化一下", hasAlwaysOn: false });
    expect(decision.inject).toBe(false);
    expect(decision.mode).toBe("skip-no-signal");
    expect(decision.budgetTokens).toBe(0);
  });

  it("通道 3 drift-refresh: 换了话题就强制重查 (旧注入已失效)", () => {
    const decision = policy.decide({
      text: "前端按钮圆角改成 8px",
      hasAlwaysOn: false,
      previousQuery: "容器并发上限怎么设",
      lastInjectedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(decision.inject).toBe(true);
    expect(decision.mode).toBe("drift-refresh");
  });

  it("去重: always-on 在同一话题的连续追问里不重复灌", () => {
    const decision = policy.decide({
      text: "容器并发上限怎么设",
      hasAlwaysOn: true,
      previousQuery: "容器并发上限设多少合适",
      lastInjectedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(decision.inject).toBe(false);
    expect(decision.mode).toBe("skip-similar");
    expect(decision.reason).toContain("跳过重复注入");
  });

  it("每次决策都带可审计字段 (why 不能缺失)", () => {
    const decision = policy.decide({ text: "我们上次怎么做的", hasAlwaysOn: true });
    expect(decision.reason.length).toBeGreaterThan(5);
    expect(decision.topicDrift).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(["always-on", "intent", "drift-refresh", "skip-similar", "skip-no-signal"]).toContain(
      decision.mode,
    );
  });

  it("意图库可扩展, 且 isRecallShaped 与决策同口径", () => {
    const custom = new TriggerPolicy({
      intents: [{ id: "custom", label: "自定义", patterns: [/DEPLOY-/] }],
    });
    expect(custom.isRecallShaped("DEPLOY-42 是什么")).toBe(true);
    expect(custom.decide({ text: "DEPLOY-42 是什么", hasAlwaysOn: false }).inject).toBe(true);
    expect(DEFAULT_INTENTS.length).toBeGreaterThanOrEqual(6);
  });
});

describe("always-on 内容选择 (保底但受预算约束)", () => {
  const estimate = (text: string) => text.length;

  it("已确认规则优先, 未确认规则排除 (治理铁律)", () => {
    const entries = [
      entry({
        id: "r1",
        kind: "rule",
        scope: "global",
        content: "涉及容器并发时先检查并发策略",
        confirmedBy: "hx",
        confirmedAt: T.assertedAt,
      }),
      entry({ id: "r2", kind: "rule", scope: "global", content: "未确认的规则不该被注入" }),
      entry({ id: "f1", kind: "fact", content: "本项目用 pnpm" }),
    ];
    const picked = selectAlwaysOn(entries, { project: "api", budgetTokens: 1000, estimate });
    expect(picked.map((e) => e.id)).toContain("r1");
    expect(picked.map((e) => e.id)).not.toContain("r2");
  });

  it("预算耗尽时截断, 且规则排在事实之前", () => {
    const entries = [
      entry({ id: "f1", kind: "fact", content: "x".repeat(200) }),
      entry({
        id: "r1",
        kind: "rule",
        scope: "global",
        content: "短规则",
        confirmedBy: "hx",
        confirmedAt: T.assertedAt,
      }),
    ];
    const picked = selectAlwaysOn(entries, { project: "api", budgetTokens: 30, estimate });
    expect(picked.map((e) => e.id)).toEqual(["r1"]);
  });

  it("只收项目内的关键事实, 不收 lesson (lesson 走意图通道按需召回)", () => {
    const entries = [
      entry({ id: "l1", kind: "lesson", content: "某次踩坑细节" }),
      entry({
        id: "d1",
        kind: "decision",
        project: "api",
        scope: "project",
        content: "决定用 SQLite",
      }),
      entry({
        id: "d2",
        kind: "decision",
        project: "web",
        scope: "project",
        content: "别的项目的决策",
      }),
    ];
    const picked = selectAlwaysOn(entries, { project: "api", budgetTokens: 1000, estimate });
    expect(picked.map((e) => e.id)).toEqual(["d1"]);
  });
});
