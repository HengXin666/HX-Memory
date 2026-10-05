// tests/s1/host-version.test.ts — 门禁要装的宿主版本如何解析 (scripts/lib/host-version.mjs)。
//
// 为什么值得单测: 这段逻辑决定"CI 测的是哪个宿主", 而它的三种失败都是有代价的 ——
// 解析到用户拿不到的版本 (测了个没人跑的组合)、越界时静默降级 (上游把用户推到不支持的宿主上
// 而 CI 假装没事)、以及缺少 dsh.host 时猜一个默认值。三种都不该靠"跑一次 CI 看看"发现。
//
// 这里全部用假的 exec: 真解析要联网, 联网判定属于 CI 那一步, 不属于单测。
import { describe, expect, it, vi } from "vitest";
import {
  hostRange,
  isInRange,
  latestHostVersion,
  resolveHostVersion,
} from "../../scripts/lib/host-version.mjs";

/** 假 npm: 按 "`<spec>` → 版本列表" 应答, 模拟 npm view 的解析行为。 */
function fakeNpm(table: Record<string, string[] | string>) {
  return vi.fn((_cmd: string, args: string[]) => {
    const spec = args[1] ?? "";
    const key = spec.replace("@deepseek-ai/dsh@", "");
    const value = table[key];
    if (value === undefined) throw new Error("E404 no such spec: " + spec);
    return JSON.stringify(value);
  });
}

const MANIFEST = { dsh: { host: "^0.1.7-rc.2 || ^0.2.0-rc.1" } };

describe("hostRange", () => {
  it("读 package.json 的 dsh.host", () => {
    expect(hostRange(MANIFEST)).toBe("^0.1.7-rc.2 || ^0.2.0-rc.1");
  });

  it("缺失或空白时抛错 (不猜默认值)", () => {
    expect(() => hostRange({})).toThrow(/dsh\.host/);
    expect(() => hostRange({ dsh: { host: "   " } })).toThrow(/dsh\.host/);
    expect(() => hostRange({ dsh: { host: 1 } })).toThrow(/dsh\.host/);
  });
});

describe("resolveHostVersion: 装用户会装到的那一个", () => {
  it("取 latest (而不是范围内的最高版 —— 后者可能是 dist-tag next, 用户拿不到)", () => {
    const exec = fakeNpm({ latest: "0.1.7-rc.2", "^0.1.7-rc.2 || ^0.2.0-rc.1": ["0.1.7-rc.2", "0.1.7-rc.3"] });
    expect(resolveHostVersion(MANIFEST, { exec: exec as never })).toBe("0.1.7-rc.2");
  });

  it("latest 落在范围内时接受", () => {
    const exec = fakeNpm({
      latest: "0.2.0-rc.2",
      "^0.1.7-rc.2 || ^0.2.0-rc.1": ["0.1.7-rc.2", "0.2.0-rc.2"],
    });
    expect(resolveHostVersion(MANIFEST, { exec: exec as never })).toBe("0.2.0-rc.2");
  });

  it("latest 越界时**抛错**, 不降级成范围内的另一个版本", () => {
    // 场景: 上游把 0.3.0 推成 latest, 而插件只声明到 0.2.x。
    // 此时用户装到的是一个插件没适配过的宿主 —— 必须有人看见, 而不是让 CI 换一个版本跑绿。
    const exec = fakeNpm({
      latest: "0.3.0-rc.1",
      "^0.1.7-rc.2 || ^0.2.0-rc.1": ["0.1.7-rc.2", "0.2.0-rc.2"],
    });
    expect(() => resolveHostVersion(MANIFEST, { exec: exec as never })).toThrow(
      /用户装到的是插件不支持的宿主/,
    );
    // 错误信息必须给出两个可执行选项 (抬高范围 / 保留并接受 CI 停下)
    expect(() => resolveHostVersion(MANIFEST, { exec: exec as never })).toThrow(/dsh\.host/);
  });

  it("解析不到 (网络失败/包不存在) 时抛错, 不返回空字符串", () => {
    const exec = fakeNpm({});
    expect(() => resolveHostVersion(MANIFEST, { exec: exec as never })).toThrow();
  });
});

describe("latestHostVersion / isInRange", () => {
  it("latest 读单个字符串, 也兼容 npm 给数组的形态", () => {
    expect(latestHostVersion({ exec: fakeNpm({ latest: "0.1.7-rc.2" }) as never })).toBe("0.1.7-rc.2");
    expect(latestHostVersion({ exec: fakeNpm({ latest: ["0.1.7-rc.2"] }) as never })).toBe(
      "0.1.7-rc.2",
    );
  });

  it("isInRange 用 npm 的解析结果判定", () => {
    const exec = fakeNpm({ "^0.1.7-rc.2": ["0.1.7-rc.2", "0.1.7-rc.3"] });
    expect(isInRange("^0.1.7-rc.2", "0.1.7-rc.3", { exec: exec as never })).toBe(true);
    expect(isInRange("^0.1.7-rc.2", "0.1.1-rc.2", { exec: exec as never })).toBe(false);
  });
});

describe("package.json 与 workflow 的接线", () => {
  it("仓库的 dsh.host 存在, 且能被解析出内容", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve: resolvePath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
    const manifest = JSON.parse(readFileSync(resolvePath(root, "package.json"), "utf8"));
    expect(hostRange(manifest)).toMatch(/\^0\.1\./);
  });

  it("boot-smoke.yml 不再硬编码宿主版本, 而是调用解析脚本", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve: resolvePath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
    const workflow = readFileSync(resolvePath(root, ".github/workflows/boot-smoke.yml"), "utf8");
    // 硬编码版本会再次造成"门禁测的版本 ≠ 用户跑的版本"。
    expect(workflow).not.toMatch(/npm install -g @deepseek-ai\/dsh@\d/);
    expect(workflow).toMatch(/scripts\/lib\/host-version\.mjs/);
  });

  // 为什么单列一条: 宿主在装载 bundle 前会用 `evaluatePluginCompatibility` 逐个校验
  // **peerDependencies** 里的 `@deepseek-ai/dsh*` 范围, 不满足就整包跳过 ——
  // 而 `dsh.host` 只决定"CI 装哪个版本", 门禁根本不读它。于是两者漂移时,
  // CI 全绿而插件在真机上**整个不加载** (2026-09-30 实测: dsh.host 已含 ^0.2.0-rc.1
  // 而 peer 仍停在 ^0.1.7-rc.2, 宿主 0.2.0-rc.2 上 `skipping profile bundle`)。
  // peer 是"实际生效的兼容声明", 因此它必须与 dsh.host 同源同值。
  it("peerDependencies 的 dsh 包范围与 dsh.host 同源 (漂移会导致整包被静默跳过)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve: resolvePath, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
    const manifest = JSON.parse(readFileSync(resolvePath(root, "package.json"), "utf8"));
    const host = hostRange(manifest);
    const dshPeers = Object.entries(manifest.peerDependencies as Record<string, string>)
      .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"));
    // 一个都没有时这条断言会空转通过 —— 显式挡住, 否则删光 peer 也算"同源"。
    expect(dshPeers.length).toBeGreaterThan(0);
    for (const [name, range] of dshPeers) expect([name, range]).toEqual([name, host]);
  });
});
