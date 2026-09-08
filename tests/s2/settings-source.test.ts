// tests/s2/settings-source.test.ts — 宿主设置源必须"接住 thunk", 不是接住快照。
// 坑: hooks.setSource(current) 传的是读取权威配置的 thunk; 曾经写成 () => void 0,
// 结果面板里改的设置永远不生效 (7 个设置项全成死配置)。
import { describe, expect, it } from "vitest";
import { createSettingsSource } from "../../src/adapters/dsh/settings-source.ts";

describe("createSettingsSource", () => {
  it("未接住宿主时返回组合配置", () => {
    const source = createSettingsSource({ a: 1 });
    expect(source.read()).toEqual({ a: 1 });
    expect(source.adopted).toBe(false);
  });

  it("接住 thunk 后, 每次读取都重新求值 (设置改动立即生效)", () => {
    const source = createSettingsSource({ a: 1 });
    let current = { a: 1 };
    source.adopt(() => current);
    expect(source.read()).toEqual({ a: 1 });
    current = { a: 2 };
    expect(source.read()).toEqual({ a: 2 }); // 不是快照
    expect(source.adopted).toBe(true);
  });

  it("adopt 拒绝非函数", () => {
    const source = createSettingsSource({ a: 1 });
    expect(() => source.adopt(undefined as never)).toThrow(TypeError);
  });
});
