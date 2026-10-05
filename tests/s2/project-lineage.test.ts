// tests/s2/project-lineage.test.ts — 项目**祖先链**可见性 (嵌套仓库不许被切成两半)。
//
// 真实缺陷 (2026-09-18 实测, 本机 HXLoLis 的真实结构):
//   HXLoLis 是 git 仓库, components/ 下挂着 3 个**独立仓库** (gitlink + .gitmodules):
//   HX-Memory / HX-Workflows / HXLoLi-NaGaMe (HX-Sagasu 是父仓库内的普通目录, 实测确认)。
//   项目键取 git root 目录名, 于是同一套代码库的经验被切成两半 ——
//   从 HX-Memory 里开会话得键 "HX-Memory", 从 HXLoLis 根开会话得键 "HXLoLis",
//   两边互相看不见 (实测 31 条 vs 46 条)。这是"抓不住跨项目共通经验"最具体的一条机制,
//   而它不让任何测试变红: 两个键各自都是"正确"的。
//
// 这个文件钉住三件事 (缺任何一件都会让修法变成另一种坏):
//   1. 子仓库里能看到**父工程**的记忆 (缺陷本身);
//   2. 父工程里**看不到**子仓库的私有记忆 (方向性: 组件是父工程的一部分, 反之不成立);
//   3. 兄弟仓库之间**严格互不可见** (否则就是重演实测过的跨项目泄漏)。
import { describe, expect, it } from "vitest";
import {
  encodeLineage,
  lineageComparable,
  lineageDescendantOf,
  lineageOfToplevels,
  lineageVisible,
  normalizeScopeArg,
  projectKeyOfLineage,
} from "../../src/kernel/project-lineage.ts";
import { selectAlwaysOn } from "../../src/trigger/policy.ts";
import { estimateTokens } from "../../src/kernel/ranking.ts";
import { Binder } from "../../src/kernel/binder.ts";
import type { MemoryEntry } from "../../src/kernel/types.ts";

const T = { validAt: "2026-06-01T00:00:00.000Z", assertedAt: "2026-06-01T00:00:00.000Z" };

/** 本机真实结构: HXLoLis 下挂 4 个组件仓库, 其中两个是兄弟。 */
const HXLOLIS = ["HX-Memory", "HXLoLis"];
const SIBLING = ["HX-Sagasu", "HXLoLis"];
const PARENT_ONLY = ["HXLoLis"];

function decision(id: string, project: string, content: string): MemoryEntry {
  return { id, kind: "decision", scope: "project", project, content, source: "s", ts: T };
}

describe("祖先链解析 (lineageOfToplevels)", () => {
  it("多层路径 → 仓库名链 (最内层在前), 重复项去重", () => {
    expect(
      lineageOfToplevels([
        "/home/hx/Loli/code/HXLoLis/components/HX-Memory",
        "/home/hx/Loli/code/HXLoLis",
      ]),
    ).toEqual(["HX-Memory", "HXLoLis"]);
    // 自引用/重复 (畸形 superproject 关系) 不许产生重复节点。
    expect(lineageOfToplevels(["/a/B", "/a/B"])).toEqual(["B"]);
  });

  it("空输入/纯分隔符 → 空链 (没有工作区上下文)", () => {
    expect(lineageOfToplevels([])).toEqual([]);
    expect(lineageOfToplevels(["/"])).toEqual([]);
  });
});

describe("可见性偏序 (缺陷本身)", () => {
  it("子仓库看得到父工程的记忆 —— 这就是被切成两半的那半边", () => {
    expect(lineageVisible("HXLoLis", HXLOLIS)).toBe(true);
    expect(lineageVisible("HX-Memory", HXLOLIS)).toBe(true);
  });

  it("父工程看不到子仓库的私有记忆 (方向不对称)", () => {
    expect(lineageVisible("HX-Memory", PARENT_ONLY)).toBe(false);
    expect(lineageVisible("HXLoLis", PARENT_ONLY)).toBe(true);
  });

  it("兄弟仓库严格互不可见 (不许退化成'同一条链就全给')", () => {
    expect(lineageVisible("HX-Sagasu", HXLOLIS)).toBe(false);
    expect(lineageVisible("HX-Memory", SIBLING)).toBe(false);
  });

  it("祖先链为空的条目 (agent/global) 不属于任何项目", () => {
    expect(lineageVisible(undefined, HXLOLIS)).toBe(false);
  });
});

describe("编码与兼容 (老数据不许失效)", () => {
  it("用 NUL 分隔: 可打印分隔符会碰撞 ('a.b|c' vs 'a|b.c')", () => {
    const encoded = encodeLineage(["a.b", "c"]);
    expect(encoded.includes("\u0000")).toBe(true);
    expect(encodeLineage(["a", "b.c"])).not.toBe(encoded);
  });

  it("写路径仍只写**最内层仓库名**: 存储格式不变, 老数据不需要迁移", () => {
    expect(projectKeyOfLineage(HXLOLIS)).toBe("HX-Memory");
    expect(projectKeyOfLineage([])).toBeUndefined();
  });

  it("字符串形式的旧调用点归一化为单值语义 (不是空链)", () => {
    expect(normalizeScopeArg("api")).toEqual({ project: "api" });
    expect(normalizeScopeArg("")).toBeUndefined();
    expect(normalizeScopeArg(undefined)).toBeUndefined();
    expect(normalizeScopeArg({ lineage: HXLOLIS })).toEqual({ lineage: HXLOLIS });
  });

  it("可比/后代判定 (绑定挂载点用)", () => {
    expect(lineageComparable(HXLOLIS, PARENT_ONLY)).toBe(true);
    expect(lineageComparable(HXLOLIS, SIBLING)).toBe(true); // 共享祖先 HXLoLis
    expect(lineageComparable(["A"], ["B"])).toBe(false);
    expect(lineageDescendantOf(HXLOLIS, PARENT_ONLY)).toBe(true);
    expect(lineageDescendantOf(PARENT_ONLY, HXLOLIS)).toBe(false);
  });
});

describe("selectAlwaysOn: 按祖先链注入", () => {
  const seed = [
    decision("dInner", "HX-Memory", "HX-Memory 自己的决策"),
    decision("dParent", "HXLoLis", "HXLoLis 父工程的决策"),
    decision("dSibling", "HX-Sagasu", "HX-Sagasu 私有决策"),
  ];

  it("子仓库: 自己的 + 父工程的都在, 兄弟的不在", () => {
    const out = selectAlwaysOn(seed, {
      project: "HX-Memory",
      lineage: HXLOLIS,
      budgetTokens: 4000,
      estimate: estimateTokens,
    });
    expect(out.map((e) => e.id).sort()).toEqual(["dInner", "dParent"]);
  });

  it("父工程: 只有自己的, 看不到子仓库私有的", () => {
    const out = selectAlwaysOn(seed, {
      project: "HXLoLis",
      lineage: PARENT_ONLY,
      budgetTokens: 4000,
      estimate: estimateTokens,
    });
    expect(out.map((e) => e.id)).toEqual(["dParent"]);
  });

  it("不给链时退回单值精确匹配 (老调用点行为一字不变)", () => {
    const out = selectAlwaysOn(seed, {
      project: "HXLoLis",
      budgetTokens: 4000,
      estimate: estimateTokens,
    });
    expect(out.map((e) => e.id)).toEqual(["dParent"]);
  });

  it("没有工作区上下文 → 一条项目内条目都不给 (不许'全都给')", () => {
    const out = selectAlwaysOn(seed, { budgetTokens: 4000, estimate: estimateTokens });
    expect(out).toEqual([]);
  });
});

describe("Binder: 绑定按祖先链匹配 (父工程声明的绑定对组件生效)", () => {
  it("配在父工程上的绑定, 在子仓库里命中; 配在兄弟上的不命中", () => {
    const binder = new Binder(
      () => [],
      () => [
        { project: "HXLoLis", bindings: [{ id: "parent.rules", query: { kind: "rule" } }] },
        { project: "HX-Sagasu", bindings: [{ id: "sibling.rules", query: { kind: "rule" } }] },
      ],
    );
    expect(binder.bindingsFor({ project: "HX-Memory", lineage: HXLOLIS }).map((b) => b.id)).toEqual([
      "parent.rules",
    ]);
    // 更具体的声明优先于祖先的 (就近覆盖)。
    const withOwn = new Binder(
      () => [],
      () => [
        { project: "HXLoLis", bindings: [{ id: "parent.rules", query: { kind: "rule" } }] },
        { project: "HX-Memory", bindings: [{ id: "own.rules", query: { kind: "rule" } }] },
      ],
    );
    expect(withOwn.bindingsFor({ project: "HX-Memory", lineage: HXLOLIS }).map((b) => b.id)).toEqual([
      "own.rules",
    ]);
  });
});
