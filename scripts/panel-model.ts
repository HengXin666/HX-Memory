// scripts/panel-model.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { openMemoryStack, type MemoryStack } from "../src/app/stack.ts";
import { embedderFromConfig, embeddingSource, encryptSecret, readEmbeddingConfig, resolveSecret, type EmbeddingConfig } from "../src/app/embedding-config.ts";
import { DEFAULT_KB_DIRS, KbSync, kbNamespace, kbSourceNamespace, walkMarkdown } from "../src/kb/kb-sync.ts";
import { CanonicalStore } from "../src/external/store.ts";
import { compensateAtTurnEnd, createDetector, LEXICON_MODEL } from "../src/frustration/detect.ts";
import { explain, type LinearModel } from "../src/frustration/classifier.ts";
import { extractFeatures } from "../src/frustration/features.ts";
import { MODEL } from "../src/frustration/model.ts";
import { CATALOG, STATE_TEXT, stateOf } from "./eval/report.ts";
import { DECAY, NORMATIVE_KINDS, SUPERSEDED_FACTOR, TOPIC_OVERLAP, TOPIC_STRONG, ageDaysOf, decayCurve, effectiveConfidence, retention, retentionOf, supersedeByRecency } from "../src/kernel/temporal.ts";
import { selectAlwaysOnDetailed } from "../src/trigger/always-on.ts";
import { qualityOf, summarizeQuality, QUALITY_MIN_LEN, LOW_QUALITY_LEN } from "../src/app/memory-quality.ts";
import { estimateTokens } from "../src/kernel/ranking.ts";
import { CONFIG_DIR, CONFIG_FILE, type ModelConfig, body, encrypt, loadConfig, mask, readJson, resolveKey, saveConfig, send } from "./panel-ctx.ts";
import { resetStack, retrievalMode } from "./panel-state.ts";

export async function modelRoutes(req: IncomingMessage, res: ServerResponse, path: string, m: string) {
  if (path === "model" && m === "GET") {
    const c = loadConfig().model;
    const k = resolveKey(c);
    return send(res, 200, {
      ok: true,
      data: {
        base_url: c.baseUrl, model: c.model, temperature: c.temperature, key_mode: c.keyMode, key_env: c.keyEnv ?? "",
        api_key_masked: mask(k.key), has_key: !!k.key, key_error: k.error ?? "", updatedAt: c.updatedAt ?? null,
        storage: c.keyMode === "env" ? "只存环境变量名, 值不落盘" : process.env.HX_PANEL_SECRET ? "AES-256-GCM, 主密钥来自 HX_PANEL_SECRET (不落盘)" : "AES-256-GCM, 主密钥 " + join(CONFIG_DIR, "master.key") + " (0600)",
        configFile: CONFIG_FILE,
        // 判官 (同轮评审 J3.2-J3.4) 是否可用: 三项缺一项就不可用, 页面必须明写, 不许显示成可用。
        judgeConfigured: !!(c.baseUrl && c.model && k.key),
        judgeMissing: [!c.baseUrl ? "base_url" : "", !c.model ? "model" : "", !k.key ? (k.error ? "API key (解密失败)" : "API key") : ""].filter(Boolean),
      },
    });
  }

  if (path === "model" && m === "PUT") {
    const b = await body(req);
    const cfg = loadConfig();
    const baseUrl = String(b.base_url ?? cfg.model.baseUrl).trim().replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) return send(res, 400, { ok: false, error: "base_url 要以 http:// 或 https:// 开头" });
    const t = b.temperature === undefined || b.temperature === "" ? cfg.model.temperature : Number(b.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) return send(res, 400, { ok: false, error: "temperature 要在 0 到 2 之间" });
    const next: ModelConfig = { ...cfg.model, baseUrl, model: String(b.model ?? cfg.model.model).trim(), temperature: t, updatedAt: new Date().toISOString() };
    const mode = String(b.key_mode ?? cfg.model.keyMode);
    if (mode === "env") {
      const name = String(b.key_env ?? cfg.model.keyEnv ?? "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return send(res, 400, { ok: false, error: "key_env 要是合法的环境变量名" });
      next.keyMode = "env";
      next.keyEnv = name;
      delete next.keyEnc; // 换成环境变量模式时不留旧密文
    } else if (typeof b.api_key === "string" && b.api_key.trim()) {
      next.keyMode = "encrypted";
      next.keyEnc = encrypt(b.api_key.trim());
      delete next.keyEnv;
    } else if (b.clear_key === true) {
      next.keyMode = "none";
      delete next.keyEnc;
      delete next.keyEnv;
    }
    cfg.model = next;
    saveConfig(cfg);
    return send(res, 200, { ok: true });
  }

  if (path === "model/test" && m === "POST") {
    const c = loadConfig().model;
    if (!c.baseUrl || !c.model) return send(res, 400, { ok: false, error: "先保存 base_url 和 model" });
    const k = resolveKey(c);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (k.key) headers.authorization = "Bearer " + k.key;
    const scrub = (s: string) => (k.key ? s.split(k.key).join(mask(k.key)) : s);
    const reqBody = { model: c.model, temperature: c.temperature, max_tokens: 16, messages: [{ role: "user", content: "只回复两个字母: ok" }] };
    const t0 = Date.now();
    try {
      const r = await fetch(c.baseUrl + "/chat/completions", { method: "POST", headers, signal: AbortSignal.timeout(30000), body: JSON.stringify(reqBody) });
      const raw = await r.text();
      let j: any = null;
      try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
      return send(res, 200, { ok: true, data: { url: c.baseUrl + "/chat/completions", request: reqBody, status: r.status, ms: Date.now() - t0, reply: j?.choices?.[0]?.message?.content ?? null, usage: j?.usage ?? null, error: j?.error?.message ?? (r.ok ? null : "HTTP " + r.status), keyUsed: k.key ? mask(k.key) : "(无 key)", keyError: k.error ?? "", raw: scrub(raw).slice(0, 2000) } });
    } catch (e) {
      return send(res, 200, { ok: true, data: { url: c.baseUrl + "/chat/completions", request: reqBody, status: null, ms: Date.now() - t0, reply: null, error: scrub(String(e)), keyUsed: k.key ? mask(k.key) : "(无 key)", keyError: k.error ?? "", raw: "" } });
    }
  }

  // ---------- 嵌入模型 (与判官 model 分开配置; FIX-ROUND-2) ----------
  if (path === "embedding" && m === "GET") {
    const c = readEmbeddingConfig(CONFIG_DIR);
    const k = resolveKey(c);
    const src = embeddingSource(process.env, CONFIG_DIR);
    return send(res, 200, { ok: true, data: { base_url: c.baseUrl, model: c.model, dim: c.dim ?? null, key_mode: c.keyMode, key_env: c.keyEnv ?? "", has_key: !!k.key, api_key_masked: mask(k.key), key_error: k.error ?? "", updatedAt: c.updatedAt ?? null, effective: { source: src.source, model: src.model, baseUrl: src.baseUrl }, retrieval: retrievalMode() } });
  }
  if (path === "embedding" && m === "PUT") {
    const b = await body(req);
    const raw = (readJson(CONFIG_FILE) ?? {}) as Record<string, unknown>;
    const prev = readEmbeddingConfig(CONFIG_DIR);
    const keyMode = b.key_mode === "env" ? "env" : b.key_mode === "none" ? "none" : "encrypted";
    const next: EmbeddingConfig = { baseUrl: String(b.base_url ?? "").trim().replace(/\/+$/, ""), model: String(b.model ?? "").trim(), keyMode, updatedAt: new Date().toISOString() };
    const dim = Number(b.dim);
    if (Number.isFinite(dim) && dim > 0) next.dim = dim;
    if (next.baseUrl && !/^https?:\/\//.test(next.baseUrl)) return send(res, 400, { ok: false, error: "base_url 必须以 http:// 或 https:// 开头" });
    if (keyMode === "env") next.keyEnv = String(b.key_env ?? "").trim();
    else if (keyMode === "encrypted") { const k = String(b.api_key ?? "").trim(); if (k) next.keyEnc = encrypt(k); else if (prev.keyEnc) next.keyEnc = prev.keyEnc; }
    raw.embedding = next;
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
    chmodSync(CONFIG_FILE, 0o600);
    // 配置变了: 关掉旧记忆栈, 下次请求按新嵌入器重开 (向量投影重建)。
    resetStack();
    return send(res, 200, { ok: true, data: { retrieval: retrievalMode() } });
  }
  if (path === "embedding/test" && m === "POST") {
    const src = embeddingSource(process.env, CONFIG_DIR);
    if (src.source === "none") return send(res, 400, { ok: false, error: "嵌入模型未配置: 先保存 base_url 和 model" });
    const scrub = (x: string) => (src.key ? x.split(src.key).join(mask(src.key)) : x);
    const t0 = Date.now();
    try {
      const r = await fetch(src.baseUrl + "/embeddings", { method: "POST", headers: { "content-type": "application/json", ...(src.key ? { authorization: "Bearer " + src.key } : {}) }, signal: AbortSignal.timeout(30000), body: JSON.stringify({ model: src.model, input: ["记忆检索连通性测试"] }) });
      const raw = await r.text();
      let j: any = null;
      try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
      const vec = j?.data?.[0]?.embedding;
      return send(res, 200, { ok: true, data: { url: src.baseUrl + "/embeddings", source: src.source, status: r.status, ms: Date.now() - t0, dim: Array.isArray(vec) ? vec.length : null, error: r.ok && Array.isArray(vec) ? null : (j?.error?.message ?? "HTTP " + r.status + (Array.isArray(vec) ? "" : ", 响应里没有 data[0].embedding")), raw: scrub(raw).slice(0, 500) } });
    } catch (e) {
      return send(res, 200, { ok: true, data: { url: src.baseUrl + "/embeddings", source: src.source, status: null, ms: Date.now() - t0, dim: null, error: scrub(String(e)), raw: "" } });
    }
  }

  return send(res, 404, { ok: false, error: "no route: " + m + " /api/" + path });
}
