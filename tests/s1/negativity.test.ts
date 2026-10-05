// tests/s1/negativity.test.ts — 负面/纠正信号判定的契约 (纯逻辑, 无 IO)。
//
// 为什么有它 (2026-10-05, 用户实测): 真库里躺着 27 条自动沉淀的**辱骂原话**
// ("操你妈" / "你傻逼吧，停" / "继续的操你妈别再让我重启了"), 而真正该记的**纠正句**
// 反而 8/10 被丢。旧行为是双向错的, 本文件把修法钉死:
//   ① 骂人**要**留痕, 但不能把原话写进库 (落教训草稿);
//   ② 纠正句要能识别出来 (旧代码 10 条丢 8 条);
//   ③ 泛化脏话 (骂代码不骂 agent) 不许误命中。
import { describe, expect, it } from "vitest";
import {
  compileNegativity,
  DEFAULT_NEGATIVE_WORDS,
  detectNegative,
  directionOf,
  lessonDraftOf,
  mergeNegativityWords,
  parseNegativityWords,
  type NegativeKind,
} from "../../src/kernel/negativity.ts";

const compiled = compileNegativity();

describe("detectNegative: 三个类别分得开", () => {
  it("'你傻逼' / '你真蠢驴' → blame-method (针对做法)", () => {
    for (const t of ["你傻逼", "你真蠢驴", "你这写的什么狗屁玩意", "你是不是脑残"]) {
      const s = detectNegative(t, compiled);
      expect(s.hit, t).toBe(true);
      expect(s.kinds, t).toContain("blame-method");
    }
  });

  it("'操你妈' / '你他妈' → blame-execution (针对执行过程)", () => {
    for (const t of ["操你妈", "你他妈又错了", "我操你妈的 我们的注册已经实现了协议化了"]) {
      const s = detectNegative(t, compiled);
      expect(s.hit, t).toBe(true);
      expect(s.kinds, t).toContain("blame-execution");
    }
  });

  it("纠正句 → correction (旧代码在这里丢了 8/10 条)", () => {
    for (const t of [
      "错了！我说的是先跑测试再改代码",
      "你搞错了, 应该是先跑测试再改代码",
      "不是这样, 要先用 sqlite 存",
      "你理解错了, 我的意思是本地优先",
      "A 错了, 正确的是 B",
    ]) {
      const s = detectNegative(t, compiled);
      expect(s.hit, t).toBe(true);
      expect(s.kinds, t).toContain("correction");
    }
  });

  it("同时含辱骂与纠正 → 两类都在 (level=3 只是日志用的副产物)", () => {
    const s = detectNegative("你他妈又搞错了, 这已经是第三次了", compiled);
    expect(s.kinds).toContain("blame-execution");
    expect(s.kinds).toContain("correction");
    expect(s.level).toBe(3);
  });

  it("**不误命中**: 骂代码不等于骂 agent; 正常提问/陈述一律不命中", () => {
    for (const t of [
      "这个 bug 真操蛋", // 骂的是代码, 不是 agent 的行为
      "今天天气不错",
      "我先看看代码",
      "这个方案能不能行? 我们试试",
      "帮我改一下 gh-pool 的队列",
      "继续",
    ]) {
      expect(detectNegative(t, compiled).hit, t).toBe(false);
    }
  });

  it("语音错字归一后仍能命中 (沙比/傻B)", () => {
    for (const t of ["你真沙比", "傻B一个"]) {
      expect(detectNegative(t, compiled).hit, t).toBe(true);
    }
  });
});

describe("level: 只是排序与日志用的副产物, **不是门槛**", () => {
  it("单一类别 = 1; 两类或重复 = 2; 辱骂+纠正 = 3", () => {
    expect(detectNegative("你傻逼", compiled).level).toBe(1);
    expect(detectNegative("你真蠢驴还有病", compiled).level).toBeGreaterThanOrEqual(2);
    expect(detectNegative("你他妈又搞错了", compiled).level).toBe(3);
  });

  it("命中即处置: level=1 与 level=3 都产生非空教训草稿", () => {
    for (const t of ["你傻逼", "你他妈又搞错了"]) {
      const s = detectNegative(t, compiled);
      expect(s.hit).toBe(true);
      expect(lessonDraftOf(s, t, compiled).length).toBeGreaterThan(0);
    }
  });
});

describe("directionOf / lessonDraftOf: 抽方向, 抽不出就说抽不出", () => {
  it("纠正句抽出方向 (而不是把骂话换个包装又进库)", () => {
    expect(directionOf("错了！我说的是先跑测试再改代码", compiled)).toBe("先跑测试再改代码");
    expect(directionOf("你理解错了, 我的意思是本地优先", compiled)).toBe("本地优先");
    expect(directionOf("以后都要先跑测试再改代码", compiled)).toContain("先跑测试再改代码");
  });

  it("**抽不出方向时返回空串, 不许拿骂话当方向**", () => {
    // "别这么傻逼" 抽出来的"方向"本身就是骂 —— 它不算方向。
    expect(directionOf("你能不能别这么傻逼", compiled)).toBe("");
    const draft = lessonDraftOf(detectNegative("你傻逼", compiled), "你傻逼", compiled);
    expect(draft).not.toContain("傻逼"); // ★ 教训草稿里不许残留脏话
    // ★ 措辞必须是**我能执行的约束**, 不是"用户什么情绪"(2026-10-05 用户否决了第一版)。
    expect(draft.startsWith("禁止")).toBe(true);
    expect(draft).toContain("改为");
  });

  it("**记忆里不许出现「描述用户」的措辞** (读者是下一轮的我, 不是旁观者)", () => {
    // 第一版产出 "用户对做法/方案不满 (本轮未获认可), 需回看…" —— 用户原话"这样子记有个屁用"。
    // 病根是主语搞反: 我需要的不是"用户当时什么情绪", 而是"我以后不许这么干"。
    for (const t of [
      "你傻逼", "操你妈", "你他妈又搞错了", "不是这样, 要先用 sqlite 存",
      "错了！我说的是先跑测试再改代码", "不要每次都重启服务",
    ]) {
      const draft = lessonDraftOf(detectNegative(t, compiled), t, compiled);
      for (const banned of ["用户", "不满", "生气", "发脾气", "情绪", "未获认可", "需回看"]) {
        expect(draft.includes(banned), `${t} -> ${draft}`).toBe(false);
      }
      // 必须是可执行的形态
      expect(/^(禁止|必须)/.test(draft), `${t} -> ${draft}`).toBe(true);
    }
  });

  it("禁令式方向 → `禁止X。`; 正面要求 → `必须Y。`", () => {
    // 方案/执行被否 → 走**行为禁令**退路 (刹车 + 方向盘)
    expect(lessonDraftOf(detectNegative("你傻逼", compiled), "你傻逼", compiled)).toContain("禁止");
    expect(lessonDraftOf(detectNegative("操你妈", compiled), "操你妈", compiled)).toContain("禁止");
    // 有具体正向要求 → "必须"
    expect(lessonDraftOf(detectNegative("错了！我说的是先跑测试再改代码", compiled), "错了！我说的是先跑测试再改代码", compiled)).toBe("必须先跑测试再改代码。");
    // 用户下达的禁令 → 剥成"禁止X"(去掉否定词)
    expect(lessonDraftOf(detectNegative("不要每次都重启服务", compiled), "不要每次都重启服务", compiled)).toBe("禁止每次都重启服务。");
  });

  it("落库正文里永不出现用户的脏话原文 (三类各验一次)", () => {
    for (const t of ["你傻逼", "操你妈", "你他妈又搞错了, 再这样我就换人了"]) {
      const draft = lessonDraftOf(detectNegative(t, compiled), t, compiled);
      for (const bad of ["傻逼", "操你", "他妈"]) {
        expect(draft.includes(bad), `${t} -> ${draft}`).toBe(false);
      }
    }
  });
});

describe("词表可配置 (用户要求: '直接给个地方让用户配置')", () => {
  it("解析类别头 + 条目", () => {
    const r = parseNegativityWords("blame-method:\n狗屎\n烂活");
    expect(r.error).toBeUndefined();
    expect(r.words["blame-method"]).toEqual(["狗屎", "烂活"]);
  });

  it("类别头同行可带条目 (逗号分隔)", () => {
    const r = parseNegativityWords("correction: 错了, 不对\nblame-execution:\n滚");
    expect(r.words.correction).toEqual(["错了", "不对"]);
    expect(r.words["blame-execution"]).toEqual(["滚"]);
  });

  it("空行与 # 注释被忽略", () => {
    const r = parseNegativityWords("# 我的词表\n\nblame-method:\n# 这条是注释\n狗屎\n");
    expect(r.words["blame-method"]).toEqual(["狗屎"]);
  });

  it("**没有类别头时报格式错误** (而不是猜类别)", () => {
    const r = parseNegativityWords("狗屎\n烂活");
    expect(r.error).toContain("缺少类别头");
  });

  it("用户配的类别**替换**缺省 (没配的类别保留缺省)", () => {
    const parsed = parseNegativityWords("blame-method:\n狗屎").words;
    const merged = mergeNegativityWords(parsed);
    expect(merged["blame-method"]).toEqual(["狗屎"]);
    // 没配的类别仍是缺省 (不会因为配了一类就把其余清空)
    expect(merged["blame-execution"]).toEqual(DEFAULT_NEGATIVE_WORDS["blame-execution"]);
  });

  it("用户自定义词真的生效 (含正则写法)", () => {
    const words = { ...DEFAULT_NEGATIVE_WORDS, "blame-method": ["狗屎", "/烂\\s*活/"] } as Record<
      NegativeKind,
      readonly (string | RegExp)[]
    >;
    const c = compileNegativity(words);
    expect(detectNegative("你这狗屎方案", c).hit).toBe(true);
    expect(detectNegative("纯纯烂 活", c).hit).toBe(true);
  });

  it("坏正则**跳过并记录**, 不让整份词表失效", () => {
    const c = compileNegativity({
      "blame-method": ["/[unclosed/", "狗屎"],
    } as never);
    expect(c.invalid).toContain("/[unclosed/");
    expect(detectNegative("你这狗屎方案", c).hit).toBe(true); // 其余条目照常工作
  });
});

describe("紧凑单行写法 (面板里普通输入框也能配)", () => {
  it("`类别:词1,词2;类别:词3` 解析成功", () => {
    const r = parseNegativityWords("blame-method:狗屎,烂活;correction:错了,不对");
    expect(r.error).toBeUndefined();
    expect(r.words["blame-method"]).toEqual(["狗屎", "烂活"]);
    expect(r.words.correction).toEqual(["错了", "不对"]);
  });

  it("单行写法真的生效", () => {
    const parsed = parseNegativityWords("blame-method:/烂\\s*活/,狗屎").words;
    const c = compileNegativity(mergeNegativityWords(parsed));
    expect(detectNegative("纯纯烂 活", c).hit).toBe(true);
    expect(detectNegative("你这狗屎方案", c).hit).toBe(true);
  });

  it("多行写法仍然有效 (两种写法共存, 服务不同的输入控件)", () => {
    const r = parseNegativityWords("blame-method:\n狗屎\n烂活");
    expect(r.words["blame-method"]).toEqual(["狗屎", "烂活"]);
  });
});
