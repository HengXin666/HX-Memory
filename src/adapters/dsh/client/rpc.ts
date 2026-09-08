// src/adapters/dsh/client/rpc.ts — HX-Memory Web 面板调宿主 gateway 的唯一入口。
//
// 宿主契约 (dsh-client-connection 的 ClientConnectionRpc + dsh-api-gateway 的 /api 拦截):
//   rpc.call(channel, endpoint, payload, signal?)
//     channel   必须匹配 /^\/[A-Za-z0-9._~-]+$/ —— Typert gateway 挂在共享通道 "/api";
//     endpoint  "hxMemory/<method>" (namespace/method, 两段);
//     payload   必须恰好是 { args: { ...命名参数 } } (Host 方法形参名 → 值);
//     返回值    RpcResult: { ok: true, value } | { ok: false, error }。
// 四条约定任何一条写错, 面板表现为静默 404 或直接抛错, 因此只在这一处出现, 并由
// tests/s2/client-rpc.test.ts 钉住。

import { isHxMemoryRemoteMethod, type HxMemoryRemoteMethod } from "../remote-methods.js";

export const HXMEM_CHANNEL = "/api";
export const HXMEM_NAMESPACE = "hxMemory";

/** 面板能拿到的最小 RPC 面 (ctx.get("connection").rpc)。 */
export interface HxMemoryRpcCaller {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** 宿主 RpcResult 信封。 */
export interface HxMemoryRpcResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** 拼 endpoint: "hxMemory/reviewQueue"; 方法名必须是 gateway 声明的之一。 */
export function hxMemoryEndpoint(method: HxMemoryRemoteMethod | string): string {
  if (!isHxMemoryRemoteMethod(method)) {
    throw new Error("hx-memory rpc: unknown remote method " + JSON.stringify(method));
  }
  return HXMEM_NAMESPACE + "/" + method;
}

/** 拼 payload: 宿主只接受恰好一个 { args } 字段。 */
export function hxMemoryPayload(args: Record<string, unknown> = {}): {
  args: Record<string, unknown>;
} {
  return { args };
}

/** 调一个 gateway 方法并解包 RpcResult; 失败抛错, 由面板展示。 */
export async function callHxMemory<T>(
  rpc: HxMemoryRpcCaller,
  method: HxMemoryRemoteMethod,
  args: Record<string, unknown> = {},
): Promise<T> {
  const res = (await rpc.call(HXMEM_CHANNEL, hxMemoryEndpoint(method), hxMemoryPayload(args))) as
    HxMemoryRpcResult<T> | undefined;
  if (!res || typeof res !== "object") {
    throw new Error("hxMemory." + method + ": empty RPC response");
  }
  if (res.ok !== true) {
    const detail =
      typeof res.error === "string" ? res.error : JSON.stringify(res.error ?? "unknown error");
    throw new Error("hxMemory." + method + ": " + detail);
  }
  return res.value as T;
}
