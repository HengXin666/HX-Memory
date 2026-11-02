// app/embedding-config.ts — 嵌入模型 (真语义检索) 的配置来源与面板密钥。
//
// 来源优先级: 环境变量 HX_MEMORY_EMBEDDING_BASE_URL / _MODEL / _API_KEY / _DIM
//            > 面板配置 <HX_PANEL_CONFIG_DIR 或 ~/.config/hx-memory-panel>/panel.json 的 `embedding` 段
//            > 无 (调用方退回 LexicalEmbedder, 那不是语义模型)。
// `embedding` 段与判官用的 `model` 段分开配置 (FIX-ROUND-2): 判官是 chat 模型, 嵌入是 /embeddings 模型, 常常不是同一个服务。
// 面板里的 key 是 AES-256-GCM 密文, 主密钥 = HX_PANEL_SECRET 或 <配置目录>/master.key; 这里与面板共用同一份加解密实现。
// 测试隔离: 在 vitest 里 (env.VITEST) 不读面板配置, 避免单测因为本机配了嵌入而去调网络。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenAiCompatibleEmbedder } from "../retrieval/embedding-http.ts";

export type KeyMode = "encrypted" | "env" | "none";
export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  dim?: number;
  keyMode: KeyMode;
  keyEnc?: string;
  keyEnv?: string;
  updatedAt?: string;
}
export const EMPTY_EMBEDDING: EmbeddingConfig = { baseUrl: "", model: "", keyMode: "none" };

export function panelConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.HX_PANEL_CONFIG_DIR?.trim() || join(homedir(), ".config", "hx-memory-panel");
}

/** 主密钥: HX_PANEL_SECRET 优先 (不落盘); 否则 <配置目录>/master.key。create=false 时文件不存在就抛错 (只读路径不生成密钥)。 */
export function masterKey(dir: string, create: boolean, env: Record<string, string | undefined> = process.env): Buffer {
  const s = env.HX_PANEL_SECRET?.trim();
  if (s) return createHash("sha256").update(s).digest();
  const f = join(dir, "master.key");
  if (!existsSync(f)) {
    if (!create) throw new Error("没有主密钥 " + f);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(f, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  chmodSync(f, 0o600);
  return createHash("sha256").update(readFileSync(f, "utf8").trim()).digest();
}
export function encryptSecret(plain: string, dir: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(dir, true), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}
export function decryptSecret(enc: string, dir: string): string {
  const [v, iv, tag, body] = enc.split(":");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("密文格式不认识");
  const d = createDecipheriv("aes-256-gcm", masterKey(dir, false), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}
/** 解出一段配置的 key (encrypted / env / none)。 */
export function resolveSecret(c: { keyMode: KeyMode; keyEnc?: string; keyEnv?: string }, dir: string, env: Record<string, string | undefined> = process.env): { key: string; error?: string } {
  if (c.keyMode === "env") {
    const v = c.keyEnv ? env[c.keyEnv] : undefined;
    return v ? { key: v } : { key: "", error: `环境变量 ${c.keyEnv ?? "(未填)"} 在当前进程里没有值` };
  }
  if (c.keyMode === "encrypted" && c.keyEnc) {
    try { return { key: decryptSecret(c.keyEnc, dir) }; } catch (e) { return { key: "", error: "解密失败: " + String(e) }; }
  }
  return { key: "" };
}

export function readEmbeddingConfig(dir: string = panelConfigDir()): EmbeddingConfig {
  try {
    const c = JSON.parse(readFileSync(join(dir, "panel.json"), "utf8"))?.embedding ?? {};
    const out: EmbeddingConfig = { ...EMPTY_EMBEDDING, ...c };
    if (!c.keyMode) out.keyMode = out.keyEnc ? "encrypted" : "none";
    return out;
  } catch {
    return { ...EMPTY_EMBEDDING };
  }
}

export interface EmbeddingSource { source: "env" | "panel" | "none"; baseUrl: string; model: string; dim?: number; key: string; error?: string }
/** 当前生效的嵌入配置 (不发请求)。 */
export function embeddingSource(env: Record<string, string | undefined> = process.env, dir?: string): EmbeddingSource {
  const eb = env.HX_MEMORY_EMBEDDING_BASE_URL?.trim(), em = env.HX_MEMORY_EMBEDDING_MODEL?.trim();
  if (eb && em) {
    const dim = Number(env.HX_MEMORY_EMBEDDING_DIM);
    return { source: "env", baseUrl: eb, model: em, key: env.HX_MEMORY_EMBEDDING_API_KEY ?? "", ...(Number.isFinite(dim) && dim > 0 ? { dim } : {}) };
  }
  if (env.VITEST && dir === undefined) return { source: "none", baseUrl: "", model: "", key: "" };
  const d = dir ?? panelConfigDir(env);
  const c = readEmbeddingConfig(d);
  if (!c.baseUrl || !c.model) return { source: "none", baseUrl: "", model: "", key: "" };
  const k = resolveSecret(c, d, env);
  return { source: "panel", baseUrl: c.baseUrl, model: c.model, key: k.key, ...(c.dim ? { dim: c.dim } : {}), ...(k.error ? { error: k.error } : {}) };
}

/** 按 embeddingSource 造嵌入器; 没配返回 null。 */
export function embedderFromConfig(env: Record<string, string | undefined> = process.env, dir?: string): OpenAiCompatibleEmbedder | null {
  const s = embeddingSource(env, dir);
  if (s.source === "none") return null;
  return new OpenAiCompatibleEmbedder({ baseUrl: s.baseUrl, model: s.model, ...(s.key ? { apiKey: s.key } : {}), ...(s.dim ? { dim: s.dim } : {}), timeoutMs: 30_000 });
}
