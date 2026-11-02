// scripts/panel-ctx.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
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

export const REPO = resolve(new URL("..", import.meta.url).pathname);
export const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
export const PORT = Number(arg("port", process.env.HX_PANEL_PORT ?? "36100"));
export const HOST = arg("host", "127.0.0.1");
export const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
export const MEMORY_ROOT = process.env.HX_MEMORY_ROOT?.trim() || join(DSH_HOME, "hx-memory");
export const CONFIG_DIR = process.env.HX_PANEL_CONFIG_DIR?.trim() || join(homedir(), ".config", "hx-memory-panel");
export const CONFIG_FILE = join(CONFIG_DIR, "panel.json");
export const SINGLE_FILE = join(REPO, "scripts", "panel.dist.html");
export const DIST = resolve(REPO, arg("dist", ".tmp/panel/dist"));
export const EVAL_DIR = join(REPO, "eval-out");
export const STARTED = new Date().toISOString();
/** 面板上明写的口径 (既有约定, 不是新设计): src/trigger/always-on.ts:66 与 src/kb/kb-sync.ts 头注 J2.5。 */
export const KB_NOTE = "知识库是「可查的参考」: kind:doc 切片只在检索时按需返回, 不参与每轮注入 (always-on.ts:66「doc 显式排除」), 也不参与衰减 (kb-sync.ts J2.5)。对话沉淀才是每轮可能注入的记忆。";

// ---------- 小工具 ----------
export const readJson = (f: string): any => {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
};
/** 检索模式, 面板「总览」「记忆」页明写 (FIX-ROUND-2: 按当前配置实时算)。 */
export function parseAt(s: unknown): number {
  const t = String(s ?? "");
  const m = /(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2})(?::(\d{2}))? (AM|PM).*?UTC([+-]\d{2}):?(\d{2})/.exec(t);
  if (m) {
    let h = Number(m[2]) % 12;
    if (m[5] === "PM") h += 12;
    return Date.parse(`${m[1]}T${String(h).padStart(2, "0")}:${m[3]}:${m[4] ?? "00"}${m[6]}:${m[7]}`);
  }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : 0;
}
export const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
export const ageHours = (ms: number) => (ms ? Math.round(((Date.now() - ms) / 36e5) * 10) / 10 : null);

// ---------- 配置 (知识库来源 + 模型) ----------
export interface KbSource { root: string; dirs: string[]; addedAt: string; lastSync?: Record<string, unknown> }
export interface ModelConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  /** encrypted = keyEnc 是 AES-256-GCM 密文; env = 只存环境变量名, 值在面板进程的环境里。 */
  keyMode: "encrypted" | "env" | "none";
  keyEnc?: string;
  keyEnv?: string;
  updatedAt?: string;
}
export interface PanelConfig { kb: KbSource[]; primaryLastSync?: Record<string, unknown>; model: ModelConfig; pluginCloseNote?: string }
/**
 * 插件「已关闭」时显示的原因。来源: 用户 2026-11-01 的说明 (经协调方转述) ——
 * 10 月在插件管理器里主动关闭, 原因是「当时效果不好」。可在 panel.json 的 pluginCloseNote 覆盖。
 */
export const PLUGIN_CLOSE_NOTE = "用户 2026-10 在插件管理器里主动关闭, 原因: 当时效果不好 (最后一次采集 2026-10-11 06:44 UTC)";
export const DEFAULT_MODEL: ModelConfig = { baseUrl: "", model: "", temperature: 0.2, keyMode: "none" };

export function loadConfig(): PanelConfig {
  const c = (readJson(CONFIG_FILE) ?? {}) as Partial<PanelConfig>;
  const m = { ...DEFAULT_MODEL, ...(c.model ?? {}) } as ModelConfig;
  if (!c.model?.keyMode) m.keyMode = m.keyEnc ? "encrypted" : "none"; // 旧版配置没有 keyMode
  return { kb: c.kb ?? [], primaryLastSync: c.primaryLastSync, model: m, ...(typeof c.pluginCloseNote === "string" ? { pluginCloseNote: c.pluginCloseNote } : {}) };
}
export function saveConfig(c: PanelConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

// 主密钥 / 加解密 / key 解析与 src/app/embedding-config.ts 共用一份 (DSH 读面板的 embedding 段时要用同一套解密)。
export const encrypt = (plain: string) => encryptSecret(plain, CONFIG_DIR);
export const mask = (k: string) => (!k ? "" : k.length <= 8 ? "****" : k.slice(0, 3) + "…" + k.slice(-4));
export const resolveKey = (c: { keyMode: ModelConfig["keyMode"]; keyEnc?: string; keyEnv?: string }) => resolveSecret(c, CONFIG_DIR);
// ---------- HTTP ----------
export function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
export async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
export const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
export function serveStatic(path: string, res: ServerResponse) {
  if (existsSync(SINGLE_FILE)) {
    res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
    return res.end(readFileSync(SINGLE_FILE));
  }
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  let file = join(DIST, rel || "index.html");
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  if (!existsSync(file)) return send(res, 503, { ok: false, error: "没有前端产物: scripts/panel.dist.html 与 .tmp/panel/dist 都不存在" });
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

