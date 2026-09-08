// tests/s2/client-bundle.test.ts — client bundle 的模块 id 契约回归。
// 宿主 dsh-client-modules 用"loader entry 名 (= 包名)"作为 boot graph 行 id, 并要求
// bundle 用同一个 id 注册, 否则 arrive() 抛 "loaded without registering ..."。
// 曾经硬编码 "@hx/hx-memory" ≠ 包名, 面板整块挂不上。
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientModuleId, wrapClientBundle } from "../../scripts/lib/wrap-client-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  name: string;
};

describe("client bundle 模块 id", () => {
  it("id 逐字等于 package.json 的 name", () => {
    expect(clientModuleId(manifest.name)).toBe(manifest.name);
    const bundle = wrapClientBundle({ body: "exports.apply = 1;", packageName: manifest.name });
    expect(bundle).toContain('id: "' + manifest.name + '",');
    expect(bundle).toContain("window.__ModuleLoader__.load({");
    expect(bundle).toContain("factory: (require) => {");
  });

  it("拒绝空包名", () => {
    expect(() => clientModuleId("")).toThrow();
    expect(() => wrapClientBundle({ body: "", packageName: "  " })).toThrow();
  });

  // 未构建时显式 skip (而不是 expect(true) 假装通过): verify.sh 会先构建, 所以 CI 里必然执行。
  const built = resolve(repoRoot, "dist/dsh/client.js");
  it.skipIf(!existsSync(built))("已构建的 dist/dsh/client.js 注册的是包名 (不是手写别名)", () => {
    const head = readFileSync(built, "utf8").split("\n").slice(0, 4).join("\n");
    expect(head).toContain('id: "' + manifest.name + '"');
  });
});
