// tests/s2/extract-tags-numbering.test.ts — 正文兜底抽标签**不能把编号引用当标签**。
//
// 为什么需要它 (2026-09-18, §520 追到根因): `extractTags` 在 `tags` 字段缺失时兜底,
// 旧实现只做 `/#(\w+)/` 匹配 —— 而**中文技术写作里 \`#1\`/\`#412\`/\`#9被挡\` 这类编号引用极常见**。
// 实测真库 14 个 \`#\` 片段里 **6 个是纯数字编号**, 另有两个是哨兵与内部 id。
//
// 危害不是"元数据脏": 那些 tag 会进 \`tags\` 表, 而 \`neighbors.ts\` 用 tag
// **扩大演化裁决的候选面** —— 标签错了会改变"与谁比较"。
//
// ⚠ 判据只拦**有明确形态证据**的形态 (与 \`parseTags\` 的 \`isTagString\` 同一口径);
// 本文件下半部分专门钉住"**必须保留什么**", 因为过严的判据会丢掉真信息。
import { describe, expect, it } from "vitest";
import { extractTags } from "../../src/storage/entry-normalize.ts";

describe("extractTags: 编号引用不是标签", () => {
  it("**纯数字与数字开头的一律不抽** (真库实测 6 个纯数字编号)", () => {
    expect(extractTags("参考 #412 那一节")).toEqual([]);
    expect(extractTags("第 #9被挡 条规则")).toEqual([]);
    expect(extractTags("#1~#7 cost 29/34/55")).toEqual([]);
  });

  it("**判据只拦'纯数字'与'短的数字+中文编号'** —— 不能笼统拦'数字开头'", () => {
    // ⚠ 这是我第二版判据踩的坑: 我先把 `^\d` 全拦了, 而真库的 tags 字段里有 `"401回归"` 这种
    // **真标签** (讲 401 回归测试)。核实后发现它在**tags 字段**里而不走 extractTags,
    // 所以两者不冲突 —— 但判据仍应尽量窄: 只拦有编号形态证据的。
    expect(extractTags("#3a 这个子项")).toEqual(["3a"]);   // 短字母后缀: 不像编号, 保留
    expect(extractTags("#9被挡")).toEqual([]);              // 数字+中文短编号: 拦
  });

  it("**哨兵与内部 id 不抽**", () => {
    expect(extractTags("#undefined 是字符串化的")).toEqual([]);
    expect(extractTags("#r376080139 是规则 id")).toEqual([]);
    expect(extractTags("#null 同理")).toEqual([]);
  });

  it("**但真标签必须保留** —— 判据不能笼统砍", () => {
    // 这几条是从真库 14 个 # 片段里挑出的"看着像真标签"的
    expect(extractTags("见 #ppt 里的方案")).toEqual(["ppt"]);
    expect(extractTags("颜色 #ff88ff 的边框")).toEqual(["ff88ff"]);
    expect(extractTags("#HX-Sagasu 项目")).toEqual(["HX-Sagasu"]);
    expect(extractTags("#中文标签 可以")).toEqual(["中文标签"]);
  });

  it("多个标签按出现顺序返回, 且不去重 (那是索引侧的事)", () => {
    // ⚠ 用**多字母**标签 —— 单字母在 §541 之后被拦 (真库验收脚本抓到 `#N`/`#i` 这类占位符
    // 被抽成标签; 而**正文兜底抽取**里单字母更像引用符号, 所以这里拦、parseTags 里刻意不拦)。
    expect(extractTags("#alpha 与 #beta 与 #alpha")).toEqual(["alpha", "beta", "alpha"]);
  });

  it("**占位符与单字母不抽** (§541 真库验收抓到的盲区)", () => {
    // 我在记录"编号引用被误抽"这个缺陷时, 正文里用了 `#N`/`#xxx` 指代"任意标签" —— 它们被抽了出来。
    expect(extractTags("用 #N 表示任意标签")).toEqual([]);
    expect(extractTags("#xxx 是占位")).toEqual([]);
    expect(extractTags("#i 是单字母")).toEqual([]);
    expect(extractTags("#tag 是通用词")).toEqual([]);
    // 而**中文单字**不受影响 (它不是 ASCII 单字母):
    expect(extractTags("#锁 是标签")).toEqual(["锁"]);
  });

  it("无 # 时返回空数组", () => {
    expect(extractTags("普通段落, 没有井号")).toEqual([]);
  });
});
