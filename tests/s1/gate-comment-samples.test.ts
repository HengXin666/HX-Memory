// tests/s1/gate-comment-samples.test.ts — 防止"注释里的实测样本"被当成当前事实。
//
// 为什么需要它 (2026-09-18): `gate.ts` 的注释里列了几个"库中零出现的专名"当判据样本,
// 但**库在增长** —— 复核发现注释提到的 rust/tokio/kubernetes/hpa **后来都进了库**,
// 于是那些样本不再是"库外问题"。注释本身没错 (它描述的是当时的观测), 但**引用者会误用**。
//
// 本测试做两件事 (不依赖真实库, 因此可在 CI 跑):
//   ① 注释里必须带**复核时点与失效警告** —— 否则读者会把旧观测当现状;
//   ② 弃权判据对**真正的**库外问题仍然有效 (用当前真实的库外样本)。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldAbstain } from "../../src/retrieval/gate.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("gate.ts 注释的时效性", () => {
  it("样本数据处必须带复核警告 (避免被当成当前事实)", () => {
    const src = readFileSync(resolve(repoRoot, "src/retrieval/gate.ts"), "utf8");
    // 注释里保留了当年的观测, 但必须显式说明"已过时/已复核"
    expect(src).toContain("复核");
    expect(src).toMatch(/已经过时|已过时/);
    // 且必须给出复核后的真实数字, 否则读者无从判断
    expect(src).toMatch(/rust.*14|14.*rust/);
  });
});

describe("弃权判据对真实库外问题有效", () => {
  it("库外专名 (库中确实不存在) → 弃权", () => {
    // 这些专名在项目真实库里从未出现 (复核确认), 因此属于真库外问题。
    const hits = [
      { entry: { content: "踩坑: prestep.ts 的注入时机" }, channels: ["bm25"], score: 0.02 },
    ] as never;
    const weighted = ["kubernetes", "operator"];
    expect(shouldAbstain(hits, weighted)).toBe(true);
  });

  it("查询专名在库中出现 → 不弃权", () => {
    const hits = [
      { entry: { content: "踩坑: prestep.ts 的注入时机由 injectMode 控制" }, channels: ["bm25"], score: 0.02 },
    ] as never;
    // prestep 在库中确实存在
    expect(shouldAbstain(hits, ["prestep", "注入"])).toBe(false);
  });

  it("语义/结构通道的命中 → 不弃权 (它们是不靠字面的相关性证据)", () => {
    const hits = [
      { entry: { content: "完全不同的内容" }, channels: ["vector"], score: 0.02 },
    ] as never;
    expect(shouldAbstain(hits, ["kubernetes"])).toBe(false);
  });
});
