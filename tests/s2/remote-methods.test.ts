// tests/s2/remote-methods.test.ts — gateway 方法名与客户端调用名必须同源。
// 坑: 方法名写错/改名不会有编译错误, 只会让面板静默 404。
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HXMEM_REMOTE_METHODS,
  isHxMemoryRemoteMethod,
} from "../../src/adapters/dsh/remote-methods.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gateway = readFileSync(resolve(root, "src/adapters/dsh/gateway.ts"), "utf8");

function remoteNames(source: string): string[] {
  return [...source.matchAll(/@Remote\("([A-Za-z0-9_$.-]+)"\)/g)].map((m) => m[1]!);
}

describe("Remote 方法名契约", () => {
  it("gateway 的 @Remote 集合 == HXMEM_REMOTE_METHODS", () => {
    const declared = remoteNames(gateway).sort();
    const listed = [...HXMEM_REMOTE_METHODS].sort();
    expect(declared).toEqual(listed);
  });

  it("每个声明的名字都是合法 endpoint 段", () => {
    for (const name of HXMEM_REMOTE_METHODS) {
      expect(name).toMatch(/^[A-Za-z0-9_$.-]+$/);
      expect(isHxMemoryRemoteMethod(name)).toBe(true);
    }
    expect(isHxMemoryRemoteMethod("nope")).toBe(false);
  });

  it("客户端页面只调用声明过的方法", () => {
    // 新增面板页签时这里会自动覆盖 —— 用目录列举而不是硬编码文件名: 硬编码的清单
    // 会让"新加了一个页面"这种最常见的情形恰好逃过检查 (真实缺陷类别)。
    const pages = readdirSync(resolve(root, "src/adapters/dsh/client"))
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => "client/" + name);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    let total = 0;
    for (const file of pages) {
      const source = readFileSync(resolve(root, "src/adapters/dsh", file), "utf8");
      const calls = [
        ...source.matchAll(/callHxMemory<[^>]*>\(\s*rpc,\s*"([A-Za-z0-9_$.-]+)"/g),
      ].map((m) => m[1]!);
      // 逐页面断言"调用了就算声明过"; 页面的**数量**不在这里要求 (入口页 index.tsx 不直接
      // 调 RPC, 它的子页面才调) —— 但全集必须非空, 否则这条契约会退化成空转。
      for (const call of calls) expect(isHxMemoryRemoteMethod(call)).toBe(true);
      total += calls.length;
    }
    expect(total).toBeGreaterThan(0);
  });
});
