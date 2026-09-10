// tests/s2/mcp-surface.test.ts — MCP Surface: 协议语义 (进程内) + 真机 stdio (子进程)。
//
// 这是"多宿主"的第一条真凭据: 同一个 Facade, 换一个宿主 (任何 MCP 客户端) 也能用同一份记忆。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { openMemoryStack } from "../../src/app/stack.ts";
import { MCP_TOOLS, MCP_PROTOCOL_VERSION, handleMessage } from "../../src/surfaces/mcp/protocol.ts";
import { serveMcpStdio } from "../../src/surfaces/mcp/server.ts";

const REPO = join(import.meta.dirname, "../..");

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-mcp-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MCP 协议语义 (进程内)", () => {
  it("initialize 返回协议版本/能力/服务信息", async () => {
    const stack = openMemoryStack(root);
    const res = await handleMessage(stack.facade, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: "hx-memory" },
    });
    stack.close();
  });

  it("tools/list 暴露六个工具, schema 完整 (名字/描述/输入结构)", async () => {
    const stack = openMemoryStack(root);
    const res = (await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };
    expect(res.result.tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    for (const tool of res.result.tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeTruthy();
    }
    stack.close();
  });

  it("memory_save → memory_search 走同一份记忆 (含近义去重)", async () => {
    const stack = openMemoryStack(root);
    const saved = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: { content: "容器并发要显式设上限", kind: "lesson" },
      },
    });
    expect(JSON.stringify(saved?.result)).toContain("Saved");

    const again = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "memory_save",
        arguments: { content: "容器并发要显式设置上限!", kind: "lesson" },
      },
    });
    expect(JSON.stringify(again?.result)).toContain("Merged");
    expect(stack.store.all().length).toBe(1);

    const found = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "并发" } },
    });
    expect(JSON.stringify(found?.result)).toContain("容器并发");
    stack.close();
  });

  it("memory_history / memory_forget / memory_stats 可用", async () => {
    const stack = openMemoryStack(root);
    const saved = await stack.facade.remember({ content: "待撤回的记忆内容" });
    const history = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "memory_history", arguments: { id: saved.entry.id } },
    });
    expect(JSON.stringify(history?.result)).toContain(saved.entry.id);

    const forget = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "memory_forget", arguments: { id: saved.entry.id, why: "用户要求" } },
    });
    expect(JSON.stringify(forget?.result)).toContain("shadow");
    expect(stack.facade.recall({ text: "待撤回" }).hits).toEqual([]);

    const stats = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "memory_stats", arguments: {} },
    });
    expect(JSON.stringify(stats?.result)).toContain("total");
    stack.close();
  });

  it("未知方法 → -32601; 通知不产生响应; 空 query → isError", async () => {
    const stack = openMemoryStack(root);
    const unknown = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    });
    expect(unknown?.error?.code).toBe(-32601);
    expect(
      await handleMessage(stack.facade, { jsonrpc: "2.0", method: "notifications/initialized" }),
    ).toBeNull();
    const bad = await handleMessage(stack.facade, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "  " } },
    });
    expect((bad?.result as { isError?: boolean }).isError).toBe(true);
    stack.close();
  });

  it("stdio 传输: 坏 JSON 回 -32700 且服务不退出; 消息按顺序处理", async () => {
    const stack = openMemoryStack(root);
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serveMcpStdio({ facade: stack.facade, input, output });
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(line);
    });
    input.write("这不是 JSON\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.end();
    await served;
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]?.error?.code).toBe(-32700);
    expect(parsed[1]?.id).toBe(1);
    expect(parsed[2]?.id).toBe(2);
    stack.close();
  });
});

describe("MCP 真机 stdio (子进程, 模拟真实客户端)", () => {
  it("通过 stdio 完成 initialize → tools/call, 数据真的落盘", async () => {
    const script = join(root, "mcp-client.mjs");
    writeFileSync(script, MCP_CLIENT_SCRIPT.replace("REPO", REPO), "utf8");
    const result = await runClient(script, root);
    expect(result.errors).toEqual([]);
    expect(result.names).toEqual(["hx-memory"]);
    expect(result.searchText).toContain("容器并发");
    // 记忆真的落了盘 (子进程退出后主进程能读到)
    const stack = openMemoryStack(root);
    expect(stack.store.all().some((e) => e.content.includes("容器并发"))).toBe(true);
    stack.close();
  }, 30_000);
});

const MCP_CLIENT_SCRIPT = `
import { spawn } from "node:child_process";
const [root] = process.argv.slice(2);
// --no-warnings: 抑制 node:sqlite 的实验性警告 (Node 22 有, Node 24 无), 让断言只关心真错误。
const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", "REPO/src/adapters/codex/cli.ts", "mcp", "--root", root], { stdio: ["pipe", "pipe", "pipe"] });
// stderr 不等于失败: Node 22 上 node:sqlite 会打 ExperimentalWarning (Node 24 没有),
// 把任何 stderr 当错误会让这条测试变成"只在某个 Node 版本上通过" —— CI 真抓到了这个假失败。
// 因此: 子进程带 --no-warnings 启动, 且这里只统计真正的错误行 (Error/Unhandled/throw)。
const errors = [];
child.stderr.on("data", (c) => {
  for (const line of String(c).split("\\n")) {
    if (/(?:^|\s)(?:Error|TypeError|ReferenceError|UnhandledPromiseRejection)\b|throw new/.test(line)) {
      errors.push(line);
    }
  }
});
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let i = buffer.indexOf("\\n");
  while (i >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf("\\n");
    if (line.trim()) {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  }
});
let nextId = 1;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout: " + method)); }, 15000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
});
const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
await call("tools/call", { name: "memory_save", arguments: { content: "容器并发要显式设上限", kind: "lesson" } });
const search = await call("tools/call", { name: "memory_search", arguments: { query: "并发" } });
child.stdin.end();
await new Promise((r) => child.on("exit", r));
console.log(JSON.stringify({
  errors,
  names: [init.result.serverInfo.name],
  searchText: search.result.content[0].text,
}));
`;

function runClient(
  script: string,
  root: string,
): Promise<{ errors: string[]; names: string[]; searchText: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [script, root], {
      stdio: "pipe",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error("client exited " + code + ": " + err.slice(0, 500)));
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "{}"));
      } catch (error) {
        reject(new Error("bad client output: " + out.slice(0, 400) + " / " + String(error)));
      }
    });
  });
}
