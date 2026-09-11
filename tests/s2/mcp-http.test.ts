// tests/s2/mcp-http.test.ts — MCP HTTP 传输 (真·fetch 打真·服务器, 端口 0 系统分配)。
//
// 为什么不上 stub: HTTP 传输的坑都在真链路上 (状态码/头/连接关闭/keep-alive 挂住 close),
// 用 fetch 打一个真监听的 server 才能证明"客户端真的能这么用"。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack, type MemoryStack } from "../../src/app/stack.ts";
import { MCP_TOOLS } from "../../src/surfaces/mcp/protocol.ts";
import { createMcpHttpServer, type McpHttpServer } from "../../src/surfaces/mcp/http.ts";

let root: string;
let stack: MemoryStack;
let server: McpHttpServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hxmem-mcp-http-"));
  stack = openMemoryStack(root);
  server = await createMcpHttpServer({ facade: stack.facade, port: 0 });
});

afterEach(async () => {
  await server.close();
  stack.close();
  rmSync(root, { recursive: true, force: true });
});

type Rpc = { jsonrpc: "2.0"; id: string | number | null; result?: any; error?: any };

/** 打一条 JSON-RPC 到 POST /mcp; 返回原始 Response 让用例自己断言状态码/头/体。 */
function post(body: unknown, init: RequestInit = {}): Promise<Response> {
  return fetch(server.url + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

async function rpc(body: unknown): Promise<Rpc> {
  const res = await post(body);
  expect(res.status).toBe(200);
  return (await res.json()) as Rpc;
}

describe("MCP HTTP 传输", () => {
  it("url 指向真实监听地址 (端口 0 时由系统分配)", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("initialize 往返: 协议版本 / 能力 / 服务信息都回来了", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t" } },
    });
    expect(res.id).toBe(1);
    expect(res.result).toMatchObject({
      protocolVersion: "2024-11-05",
      serverInfo: { name: "hx-memory" },
    });
  });

  it("tools/list 暴露 MCP_TOOLS 声明的全部工具, 且每个都有 schema", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = res.result.tools as Array<{ name: string; inputSchema: unknown }>;
    // 断言与单一事实源一致, 而不是写死数字 —— 加工具时这条断言不该失败
    // (它要证明的是"服务端暴露的就是 MCP_TOOLS 声明的那一集")。
    expect(tools.length).toBe(MCP_TOOLS.length);
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    for (const tool of tools) expect(tool.inputSchema).toBeTruthy();
  });

  it("tools/call: 通过 HTTP 保存后, search 能查到, 且真的落盘", async () => {
    const saved = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: { content: "HTTP 传输下容器并发要显式设上限", kind: "lesson" },
      },
    });
    expect(JSON.stringify(saved.result)).toContain("Saved");
    // 落盘证据: 真相文件里有这条 (不只看响应文本)。
    expect(stack.store.all().some((e) => e.content.includes("HTTP 传输下容器并发"))).toBe(true);

    const found = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "并发" } },
    });
    expect(JSON.stringify(found.result)).toContain("HTTP 传输下容器并发");
  });

  it("通知 (无 id) → 202 且空体; 有响应 → 200 + application/json", async () => {
    const notify = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notify.status).toBe(202);
    expect(await notify.text()).toBe("");

    const withId = await post({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect(withId.status).toBe(200);
    expect(withId.headers.get("content-type")).toContain("application/json");
    expect(((await withId.json()) as Rpc).id).toBe(5);
  });

  it("数组批处理: 通知不占位, 响应按序返回", async () => {
    const res = await post([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 6, method: "ping" },
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
    ]);
    expect(res.status).toBe(200);
    const batch = (await res.json()) as Rpc[];
    expect(batch.map((m) => m.id)).toEqual([6, 7]);
    // 单条失败只影响该条: 未知方法回 -32601, 同批的 ping 仍成功。
    const mixed = await post([
      { jsonrpc: "2.0", id: 8, method: "resources/list" },
      { jsonrpc: "2.0", id: 9, method: "ping" },
    ]);
    const parsed = (await mixed.json()) as Rpc[];
    expect(parsed[0]?.error?.code).toBe(-32601);
    expect(parsed[1]?.error).toBeUndefined();
  });

  it("/health → 200 + { ok, tools }; 不是 GET → 405", async () => {
    const res = await fetch(server.url + "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, tools: MCP_TOOLS.length });

    const wrong = await fetch(server.url + "/health", { method: "POST", body: "{}" });
    expect(wrong.status).toBe(405);
  });

  it("未知路径 → 404; /mcp 用 GET → 405 (带 Allow: POST)", async () => {
    expect((await fetch(server.url + "/nope")).status).toBe(404);
    const res = await fetch(server.url + "/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("坏 JSON → 400/-32700; 结构非法的条目 → -32600 (服务不崩)", async () => {
    const bad = await fetch(server.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Rpc).error.code).toBe(-32700);

    const invalid = await rpc({ jsonrpc: "2.0", id: 10 });
    expect(invalid.error?.code).toBe(-32600);

    // 服务还活着: 后续请求照常。
    expect((await rpc({ jsonrpc: "2.0", id: 11, method: "ping" })).id).toBe(11);
  });

  it("空数组是非法请求 (400/-32600); 超大请求体 → 413, 服务不崩", async () => {
    const empty = await post([]);
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as Rpc).error.code).toBe(-32600);

    const huge = await fetch(server.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "ping",
        params: { pad: "x".repeat(5 * 1024 * 1024) },
      }),
    });
    expect(huge.status).toBe(413);
    expect((await rpc({ jsonrpc: "2.0", id: 13, method: "ping" })).id).toBe(13);
  });
});

describe("MCP HTTP 传输: token 鉴权", () => {
  let guarded: McpHttpServer;
  let guardedRoot: string;
  let guardedStack: MemoryStack;

  beforeEach(async () => {
    guardedRoot = mkdtempSync(join(tmpdir(), "hxmem-mcp-http-token-"));
    guardedStack = openMemoryStack(guardedRoot);
    guarded = await createMcpHttpServer({
      facade: guardedStack.facade,
      port: 0,
      token: "s3cret-token",
    });
  });

  afterEach(async () => {
    await guarded.close();
    guardedStack.close();
    rmSync(guardedRoot, { recursive: true, force: true });
  });

  function guardedPost(body: unknown, token?: string): Promise<Response> {
    return fetch(guarded.url + "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: "Bearer " + token }),
      },
      body: JSON.stringify(body),
    });
  }

  const saveCall = {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: { name: "memory_save", arguments: { content: "未鉴权不该写入的记忆" } },
  };

  it("缺 token / 错 token → 401 且不执行任何工具 (真相文件为空)", async () => {
    const missing = await guardedPost(saveCall);
    expect(missing.status).toBe(401);
    const wrong = await guardedPost(saveCall, "wrong-token");
    expect(wrong.status).toBe(401);
    // 关键断言: 401 不只是状态码, 而是"工具根本没跑"。
    expect(guardedStack.store.all()).toEqual([]);
    // 401 先于路由: 未授权时连 404/405 都不暴露。
    expect((await fetch(guarded.url + "/nope")).status).toBe(401);
    expect((await fetch(guarded.url + "/health")).status).toBe(401);
  });

  it("对 token → 200, 工具真的执行了", async () => {
    const ok = await guardedPost(saveCall, "s3cret-token");
    expect(ok.status).toBe(200);
    expect(JSON.stringify(((await ok.json()) as Rpc).result)).toContain("Saved");
    expect(guardedStack.store.all().some((e) => e.content.includes("未鉴权不该写入"))).toBe(true);
  });
});
