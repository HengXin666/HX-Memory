// tests/s1/entity.test.ts — S1: 实体抽取与规范化键 (纯函数)。
//
// 这组断言钉住的是**实测标定出来的口径**, 不是审美:
//   - 上限 8 会让 104 条 entity_only case 里有 35 条的桥断掉 (覆盖 69/104); 12 → 103/104;
//     16 → 104/104 且此后不再增长 —— 所以默认是 16, 而不是"越小越干净";
//   - 驼峰识别必须允许**前导大写串** (HXLoLi): 写成"首字母大写+后续小写"会漏掉它,
//     实测那一条命名就让 19 条 case 的桥断掉;
//   - 按 pattern 依次取满会把名额全给"xxx.ts"形状, 全大写缩写 (DSH/MCP) 永远轮不到。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENTITY_LIMIT,
  entitiesOf,
  entityKey,
  entityKeysOf,
  extractEntities,
} from "../../src/kernel/entity.ts";

describe("实体键规范化", () => {
  it("大小写/全半角/首尾标点归一, 但保留内部大小写语义", () => {
    expect(entityKey("HX-Memory")).toBe("hx-memory");
    expect(entityKey("  HX-Memory  ")).toBe("hx-memory");
    expect(entityKey("（FTS5）")).toBe("fts5");
    expect(entityKey("")).toBe("");
    expect(entityKey("!!!")).toBe("");
  });

  it("同一实体的两种写法得到同一个键 (否则反查会静默漏掉一半)", () => {
    expect(entityKey("prestep.ts")).toBe(entityKey("Prestep.TS"));
    expect(entityKey("ＦＴＳ５")).toBe(entityKey("FTS5"));
  });
});

describe("确定性实体抽取", () => {
  it("抽出标识符形状的专名 (文件/库/缩写/驼峰)", () => {
    const out = extractEntities("prestep.ts 走 FTS5, 由 MemoryFacade 组装, 依赖 DSH");
    for (const want of ["prestep.ts", "FTS5", "MemoryFacade", "DSH"]) {
      expect(out).toContain(want);
    }
  });

  it("**前导大写串 + 驼峰** 必须能抽到 (HXLoLi 是实测命中的形状)", () => {
    expect(extractEntities("HXLoLi 是宿主仓库, HX-Memory 是它的一部分")).toContain("HXLoLi");
  });

  it("不抽泛指词与整句话: 实体错连比没有更糟", () => {
    const out = extractEntities("这个系统的记忆方案有问题, 我们需要让它更稳定一些");
    expect(out).toEqual([]);
  });

  it("版本号/纯数字/纯标点不是实体 (不可复用)", () => {
    expect(extractEntities("升级到 1.2.3, 见 42 与 ---")).toEqual([]);
  });

  it("结果与 pattern 书写顺序无关: 按**出现位置**取值, 不是按 pattern 取满", () => {
    // 分隔符形状在前 + 全大写缩写在后; 若按 pattern 依次取满, 缩写会因名额耗尽而丢失。
    expect(extractEntities("a.ts b.ts c.ts DSH", { limit: 4 })).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "DSH",
    ]);
  });

  it("去重 (按键) 且顺序确定: 同一文本必然同一结果 (重建幂等的前提)", () => {
    const text = "FTS5 与 fts5 是同一个东西, 还有 ftS5";
    expect(extractEntities(text)).toEqual(["FTS5"]);
    expect(extractEntities(text)).toEqual(extractEntities(text));
  });

  it("上限是**测出来**的 16, 不是随手拍的数字", () => {
    expect(DEFAULT_ENTITY_LIMIT).toBe(16);
    const many = Array.from({ length: 40 }, (_, i) => "mod" + i + ".ts").join(" ");
    expect(extractEntities(many)).toHaveLength(DEFAULT_ENTITY_LIMIT);
    expect(extractEntities(many, { limit: 3 })).toHaveLength(3);
    expect(extractEntities(many, { limit: 0 })).toEqual([]);
  });

  it("空输入与超长候选安全退化", () => {
    expect(extractEntities("")).toEqual([]);
    expect(extractEntities("a".repeat(80) + ".ts")).toEqual([]);
  });
});

describe("条目 → 实体", () => {
  it("显式字段优先: 结构化器给的是权威值, 不做兜底覆盖", () => {
    expect(entitiesOf({ entities: ["自定义实体"], content: "prestep.ts 与 FTS5" })).toEqual([
      "自定义实体",
    ]);
  });

  it("字段缺失时用确定性抽取兜底 (这是 0% 填充率的修法)", () => {
    expect(entitiesOf({ content: "prestep.ts 走 FTS5" })).toEqual(
      expect.arrayContaining(["prestep.ts", "FTS5"]),
    );
  });

  it("显式字段为空数组也走兜底 (抽不出来的旧条目不是特例)", () => {
    expect(entitiesOf({ entities: [], content: "见 ADR-023" })).toEqual(
      expect.arrayContaining(["ADR-023"]),
    );
  });

  it("重叠形状会同时抽出裸缩写与限定名 (ADR-023 → ADR 与 ADR-023): 这是有意的", () => {
    // 裸缩写是**真的可复用**: 库里同时存在 ADR-022/023/024 时, "ADR" 这一条键把它们连起来。
    // 代价是它是个高频键 (df 高 → 反查池更大), 由检索期的实体通道按共享计数排序来吸收。
    // 顺序 = 先按出现位置, 同位置按键: 两者都从 "ADR-023" 的第 0 个字符起匹配, 于是
    // "adr" 排在 "adr-023" 前面 —— 这是**确定的**, 不依赖 pattern 顺序或对象遍历顺序。
    expect(entitiesOf({ content: "见 ADR-023" })).toEqual(["ADR", "ADR-023"]);
  });

  it("键集合去重且都是规范化后的键", () => {
    const keys = entityKeysOf({ content: "FTS5 / fts5 / FTS5" });
    expect(keys).toEqual(["fts5"]);
  });
});
