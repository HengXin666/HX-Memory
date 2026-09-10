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
//
// 2026-09 扩充 (效果问题): 原字典只有 9 个主题, 覆盖不到"接口设计/性能/依赖/文档/流程"
// 这类同样常见的工程经验 —— 它们全部静默不聚簇, 表现为"跑了批次但 0 条提议", 用户只能
// 得出"这个功能没用"。字典是纯加法: 多一个主题只是多一种聚合口径, 不会让已有行为变化。
const THEME_DICT: Record<string, string[]> = {
  concurrency: ["并发", "concurrenc", "race", "竞态", "锁", "锁竞争"],
  idempotency: ["幂等", "idempoten", "重复请求", "重复提交"],
  timeout: ["超时", "timeout", "重试", "retry", "熔断", "circuit"],
  reliability: ["容错", "failover", "可用性", "故障", "宕机", "挂掉", "降级"],
  storage: ["数据库", "database", "sql", "缓存", "cache", "redis", "存储", "索引", "index"],
  deploy: ["部署", "deploy", "发布", "上线", "回滚", "rollback"],
  testing: ["测试", "test", "单测", "覆盖率", "e2e", "回归"],
  security: ["安全", "security", "认证", "授权", "权限", "token", "密钥", "越权"],
  memory: ["记忆", "memory", "prompt", "上下文", "context", "注入", "召回"],
  // ---- 2026-09 扩充 ----
  api: ["接口", "api", "契约", "schema", "协议", "protocol"],
  performance: ["性能", "performance", "延迟", "latency", "慢", "开销", "benchmark"],
  dependency: ["依赖", "dependenc", "版本", "version", "升级", "upgrade", "锁文件"],
  docs: ["文档", "doc", "注释", "comment", "readme"],
  process: ["流程", "process", "约定", "规范", "审查", "review", "提交", "commit"],
  tooling: ["构建", "build", "脚手架", "工具链", "lint", "格式化", "format"],
  ui: ["界面", "ui", "交互", "前端", "样式", "css", "组件"],
  typescript: ["类型", "typescript", "tsc", "泛型", "编译"],
  error: ["错误", "error", "异常", "exception", "panic", "崩溃"],
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

/** 标签回退簇的前缀 (与主题簇区分, 便于面板/人读时看出"这条是靠标签聚的")。 */
export const TAG_THEME_PREFIX = "tag:";

/**
 * 把条目按主题聚簇。一条可命中多主题 → 归入命中信号最多的主题。
 *
 * 两级聚簇:
 *   1. **主题字典** (主路径): 命中工程主题词 → 归入该主题;
 *   2. **共享标签回退** (2026-09 补): 未命中任何主题词、但带 AI 结构化标签且同一标签
 *      出现在 **>= 2** 条条目上 → 归入 `tag:<name>` 簇。
 *      为什么需要回退: 主题字典永远列不全, 而标签是抽取器已经给出的语义信号;
 *      只靠字典会让大量真实经验永远聚不到簇 (= 用户看到的"跑了没效果")。
 *      下限 2 是为了不产生"每条一个簇"的噪声。
 */
export function clusterByTheme(entries: MemoryEntry[]): ThemeCluster[] {
  const buckets = new Map<string, { entries: MemoryEntry[]; signals: string[] }>();
  const unmatched: MemoryEntry[] = [];
  for (const e of entries) {
    if (e.kind !== "lesson" && e.kind !== "pattern" && e.kind !== "decision") continue;
    const signals: string[] = [];
    const theme = themeOf(e.content, signals);
    if (!theme) {
      unmatched.push(e);
      continue;
    }
    const bucket = buckets.get(theme) ?? { entries: [], signals: [] };
    bucket.entries.push(e);
    for (const s of signals) if (!bucket.signals.includes(s)) bucket.signals.push(s);
    buckets.set(theme, bucket);
  }
  // 标签回退: 只对未命中主题的条目做, 且标签要在 >= 2 条上共现才算一个主题。
  const byTag = new Map<string, MemoryEntry[]>();
  for (const e of unmatched) {
    for (const tag of e.tags ?? []) {
      const key = tag.trim();
      if (!key) continue;
      const list = byTag.get(key) ?? [];
      list.push(e);
      byTag.set(key, list);
    }
  }
  for (const [tag, list] of byTag) {
    if (list.length < 2) continue;
    const key = TAG_THEME_PREFIX + tag;
    const bucket = buckets.get(key) ?? { entries: [], signals: [] };
    for (const e of list) if (!bucket.entries.includes(e)) bucket.entries.push(e);
    if (!bucket.signals.includes(tag)) bucket.signals.push(tag);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries()).map(([theme, b]) => ({
    theme,
    entries: b.entries,
    signals: b.signals,
  }));
}
