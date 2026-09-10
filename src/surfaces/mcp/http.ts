// surfaces/mcp/http.ts — MCP Streamable HTTP 传输层 (最小子集)。
//
// 与 stdio 传输的分工完全一致: 本文件只做"HTTP 收发 → 分发 → 回包", 协议语义在
// protocol.ts, 业务在 Facade。两条传输共用 handleMessage, 因此"同一份记忆, 换传输语义不变"。
//
// 为什么需要它: stdio 只能被"能起子进程"的客户端使用 (Claude Desktop / Codex CLI);
// 浏览器内的 MCP 客户端与远程部署只能走 HTTP。
//
// 覆盖的协议面:
//   POST /mcp   单条或数组 JSON-RPC 消息; 通知 (无 id) → 202 空体; 有响应 → 200 + application/json
//   GET  /health → 200 + { ok: true, tools: <工具数> }
//   - 其它路径 404; 路径匹配但方法不对 405
//   - 配置 token 时要求 Authorization: Bearer <token>, 鉴权先于路由 (未授权不暴露路径是否存在)
//
// 安全默认: 只监听 127.0.0.1; token 比较用常量时间比较, 避免按字节猜测。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { MemoryFacade } from "../../app/facade.ts";
import { MCP_TOOLS, handleMessage, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";

export interface McpHttpServerOptions {
  facade: MemoryFacade;
  /** 0/缺省 = 由系统分配端口 (测试与临时实例用)。 */
  port?: number;
  /** 默认 127.0.0.1 (只对本机开放)。 */
  host?: string;
  /** 可选: 要求 Authorization: Bearer <token>。 */
  token?: string;
}

export interface McpHttpServer {
  /** 形如 http://127.0.0.1:4399 */
  readonly url: string;
  close(): Promise<void>;
}

/** 请求体上限: MCP 消息都是小 JSON, 4 MiB 足够且能挡住内存放大攻击。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...headers, "content-length": "0" });
  res.end();
}

/** 常量时间比较: 长度不同直接判否 (长度本身不是秘密), 否则用 timingSafeEqual。 */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // 超限后停止缓存但仍把剩余数据读掉: 直接 destroy 会让 413 回包也一起丢掉。
        chunks.length = 0;
        req.resume();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 客户端给的授权头里取出 Bearer 值; 格式不对返回空串。 */
function bearerToken(req: IncomingMessage): string {
  const raw = req.headers["authorization"];
  const value = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const match = /^Bearer[ ]+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? "";
}

/**
 * 分发一条 JSON-RPC 消息。返回 null 表示"这是通知 / 不该有响应"。
 * 结构非法的条目只影响自己, 不让整批失败。
 */
async function dispatchItem(facade: MemoryFacade, item: unknown): Promise<JsonRpcResponse | null> {
  if (
    typeof item !== "object" ||
    item === null ||
    typeof (item as JsonRpcRequest).method !== "string"
  ) {
    return rpcError(null, -32600, "Invalid Request");
  }
  return handleMessage(facade, item as JsonRpcRequest);
}

/** 处理 POST /mcp: 单条 或 数组 (批处理)。 */
async function handleMcpPost(
  facade: MemoryFacade,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let text: string;
  try {
    text = await readBody(req);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(
        res,
        413,
        rpcError(null, -32700, String(error instanceof Error ? error.message : error)),
      );
    }
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, "Parse error"));
    return;
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      // JSON-RPC 2.0: 空数组是非法请求, 不能当"空批处理"蒙混过去。
      sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const responses: JsonRpcResponse[] = [];
    // 批内串行: 保存类工具读写同一份存储, 顺序执行让结果可预期。
    for (const item of parsed) {
      const response = await dispatchItem(facade, item);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      sendEmpty(res, 202);
      return;
    }
    sendJson(res, 200, responses);
    return;
  }

  const response = await dispatchItem(facade, parsed);
  if (!response) {
    // 通知: 按 Streamable HTTP 约定回 202 且无体。
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, response);
}

/**
 * 起一个 MCP HTTP 服务。返回的 promise 在端口真正 listen 之后 resolve
 * (因此调用方拿到的 url 一定可连)。
 */
export async function createMcpHttpServer(opts: McpHttpServerOptions): Promise<McpHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const token = opts.token;

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        // 1) 鉴权先于路由: 未授权时连"路径是否存在"都不透露。
        if (token !== undefined) {
          const provided = bearerToken(req);
          if (!provided || !tokenMatches(token, provided)) {
            req.resume(); // 排空请求体, 否则客户端可能收到连接重置而不是 401
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const pathname = url.pathname;

        if (pathname === "/mcp") {
          if (req.method !== "POST") {
            req.resume();
            sendEmpty(res, 405, { allow: "POST" });
            return;
          }
          await handleMcpPost(opts.facade, req, res);
          return;
        }

        if (pathname === "/health") {
          if (req.method !== "GET") {
            req.resume();
            sendEmpty(res, 405, { allow: "GET" });
            return;
          }
          sendJson(res, 200, { ok: true, tools: MCP_TOOLS.length });
          return;
        }

        req.resume();
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        if (!res.headersSent) {
          sendJson(
            res,
            500,
            rpcError(null, -32603, String(error instanceof Error ? error.message : error)),
          );
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? (address as AddressInfo).port : port;
  // IPv6 字面量要加方括号才对 (http://[::1]:4399)。
  const urlHost = host.includes(":") ? "[" + host + "]" : host;

  return {
    url: "http://" + urlHost + ":" + actualPort,
    close: async (): Promise<void> => {
      // keep-alive 连接会让 close() 一直等下去 (真实测试里会挂住), 先强制断开。
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
