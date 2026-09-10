// tests/s2/cli-mcp-http.test.ts — CLI 的 MCP HTTP 入口 (常驻服务) 的接线契约。
//
// 这条测的是"接线"而不是协议本身 (协议细节由 tests/s2/mcp-http.test.ts 覆盖):
// 起真实子进程 → 等它打印监听地址 → 打真实 HTTP 请求 → 断言记忆真的落盘 → 发信号优雅退出。
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";

const REPO = join(import.meta.dirname, "../..");

describe("CLI: mcp --http", () => {
  it("起服务 → 健康检查 → 工具调用落盘 → SIGTERM 优雅退出", async () => {
    const root = mkdtempSync(join(tmpdir(), "hxmem-cli-http-"));
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        join(REPO, "src/adapters/codex/cli.ts"),
        "mcp",
        "--http",
        "--port",
        "0",
        "--root",
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      // 等它打印监听地址 (端口 0 由系统分配, 只能从输出里读)
      const url = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("启动超时: " + buf.slice(0, 300))), 20_000);
        child.stdout.on("data", (c) => {
          buf += String(c);
          const m = /listening on (http:\/\/[^\s]+)/.exec(buf);
          if (m?.[1]) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("子进程提前退出 " + code + ": " + buf.slice(0, 300)));
        });
      });

      // 健康检查
      const health = await fetch(url + "/health");
      expect(health.status).toBe(200);
      const body = (await health.json()) as { ok: boolean; tools: number };
      expect(body.ok).toBe(true);
      expect(body.tools).toBeGreaterThan(0);

      // 工具调用 → 记忆落盘
      const call = await fetch(url + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "memory_save",
            arguments: { content: "CLI HTTP 探针内容", kind: "fact" },
          },
        }),
      });
      expect(call.status).toBe(200);
      const rpc = (await call.json()) as { result?: unknown };
      expect(JSON.stringify(rpc.result)).toContain("Saved");

      // 真的落盘 (另一个连接读)
      const stack = openMemoryStack(root);
      expect(stack.store.all().some((e) => e.content.includes("CLI HTTP 探针内容"))).toBe(true);
      stack.close();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
      rmSync(root, { recursive: true, force: true });
    }
  }, 40_000);
});
