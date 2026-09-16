// tests/s2/remote-contract.test.ts — 宿主发现契约 (Typert marker) 的回归。
//
// 为什么单独有一层: 本仓库其它 gateway 测试都**直接调用**方法, 于是绕过了"宿主到底能不能
// 发现这些方法"这一环。真实故障 (2026-09-14) 恰好落在这一环: 插件与宿主各加载了一份
// dsh-typert-protocol, 0.1.1-rc.2 用模块私有 WeakMap 存 @Remote 标记 —— 宿主那份读不到,
// 19 个端点一起 404, 而 fiber 仍是 active、日志干净、单测全绿。
//
// 这里不 import 任何 @deepseek-ai 包: marker 的键是协议公开面 (字符串字面量, 跨版本不变),
// 用字面量读原型属性描述符 —— 换成"宿主那份 remoteMethods()"只会把同一个 bug 再藏一遍。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";
import { HXMEM_REMOTE_METHODS } from "../../src/adapters/dsh/remote-methods.ts";
import {
  REMOTE_METHOD_DESCRIPTOR_KEY,
  assertRemoteContract,
  remoteContract,
  remoteMethodDescriptor,
  remoteMethodNames,
} from "../../src/adapters/dsh/remote-contract.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 只用来挂 marker 的假 Service (不碰 cordis)。 */
class FakeService {}

/** 最小 cordis Context 替身: gateway 的组装期校验只读原型 marker, 不需要真 ctx。 */
function stubContext(): never {
  const stub: Record<string, unknown> = {
    reflect: { provide() {}, get() {} },
    effect(fn: () => void) {
      fn();
      return () => {};
    },
    get() {},
    on() {
      return () => {};
    },
    inject() {},
  };
  stub.scope = { extend: () => stub };
  return stub as never;
}

function defineMarker(target: object, value: unknown): void {
  Object.defineProperty(target, REMOTE_METHOD_DESCRIPTOR_KEY, { configurable: true, value });
}

function clearMarker(target: object): void {
  delete (target as Record<string, unknown>)[REMOTE_METHOD_DESCRIPTOR_KEY];
}

describe("Remote marker 是原型上的可读描述符 (跨模块实例可见)", () => {
  it("键名与协议 0.1.2+ 一致 (被宿主硬编码引用, 改名等于回到读不到)", () => {
    expect(REMOTE_METHOD_DESCRIPTOR_KEY).toBe("@deepseek-ai/dsh-typert-protocol/remote-methods");
  });

  it("读得到 version/methods, 且返回副本 (调用方改不动内部状态)", () => {
    defineMarker(FakeService.prototype, { version: 1, methods: [{ method: "a" }, { method: "b" }] });
    try {
      expect(remoteMethodDescriptor(new FakeService())?.methods.map((m) => m.method)).toEqual([
        "a",
        "b",
      ]);
      const found = remoteMethodDescriptor(new FakeService())!;
      found.methods.push({ method: "injected" });
      expect(remoteMethodNames(new FakeService())).toEqual(["a", "b"]);
    } finally {
      clearMarker(FakeService.prototype);
    }
  });

  it("没有 marker (旧协议的 WeakMap 形态 / 非 Typert Service) 时是空集合, 不抛错", () => {
    expect(remoteMethodDescriptor(new FakeService())).toBeUndefined();
    expect(remoteMethodNames(new FakeService())).toEqual([]);
  });

  it("version 不是 1 (协议换了格式) 时按读不到处理, 而不是误读出新旧混杂的表", () => {
    defineMarker(FakeService.prototype, { version: 2, methods: [{ method: "a" }] });
    try {
      expect(remoteMethodNames(new FakeService())).toEqual([]);
    } finally {
      clearMarker(FakeService.prototype);
    }
  });
});

describe("装配期契约校验", () => {
  it("一致时通过", () => {
    expect(() =>
      assertRemoteContract({ declared: ["a", "b"], discovered: ["a", "b"] }),
    ).not.toThrow();
  });

  it("宿主看不到方法时抛错, 错误里点名缺了哪些 + 指向协议实例不一致", () => {
    expect(() => assertRemoteContract({ declared: ["a", "b"], discovered: [] })).toThrow(
      /宿主看不到 2\/2 个 Remote 方法: a, b/,
    );
    expect(() => assertRemoteContract({ declared: ["a"], discovered: [] })).toThrow(
      /dsh-typert-protocol/,
    );
  });

  it("宿主多看到方法 (声明表漏登记) 时也抛错", () => {
    expect(() => assertRemoteContract({ declared: ["a"], discovered: ["a", "b"] })).toThrow(
      /未声明的方法: b/,
    );
  });
});

describe("真实 gateway: 宿主能发现的就是声明的那 19 个", () => {
  // 这一条是本次故障的直接回归: 它不依赖任何 @deepseek-ai 包的读取方式,
  // 也不依赖"方法能不能调通"—— 只问"宿主读原型能读到什么"。
  it("marker 表的方法名集合 == HXMEM_REMOTE_METHODS", () => {
    const gateway = new HxMemoryGateway(stubContext(), {} as never);
    const contract = remoteContract(gateway, HXMEM_REMOTE_METHODS);
    expect(contract.discovered.length).toBe(HXMEM_REMOTE_METHODS.length);
    expect([...contract.discovered].sort()).toEqual([...HXMEM_REMOTE_METHODS].sort());
    expect(() => assertRemoteContract(contract)).not.toThrow();
  });

  it("声明表非空, 且 gateway 是 TypertRemoteService (否则 marker 无处可写)", () => {
    expect(HXMEM_REMOTE_METHODS.length).toBeGreaterThan(0);
    const gatewaySource = readFileSync(resolve(repoRoot, "src/adapters/dsh/gateway.ts"), "utf8");
    expect(gatewaySource).toMatch(/extends TypertRemoteService/);
    const declared = [...gatewaySource.matchAll(/@Remote\("([A-Za-z0-9_$.-]+)"\)/g)].map((m) => m[1]!);
    expect([...declared].sort()).toEqual([...HXMEM_REMOTE_METHODS].sort());
  });
});

describe("装配根真的接上了这道校验", () => {
  // 少了这一步, 上面就只是"库函数测试", 挡不住"接线漏了"。
  const source = readFileSync(resolve(repoRoot, "src/adapters/dsh/index.ts"), "utf8");

  it("index.ts 在装配 gateway 后调用 assertRemoteContract(remoteContract(gateway, HXMEM_REMOTE_METHODS))", () => {
    expect(source).toMatch(
      /assertRemoteContract\(\s*remoteContract\(\s*gateway\s*,\s*HXMEM_REMOTE_METHODS\s*\)\s*\)/,
    );
  });
});
