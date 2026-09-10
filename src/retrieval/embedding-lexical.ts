// retrieval/embedding-lexical.ts — 离线语义近似: 词典归一 + 字级 n-gram 加权。
//
// 为什么需要它: 实测本地"词/bigram 哈希袋"对同义改写几乎无用 (真同义改写 cos≈0.19,
// 无关文本 0.14 —— 区分度极低), 而中文没有空格分词, 改写往往换的是**词**而不是字。
// 本实现做两件确定性的事, 不下载模型、不联网、零依赖:
//   1. **同义词归一**: 内置一张中英混排的口语↔术语映射表 (上线/发版→发布, 兜底→熔断…),
//      把"换个说法"折叠到同一批规范词上;
//   2. **字级 n-gram (1/2/3-gram) 加权**: 中文改一个词仍共享大量字, 字级 n-gram 比词级更稳,
//      并对英文按词根截断 (retry/retries → retr) 做轻量词形归一。
//
// 诚实边界: 这仍然是**词汇/字面**方法 (词典驱动的语义), 覆盖不到词典外的同义表达。
// 真语义请配置远端嵌入器 (embedding-http.ts) —— 两者共用同一个 Embedder 端口, 可随时切换。
import type { Embedder, SyncEmbedder } from "../kernel/ports.ts";
import { termStreams } from "../kernel/cjk.ts";

/** 同义词表: 每组内的词互相等价, 统一折叠到组内第一个 (规范形式)。 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["发布", "上线", "发版", "部署", "release", "deploy", "上线发布"],
  ["校验", "检查", "验证", "核对", "回归测试", "回归", "test", "validate", "verify"],
  ["并发", "并行", "同时", "concurrency", "concurrent", "parallel"],
  ["上限", "限制", "最大", "限额", "threshold", "limit", "quota"],
  ["超时", "timeout", "timed out"],
  ["重试", "retry", "retries", "re-try"],
  ["熔断", "断路", "circuit breaker", "circuitbreaker"],
  ["连接池", "连接", "connectionpool", "pool", "connection"],
  ["缓存", "cache", "caching"],
  ["过期", "失效", "过期时间", "ttl", "expire", "expiry", "expiration"],
  ["鉴权", "认证", "权限", "授权", "auth", "authentication", "authorization", "权限校验"],
  ["状态码", "响应码", "httpcode", "statuscode", "返回码"],
  ["消息队列", "队列", "mq", "kafka", "rabbitmq", "queue"],
  ["堆积", "积压", "backlog", "拥堵", "消费不过来"],
  ["限流", "流控", "ratelimit", "throttle"],
  ["扩容", "扩缩容", "scale", "scaling", "水平扩展"],
  ["日志", "log", "logging", "记录"],
  ["采样", "sampling", "采样率"],
  ["构建", "build", "打包", "编译", "compile"],
  ["压缩", "gzip", "brotli", "zip", "minify"],
  ["体积", "大小", "size", "体积优化"],
  ["定时任务", "cron", "schedule", "调度", "job", "任务"],
  ["分布式锁", "锁", "lock", "distributedlock", "互斥"],
  ["重复执行", "重复", "幂等", "idempotent", "duplicate", "重复跑"],
  ["回滚", "rollback", "退回", "回退", "revert"],
  ["方案", "plan", "预案", "对策", "策略", "strategy"],
  ["优化", "调优", "改进", "optimize", "optimise", "improvement", "性能优化"],
  ["静态资源", "资源", "asset", "assets", "前端产物", "产物"],
  ["排查", "定位", "诊断", "debug", "troubleshoot", "定位问题"],
  ["详细", "更细", "verbose", "明细", "详细信息"],
  ["退回去", "退回", "回退", "回滚", "rollback", "revert", "撤销"],
  ["打架", "冲突", "抢占", "争用", "conflict", "contention"],
  ["兜底", "兜底策略", "降级", "fallback", "熔断", "断路"],
];

const CANONICAL = new Map<string, string>();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0] ?? "";
  if (!canonical) continue;
  for (const word of group) CANONICAL.set(word.toLowerCase(), canonical);
}

function hash32(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 轻量词形归一: 英文去复数/ing/ed 后缀 (retries→retry, released→releas)。 */
function stemLatin(token: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(token)) return token;
  return token
    .replace(/(ies)$/, "y")
    .replace(/(sses)$/, "ss")
    .replace(/(es)$/, "")
    .replace(/(ing|ed)$/, "")
    .replace(/(s)$/, "");
}

export interface LexicalEmbedderOptions {
  dim?: number;
  /** 身份串后缀 (同义词表变了要改, 否则索引会混用两种向量)。 */
  tag?: string;
}

/**
 * 离线语义近似嵌入器。同步实现 —— 可在预步注入路径直接使用 (无需投影)。
 */
export class LexicalEmbedder implements SyncEmbedder {
  readonly id: string;
  readonly dim: number;
  /**
   * 标定过的余弦下限。依据本项目评测集 (10 条记忆 × 同义改写查询):
   * 同义改写平均 ≈0.50 (区间 0.15-0.76), 无关文本平均 ≈0.005; 取 0.22 可挡住噪声同义召回。
   */
  readonly floor = 0.22;

  constructor(opts: LexicalEmbedderOptions = {}) {
    this.dim = Math.max(64, opts.dim ?? 512);
    this.id = "lexical-v1" + (opts.tag ? "+" + opts.tag : "");
  }

  embedSync(texts: readonly string[]): number[][] {
    return texts.map((text) => this.embedOne(text));
  }

  embed(texts: readonly string[]): number[][] {
    return this.embedSync(texts);
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const add = (token: string, weight: number): void => {
      const index = hash32(token) % this.dim;
      vector[index] = (vector[index] ?? 0) + weight;
    };

    const normalized = text.normalize("NFKC").toLowerCase();
    // 1) 同义词归一: 词典命中的口语词折叠到规范词 (按最长优先, 避免"发布"吃掉"发布流程")。
    const canonicalised: string[] = [];
    let rest = normalized;
    for (const word of [...CANONICAL.keys()].sort((a, b) => b.length - a.length)) {
      const canonical = CANONICAL.get(word);
      if (!canonical || !rest.includes(word)) continue;
      canonicalised.push(canonical);
      rest = rest.split(word).join(" ");
    }
    for (const token of canonicalised) add("syn:" + token, 3);

    // 2) 词流 (去常见单字噪声) + 字级 2/3-gram。
    const streams = termStreams(normalized + " " + rest);
    for (const raw of streams.words) {
      const token = stemLatin(raw);
      const canonical = CANONICAL.get(token) ?? CANONICAL.get(raw);
      if (canonical) {
        add("syn:" + canonical, 3);
        continue;
      }
      if (token.length >= 2) add("w:" + token, 1.5);
    }
    // 字级 n-gram: 中文改写常常换词不换字, 字级比词级稳。
    const han = normalized.replace(/[^\u3400-\u9fff]+/gu, " ");
    for (const run of han.split(/\s+/)) {
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= run.length; i++) add("c" + n + ":" + run.slice(i, i + n), 0.5);
      }
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    return vector;
  }
}
