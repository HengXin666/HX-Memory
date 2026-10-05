// tests/s2/injection-format-single-source.test.ts — 行格式的**单一事实源**与两条出口的判据。
//
// ## 历史 (2026-09-18, §632 实测缺陷)
//
// 库里有**两套**注入行格式并存:
//   · `kernel/injection-format.ts` 的 `formatEntryLine`: 可被 `parseInjectedIds` 解析;
//   · `app/format.ts` 的 `formatRetrieval`:   `- [规则] [x] 正文` (行首裸 id, **无可解析标记**)。
// 后果: 后者产出的块**不被认定为已注入** ⇒ `injectMode: first` 的判据落空。
// 全库历史实测: **2556 处旧格式 / 68 个会话** 命中过这条路径。
//
// ## 2026-09-29: 判据从"两处格式相同"改成"两条出口各自正确"
//
// 现在注入块与检索结果**刻意不同** (见 `formatEntryLine` / `formatHitLine` 的说明):
//   · **被动注入** (`formatEntryLine`): 无 id —— id 走消息 `source.entryIds`, 省 88 token/块;
//   · **主动检索** (`formatRetrieval` → `formatHitLine`): **带 id** —— `memory_flag` 按 id 操作。
//
// 因此原来的"两处行格式逐字一致"断言不再成立 (它锁的是一个已废弃的形态)。本文件改为锁
// **两条出口各自的判据**, 并保留那条负例 (证明解析器能区分"看起来像 id"与"可解析的标记")。
import { describe, expect, it } from "vitest";
import { formatRetrieval } from "../../src/app/format.ts";
import { formatEntryLine, formatHitLine, parseInjectedIds, entryIdsOfSource } from "../../src/kernel/injection-format.ts";

const hits = [
  { entry: { id: "r00155cdb954e41c7", kind: "rule", content: "记忆触发须设无条件保底注入通道" } },
  { entry: { id: "m28231ec90a2340b1", kind: "decision", content: "某条决策" } },
] as never;

describe("检索结果出口 (formatRetrieval): 必须带 id, 供 memory_flag 按 id 操作", () => {
  it("每条命中都带自己的 id (模型据此引用/标注)", () => {
    const out = formatRetrieval(hits, "相关记忆");
    expect(out).toContain("[r00155cdb954e41c7]");
    expect(out).toContain("[m28231ec90a2340b1]");
  });

  it("kind 标记由同一函数加, 不手拼 (旧实现会产出 '[规则] [rule] ...' 双重标记)", () => {
    const out = formatRetrieval([hits[0]], "相关记忆");
    expect(out).not.toContain("[规则]");
    expect(out).toContain("- [rule] [r00155cdb954e41c7]");
  });

  it("空命中返回空串 (= 不注入), 而不是一个空标题块", () => {
    expect(formatRetrieval([], "相关记忆")).toBe("");
  });
});

describe("被动注入出口 (formatEntryLine): 正文不带 id, id 走消息 source", () => {
  it("产出的行只有 kind + 内容", () => {
    expect(formatEntryLine("r00155cdb954e41c7", "记忆触发须设无条件保底注入通道", "rule")).toBe(
      "- [rule] 记忆触发须设无条件保底注入通道",
    );
  });

  it("不带任何可解析标记 (省 token 的前提: 正文里真的没有)", () => {
    const line = formatEntryLine("r00155cdb954e41c7", "内容", "rule");
    expect(parseInjectedIds(line)).toEqual([]);
    expect(line).not.toContain("hx-memory:id=");
  });

  it("同一条 id 改走 source.entryIds, 两处取值一致 (写入侧与读取侧同源)", () => {
    const id = "r00155cdb954e41c7";
    const line = formatEntryLine(id, "内容", "rule");
    // 写入侧的形态: 正文一条 + source 一条。
    expect(parseInjectedIds(line)).toEqual([]);
    expect(entryIdsOfSource({ entryIds: [id] })).toEqual([id]);
  });
});

describe("两条出口的形态差异是**刻意**的, 且不能反向漂移", () => {
  it("formatHitLine 与 formatEntryLine 只差那段 id, 其余逐字一致", () => {
    const inject = formatEntryLine("x1", "同一段内容", "rule");
    const hit = formatHitLine("x1", "同一段内容", "rule");
    expect(inject).toBe("- [rule] 同一段内容");
    // 命中行 = 注入行在 kind 之后插入 `[id] ` —— 差别只有这一处。
    expect(hit).toBe("- [rule] [x1] 同一段内容");
    expect(hit.replace("[x1] ", "")).toBe(inject);
  });

  it("### 负例: 行首裸 id 的旧格式解析不出 id —— 那是这个缺陷的形态", () => {
    // 刻意构造修复前的形态, 证明判据能区分"看起来像 id"与"可解析的标记"。
    const legacy = "【相关记忆】\n- [规则] [r00155cdb954e41c7] 记忆触发须设无条件保底注入通道";
    expect(parseInjectedIds(legacy)).toEqual([]);
  });
});
