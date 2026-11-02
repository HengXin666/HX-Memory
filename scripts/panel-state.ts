// scripts/panel-state.ts — HX-Memory 面板后端的一部分 (2026-11-02 从 panel-server.ts 按职责拆出, verify-structure 400 行约束)。
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
import { CONFIG_DIR, DSH_HOME, MEMORY_ROOT, REPO, readJson } from "./panel-ctx.ts";

export function retrievalMode() {
  const src = embeddingSource(process.env, CONFIG_DIR);
  const prog = (stack?.retriever as unknown as { vectorIndex?: { progress?: { embedded: number; total: number } } } | undefined)?.vectorIndex?.progress ?? null;
  if (src.source === "none") {
    return { semantic: false, source: "none", panel: "当前只有 BM25, 语义检索未启用 (没有配置嵌入模型: 面板「模型 → 嵌入模型」或环境变量 HX_MEMORY_EMBEDDING_BASE_URL/MODEL)", online: "DSH 进程同样读这两处; 都没配时向量通道是 LexicalEmbedder (词典 + 字级 n-gram), 不是语义模型 (src/app/stack.ts)", progress: null };
  }
  return { semantic: true, source: src.source, model: src.model, baseUrl: src.baseUrl, keyError: src.error ?? "", panel: `BM25 + 真语义向量 (${src.model} @ ${src.baseUrl}, 来源 ${src.source === "env" ? "环境变量" : "面板配置"})`, online: "DSH 进程读同一份配置 (环境变量优先, 其次面板 embedding 段), 重启 DSH 后生效", progress: prog };
}

/** 账本里的时间是 "Sun 2026-10-11 2:49 PM CST (UTC+08:00)" 这种人读格式; 统一转成毫秒。 */

// ---------- 记忆栈 (懒打开; 语义通道关掉: 面板不替你调远端嵌入) ----------
let stack: MemoryStack | null = null;
let stackError: string | null = null;
// ---------- 清空知识库 (独立路由 DELETE /api/kb/purge, 2026-11-01) ----------
// 为什么不放开 DELETE /api/kb?root=…&purge=1 的主语料: 那条路的语义是「移除一个增量来源 (登记 + 它命名空间里的切片)」,
// 只碰一个命名空间、不备份、不验证; 主语料是内置来源 (HX_KB_ROOT), 「移除」它没有意义。
// 清空是另一件事: 全部 kb:* doc, 先备份 (一致性快照 + 三件套 + 整棵真相目录), 走 FileBackend.removeMany 真删真相,
// 再跑六条校验 (含「从真相重建一份索引, doc 仍为 0」)。这些全在 scripts/kb-purge.ts 里, 这里**只是把它当子进程跑**,
// 不另写删除实现。用子进程还有一个理由: 删除期间面板进程不持有写连接, 也不会被卡住。
export interface PurgeJob { id: string; startedAt: string; finishedAt?: string; pid?: number; exit?: number | null; backupDir: string; log: string[]; report?: unknown }
let purgeJob: PurgeJob | null = null;
export function startPurge(): PurgeJob {
  const d = new Date();
  const backupDir = join(DSH_HOME, "hx-memory-backup-kbpurge-" + d.toISOString().slice(0, 10).replace(/-/g, ""));
  // 面板自己的 FileBackend 连接先关掉: 清空期间不再读写, 结束后按需重开 (避免持有过期的内存视图)。
  try { stack?.close(); } catch { /* 已关 */ }
  stack = null;
  stackError = null;
  const job: PurgeJob = { id: String(Date.now()), startedAt: d.toISOString(), backupDir, log: [] };
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(REPO, "scripts", "kb-purge.ts"), "--apply", "--root", MEMORY_ROOT, "--backup", backupDir], {
    cwd: REPO,
    env: { ...process.env, HX_PANEL_CONFIG_DIR: CONFIG_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = child.pid;
  const push = (b: Buffer) => { for (const l of b.toString("utf8").split("\n")) if (l.trim()) job.log.push(l); if (job.log.length > 200) job.log.splice(0, job.log.length - 200); };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("close", (code) => {
    job.exit = code;
    job.finishedAt = new Date().toISOString();
    job.report = readJson(join(backupDir, "kb-purge-report.json"));
  });
  purgeJob = job;
  return job;
}

export function getStack(): MemoryStack | null {
  // 清空知识库进行中: 不开第二个写连接 (子进程正在改真相文件), 各接口按「记忆栈暂不可用」处理。
  if (purgeJob && purgeJob.exit === undefined) return null;
  if (stack || stackError) return stack;
  try {
    // 嵌入: 环境变量或面板 embedding 段配了就用真语义 (异步投影), 没配就关掉语义通道 (不退回词法近似, 免得冒充语义)。
    stack = openMemoryStack(MEMORY_ROOT, { embedder: embedderFromConfig(process.env, CONFIG_DIR), autoEvolve: false });
  } catch (e) {
    stackError = String(e);
  }
  return stack;
}
export type Entry = ReturnType<MemoryStack["store"]["all"]>[number];
export const entries = (): Entry[] => getStack()?.store.all() ?? [];
export const bankOfEntry = (e: Entry) => "main:" + (e.project || e.scope);
export const external = () => new CanonicalStore(join(MEMORY_ROOT, "external"));


/** 关掉记忆栈, 下次请求按当前配置重开 (嵌入配置变更时用)。 */
export function resetStack(): void {
  try { stack?.close(); } catch { /* 已关 */ }
  stack = null;
  stackError = null;
}
export const stackErrorOf = () => stackError;
export const purgeJobOf = () => purgeJob;
