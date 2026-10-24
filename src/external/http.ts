// external/http.ts — 适配器共用的 JSON 调用。超时和状态码在这里收口。
import { EngineError } from "./ports.ts";

export interface HttpOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function engineFetch(opts: HttpOptions): typeof fetch {
  return opts.fetchImpl ?? fetch;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

export function authHeaders(apiKey: string | undefined, json: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["content-type"] = "application/json";
  if (apiKey) headers.authorization = "Bearer " + apiKey;
  return headers;
}

export async function requestJson(
  opts: HttpOptions,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = engineFetch(opts);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetchImpl(joinUrl(opts.baseUrl, path), {
      method,
      headers: authHeaders(opts.apiKey, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? parseJson(text) : null;
    if (res.status >= 300) {
      throw new EngineError(opts.baseUrl, res.status, text.slice(0, 200));
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export function hxIdOf(raw: unknown): string | null {
  const row = asRecord(raw);
  const meta = asRecord(row.metadata);
  if (typeof meta.hx_id === "string" && meta.hx_id) return meta.hx_id;
  if (typeof row.document_id === "string" && row.document_id.startsWith("hx_")) return row.document_id;
  if (typeof row.canonicalId === "string") return row.canonicalId;
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
