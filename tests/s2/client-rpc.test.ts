// tests/s2/client-rpc.test.ts — Web 面板 ↔ 宿主 gateway 的 RPC 约定回归。
// 宿主契约: rpc.call("/api", "hxMemory/<method>", { args: {...} }) → { ok, value }。
// 这四条约定任何一条写错, 面板就是静默 404 或直接抛错 (真实踩过)。
import { describe, expect, it } from "vitest";
import {
  HXMEM_CHANNEL,
  callHxMemory,
  hxMemoryEndpoint,
  hxMemoryPayload,
  type HxMemoryRpcCaller,
} from "../../src/adapters/dsh/client/rpc.ts";

interface Call {
  channel: string;
  endpoint: string;
  payload: unknown;
}

function fakeRpc(result: unknown, calls: Call[]): HxMemoryRpcCaller {
  return {
    async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload });
      return result;
    },
  };
}

describe("hx-memory client RPC 约定", () => {
  it("channel 必须是 /api (以斜杠开头), endpoint 是 namespace/method", async () => {
    const calls: Call[] = [];
    await callHxMemory(fakeRpc({ ok: true, value: [] }, calls), "reviewQueue", {
      status: "proposed",
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.channel).toBe("/api");
    expect(call.channel.startsWith("/")).toBe(true);
    expect(call.endpoint).toBe("hxMemory/reviewQueue");
  });

  it("payload 恰好是 { args: {...} } (宿主只接受这一个字段)", async () => {
    const calls: Call[] = [];
    await callHxMemory(fakeRpc({ ok: true, value: null }, calls), "confirmProposal", {
      id: "p1",
      by: "user:dsh-web",
    });
    expect(calls[0]!.payload).toEqual({ args: { id: "p1", by: "user:dsh-web" } });
    expect(Object.keys(calls[0]!.payload as object)).toEqual(["args"]);
  });

  it("解包 RpcResult 的 value", async () => {
    const calls: Call[] = [];
    const value = await callHxMemory<{ ok: boolean; proposed: number }>(
      fakeRpc({ ok: true, value: { ok: true, proposed: 3 } }, calls),
      "runGeneralization",
      { limit: 100 },
    );
    expect(value).toEqual({ ok: true, proposed: 3 });
  });

  it("ok:false 抛错并带上宿主错误", async () => {
    const calls: Call[] = [];
    await expect(
      callHxMemory(fakeRpc({ ok: false, error: { message: "boom" } }, calls), "reviewQueue", {
        status: "proposed",
      }),
    ).rejects.toThrow(/reviewQueue/);
  });

  it("空响应 / 非法 method 立即失败, 不静默", async () => {
    await expect(
      callHxMemory(fakeRpc(undefined, []), "reviewQueue", { status: "proposed" }),
    ).rejects.toThrow(/empty RPC response/);
    expect(() => hxMemoryEndpoint("bad method")).toThrow();
    expect(HXMEM_CHANNEL).toBe("/api");
    expect(hxMemoryPayload()).toEqual({ args: {} });
  });
});
