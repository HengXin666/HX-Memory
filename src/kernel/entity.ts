// kernel/entity.ts — 实体的**提取与规范化键** (全仓库唯一实现)。
//
// 为什么需要它 (实测依据): `entities` 字段自 v2 引入以来**填充率长期为 0%** ——
// 只有 LLM 结构化器会写它, 而结构化器在多数会话里不可用, 于是库里的实体永远为空,
// 依赖实体的建边与图召回都是空转 (真库 82 条: entities 0/82, 边 13 条全是 generalizes)。
// 而"确定性抽取"本来就可以覆盖实体的一大类: **可复用的专名** (文件/模块/库/工具/缩写)。
//
// 两条边界 (与 DEFAULT_STRUCTURER_PROMPT 的规则一致, 因为错的实体比没有更糟):
//   1. 只抽**标识符形状**的专名 (带分隔符的路径名、CamelCase、全大写缩写);
//   2. 不抽泛指词、整句话、纯中文普通名词 —— 规则无法可靠判断它们是不是专名, 宁可留空。
// 因此它是**索引侧**的兜底 (与 tags 一样: 索引里补, 不写回真相文件), 结构化器给出权威值时以它为准。
//
// 不变量: 索引写入与查询**共用** `entityKey` —— 实体键一旦两侧口径分叉, 反查会静默失效
// (同一类问题在分词上已经踩过一次, 见 kernel/cjk.ts 的注释)。
import type { MemoryEntry } from "./types.ts";

/**
 * 实体键 (匹配用): NFKC + 小写 + 去首尾标点。
 * 展示名保留原形, 匹配键统一 —— 同一实体两种写法会让共现/反查匹配失效。
 */
export function entityKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .toLowerCase();
}

/** 默认实体上限 (见 ExtractEntityOptions.limit 的实测说明)。 */
export const DEFAULT_ENTITY_LIMIT = 16;

/**
 * 实体抽取器版本。抽取逻辑改变时必须 +1 —— 存储层据此判定"实体倒排该重算了",
 * 否则老条目会永远停在旧口径上, 而反查**不会报错**, 只会静默少召回。
 * 与 kernel/cjk.ts 的 TOKENIZER_VERSION 是同一机制 (派生物认版本, 认不出就重建)。
 */
export const ENTITY_EXTRACTOR_VERSION = "1";

/** 抽实体时的候选形状 (保守: 只认明确是"专名"的形状)。 */
const PATTERNS: ReadonlyArray<RegExp> = [
  // 带分隔符的标识符: prestep.ts / hx-memory / bge-small-zh / dsh-client-ui-settings / 2026-09-12
  /[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g,
  // 驼峰 (含前导大写串): MemoryFacade / retrievalOnly / **HXLoLi** / iPhone。
  // 前导大写串必须允许 —— 实测漏掉 HXLoLi 会让 104 条 entity_only case 里 19 条的桥断掉
  // (产品名恰好是"HX"+驼峰的形状, 而"首字母大写 + 后续小写"的老写法匹配不到它)。
  /\b[A-Za-z][A-Za-z0-9]*[A-Z][a-z0-9]+\b/g,
  // 全大写缩写 (>=2 字母, 避免把 "A"/"I" 当实体): DSH / MMR / ADR / SQLite 走上面那条
  /\b[A-Z][A-Z0-9]{1,9}\b/g,
];

/** 泛化词黑名单 (它们是句式而非专名; 命中即丢弃)。 */
const STOPWORDS = new Set([
  "json",
  "true",
  "false",
  "null",
  "http",
  "https",
  "www",
  "todo",
  "fixme",
]);

function isCjkOnly(value: string): boolean {
  return /^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(value);
}

export interface ExtractEntityOptions {
  /**
   * 最多几个 (默认 16)。
   *
   * 为什么不是 8: 实测在 104 条 entity_only case 上, 上限 8 时桥断在 35 条上 (覆盖 69/104),
   * 12 → 103/104, 16 → 104/104 且此后不再增长 (平均实体/条 6.6)。上限不是"越小越干净"——
   * 它直接决定反查能答对多少查询, 而这个数字是测出来的, 不是拍的。
   */
  limit?: number;
  /** 单实体最大长度 (超长多半是整句话)。 */
  maxLength?: number;
}

/**
 * 从文本里确定性地抽取实体 (专名)。纯函数, 无 IO, 无宿主依赖。
 *
 * 返回**去重后**的展示名 (原形), 顺序 = 出现顺序 (稳定: 同一文本必然同一结果, 支撑重建幂等)。
 */
export function extractEntities(text: string, opts: ExtractEntityOptions = {}): string[] {
  const limit = Math.max(0, opts.limit ?? DEFAULT_ENTITY_LIMIT);
  const maxLength = Math.max(1, opts.maxLength ?? 40);
  if (limit === 0 || !text) return [];

  // **按出现位置**合并, 而不是"按 pattern 依次取满"。
  // 后者是一个实测到的真实缺陷: 先跑的分隔符 pattern 会把 8 个名额吃光, 全大写缩写
  // (DSH/MCP) 永远轮不到 —— 同一个缩写在一段文本里能不能被抽到, 取决于同段有多少
  // "xxx.ts" 形状的名字。按位置排序后, 抽样的口径变成"文本里先出现的专名优先",
  // 与 pattern 的书写顺序无关。
  const found: Array<{ at: number; raw: string; key: string }> = [];
  const seen = new Set<string>();
  for (const pattern of PATTERNS) {
    // 每条 pattern 都是 /g 且带 lastIndex 状态: 复制一份, 避免跨调用互相干扰。
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) {
      const raw = m[0];
      const at = m.index ?? 0;
      if (raw.length > maxLength) continue;
      const key = entityKey(raw);
      // 键长 < 2: 单字母不是可复用的专名; > maxLength: 多半是整句话。
      if (!key || key.length < 2 || key.length > maxLength) continue;
      if (STOPWORDS.has(key)) continue;
      if (isCjkOnly(raw)) continue;
      // 必须是"含字母"的形状 —— 纯数字/纯标点 (形如 1.2.3) 不可复用。
      if (!/[a-z]/.test(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ at, raw, key });
    }
  }
  found.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return found.slice(0, limit).map((f) => f.raw);
}

/**
 * 一条记忆的实体集合: 显式字段优先, 缺失时用确定性抽取兜底。
 *
 * 为什么兜底在**索引侧**而不是写回真相文件: 实体是**派生物** (可从 content 重算),
 * 而真相文件是人的资产、由重建路径重放。把它当 tags 一样"索引里补"意味着换抽取器时
 * 只要重建索引即可, 不需要迁移任何人的文件 —— 见 agent note 里的取舍记录。
 */
export function entitiesOf(entry: Pick<MemoryEntry, "entities" | "content">): string[] {
  const explicit = (entry.entities ?? []).map((e) => String(e).trim()).filter(Boolean);
  if (explicit.length) return explicit;
  return extractEntities(entry.content);
}

/** 实体键集合 (匹配用; 去重)。 */
export function entityKeysOf(entry: Pick<MemoryEntry, "entities" | "content">): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const name of entitiesOf(entry)) {
    const key = entityKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
