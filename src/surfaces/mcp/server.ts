// surfaces/mcp/server.ts — MCP stdio 传输层 (换行分隔的 JSON-RPC 2.0)。
//
// 职责边界: 本文件只做"读一行 → 分发 → 写一行"; 协议语义在 protocol.ts, 业务在 Facade。
// 顺序性: stdio 上的 JSON-RPC 必须**串行处理** (并发会让响应乱序, 客户端无法配对 id)。
// 健壮性: 单行解析失败只回 -32700, 不终止服务; 输入结束 (EOF) 时优雅退出。
import type { MemoryFacade } from "../../app/facade.ts";
import { handleMessage, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";

export interface McpStdioOptions {
  facade: MemoryFacade;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 单条消息处理失败时的旁路通知 (不该影响其它请求)。 */
  onError?: (error: unknown) => void;
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 跑 stdio 服务循环; 返回的 promise 在输入 EOF 后 resolve。 */
export async function serveMcpStdio(opts: McpStdioOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const write = (message: JsonRpcResponse): void => {
    output.write(JSON.stringify(message) + "\n");
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write(errorResponse(null, -32700, "Parse error"));
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as JsonRpcRequest).method !== "string"
    ) {
      write(errorResponse(null, -32600, "Invalid Request"));
      return;
    }
    const response = await handleMessage(opts.facade, parsed as JsonRpcRequest);
    if (response) write(response);
  };

  let queue: Promise<void> = Promise.resolve();
  const enqueue = (line: string): void => {
    queue = queue.then(() => handleLine(line)).catch((error: unknown) => opts.onError?.(error));
  };

  let buffer = "";
  await new Promise<void>((resolve) => {
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      buffer += String(chunk);
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        enqueue(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    const finish = (): void => {
      if (buffer.trim()) enqueue(buffer);
      buffer = "";
      resolve();
    };
    input.on("end", finish);
    input.on("close", finish);
    input.on("error", (error: unknown) => {
      opts.onError?.(error);
      finish();
    });
  });
  await queue;
}
