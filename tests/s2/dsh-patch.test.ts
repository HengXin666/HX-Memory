// tests/s2/dsh-patch.test.ts — 插件组合 patch 的契约回归。
// 坑: 给 group 加 isolate: { hxMemory: true } 会让服务在 root ctx 不可见,
// 宿主 dsh-api-gateway 的 SRC 扫描拿不到它 → /api/hxMemory/* 全部 404 (实测过)。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const patch = readFileSync(resolve(repoRoot, "dsh/cordis.patch.yml"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
  dsh: { client: { platform: string; inject: string[] } };
};

describe("dsh/cordis.patch.yml", () => {
  it("不隔离 hxMemory (隔离会让宿主 gateway 看不到服务)", () => {
    // 精确到 YAML 键: 裸文本匹配会被注释里的 "isolate" 误伤。
    expect(patch).not.toMatch(/^\s*isolate:/m);
  });

  it("用 group 同时挂 runtime 与 client 两个 entry", () => {
    expect(patch).toContain("@deepseek-ai/cordis-plugin-group");
    expect(patch).toContain(manifest.name + "/dsh");
    expect(patch).toContain('name: "' + manifest.name + '"');
  });
});

describe("package.json 的 dsh 声明", () => {
  it("client 声明与 ./client 导出齐备 (宿主按此发现 bundle)", () => {
    expect(manifest.dsh.client.platform).toBe("web");
    expect(manifest.dsh.client.inject).toContain("@deepseek-ai/dsh-client-connection");
    expect(manifest.exports["./client"]).toBeTruthy();
    expect(manifest.exports["./dsh"]).toBeTruthy();
  });
});
