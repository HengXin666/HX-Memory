// src/generalize/cluster.ts — 主题聚类 (S1 纯逻辑, 无 LLM, 确定性可测)。
// 输入: lesson/pattern/decision 类条目。输出: 主题簇。
// 做法: 信号词主题字典 + #tag 命中 → 同主题归簇。
// 诚实边界: 这不是语义聚类 (中文无分词器); 它只做"信号词一致"的粗聚类,
// 为 LLM 抽象 (可插拔 Abstractor) 提供输入。不同写法同语义的条目需靠 LLM 层合并。
import type { MemoryEntry } from "../kernel/types.ts";

export interface ThemeCluster {
  theme: string;
  entries: MemoryEntry[];
  /** 该簇命中的信号词 (去重)。 */
  signals: string[];
}

// 主题字典: 每个主题的关键命中词 (中英)。新增主题只需加一行。
const THEME_DICT: Record<string, string[]> = {
  concurrency: ["并发", "concurrenc", "race", "竞态", "锁", "锁竞争"],
  idempotency: ["幂等", "idempoten", "重复请求", "重复提交"],
  timeout: ["超时", "timeout", "重试", "retry", "熔断", "circuit"],
  reliability: ["容错", "failover", "可用性", "故障", "宕机", "挂掉"],
  storage: ["数据库", "database", "sql", "缓存", "cache", "redis", "存储"],
  deploy: ["部署", "deploy", "发布", "上线", "回滚", "rollback"],
  testing: ["测试", "test", "单测", "覆盖率", "e2e"],
  security: ["安全", "security", "认证", "授权", "权限", "token", "密钥"],
  memory: ["记忆", "memory", "prompt", "上下文", "context"],
};

export const THEMES = Object.keys(THEME_DICT);

export function themeOf(content: string, signalsOut?: string[]): string | null {
  const lower = content.toLowerCase();
  for (const [theme, words] of Object.entries(THEME_DICT)) {
    const hit = words.filter((w) => lower.includes(w.toLowerCase()));
    if (hit.length > 0) {
      signalsOut?.push(...hit);
      return theme;
    }
  }
  return null;
}

/**
 * 把条目按主题聚簇。一条可命中多主题 → 归入命中信号最多的主题。
 * 无主题信号的条目不进任何簇 (返回的 clusters 不含)。
 */
export function clusterByTheme(entries: MemoryEntry[]): ThemeCluster[] {
  const buckets = new Map<string, { entries: MemoryEntry[]; signals: string[] }>();
  for (const e of entries) {
    if (e.kind !== "lesson" && e.kind !== "pattern" && e.kind !== "decision") continue;
    const signals: string[] = [];
    const theme = themeOf(e.content, signals);
    if (!theme) continue;
    const bucket = buckets.get(theme) ?? { entries: [], signals: [] };
    bucket.entries.push(e);
    for (const s of signals) if (!bucket.signals.includes(s)) bucket.signals.push(s);
    buckets.set(theme, bucket);
  }
  return Array.from(buckets.entries()).map(([theme, b]) => ({
    theme,
    entries: b.entries,
    signals: b.signals,
  }));
}
