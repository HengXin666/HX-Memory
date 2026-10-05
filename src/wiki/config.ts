// src/wiki/config.ts — Wiki 的**词汇**配置 (目录 / 页面模板 / 路由 / 注入 / 治理)。
//
// 依据: docs/kinfra-wiki-spec.md §4 与 §9.4。核心边界 (原文的类比是数据库):
//   "我们提供引擎和建模范式, 业务定义自己的表结构。"
//   · 不可变·语法 —— 三级地址、一主题一页、读写共用地址、证据链与演化记录 (在 address/page 层, 不在这里)
//   · 可定义·词汇 —— 有哪些目录、每类页面模板、事实路由规则、注入与治理策略 (就是本文件)
//
// 为什么治理策略要做成配置而不是提示词: 让"这类记忆不许被算法自动改写"成为**可配置的硬规则**。
// 靠提示词约束等于把不变量交给概率机 (本项目已有实测: memory_* 工具调用率 0/7440)。
import { DEFAULT_DOMAINS, slug, type DomainName } from "./address.ts";

/** 治理策略: 决定一张页能否被自动流程改写。 */
export type Governance =
  /** 可参与自动合并/退役 (普通主题页)。 */
  | "mergeable"
  /** 永不遗忘 (可合并但不可退役)。 */
  | "frozen"
  /** 只读: 不接受对话写入, 只能由知识管线更新。 */
  | "readonly";

export interface DomainSpec {
  name: DomainName;
  /** 该目录的语义边界 (人和模型都靠它判断"这条事实该不该进这里")。 */
  semantics: string;
  governance?: Governance;
}

export interface WikiConfig {
  domains: DomainSpec[];
  /** 每类页面的固定小节 (页面模板)。 */
  pageTemplates: Record<string, string[]>;
  /** 事实路由规则 (按顺序匹配, 命中即停)。 */
  routing: Array<{ when: string; to: DomainName; section?: string }>;
  /** 注入策略: 哪些页常驻上下文, 哪些按需召回。 */
  injection: { resident: string[]; onDemand: string[] };
}

/** 默认配置: 通用助理形态, 开箱可用 (业务再增量扩展 2–3 个领域目录)。 */
export const DEFAULT_WIKI_CONFIG: WikiConfig = {
  domains: [
    { name: "people", semantics: "人物: 身份、关系、过敏/禁忌、已承诺事项", governance: "mergeable" },
    { name: "projects", semantics: "项目: 里程碑、当前阻塞、对接人、决定", governance: "mergeable" },
    { name: "preferences", semantics: "偏好: 沟通风格、饮食出行、工作习惯", governance: "mergeable" },
    {
      name: "rules",
      semantics: "硬约束与规则: 必须遵守的红线 (人工确认后才生效)",
      governance: "frozen",
    },
    { name: "experiences", semantics: "经验: 已验证路径、失败教训、适用条件", governance: "mergeable" },
  ],
  pageTemplates: {
    people: ["禁忌", "已承诺事项", "关系", "动态"],
    projects: ["目标", "里程碑", "当前状态", "对接人", "决定"],
    preferences: ["沟通风格", "饮食与出行", "工作习惯"],
    rules: ["硬约束", "适用范围"],
    experiences: ["适用条件", "已验证路径", "失败经验", "完成标准"],
  },
  routing: [
    // 顺序即优先级: 硬约束与禁忌优先于一切 (宁可冗余, 不可丢失)。
    //
    // ⚠ 判据必须是**强约束词**, 不能用普通助动词 (2026-09-18 盲审发现的范式失败直接原因):
    //   旧规则把 "必须" 计入, 而它在日常叙述里到处出现 (实测 125 条语料里 87 条命中, 60%+),
    //   于是 57/125 条被塞进 rules 目录, 且 rules 被配成全部常驻注入 —— 预算被吃光,
    //   "一主题一页" 退化成 "一条目一小节" (实测 63/69 页只有 1 条来源 = 91%)。
    //   现在只保留**显式约束语**: 铁律/红线/禁止/不允许/严禁/不得/必须遵守 (而非裸的"必须")。
    { when: "铁律|红线|禁止|严禁|不允许|不得|必须遵守|硬约束|禁忌", to: "rules", section: "硬约束" },
    { when: "过敏|忌口|不能吃|禁食", to: "people", section: "禁忌" },
    { when: "偏好|喜欢|习惯|宁愿|倾向", to: "preferences" },
    { when: "项目|里程碑|上线|阻塞|排期", to: "projects" },
    { when: "文件|模块|服务|进程|工具|库", to: "projects", section: "当前状态" },
  ],
  // 常驻注入: 只放**全局红线**这一张页, 而不是整个 rules 目录。
  // 旧配置 resident=["rules/*"] 在 rules 被路由灌爆后 (57 页) 会全部进常驻通道, 把预算吃光 ——
  // 这正是"6 条规则吃光 400 token 预算"那个既有事故的 Wiki 版重演。
  // 规则详情按需召回, 只有全局不变量常驻。
  injection: { resident: ["rules/global"], onDemand: ["rules/*"] },
};

/** merge 一份局部配置到默认配置 (不传即用默认)。 */
export function resolveWikiConfig(partial?: Partial<WikiConfig>): WikiConfig {
  if (!partial) return DEFAULT_WIKI_CONFIG;
  const domains = partial.domains?.length ? partial.domains : DEFAULT_WIKI_CONFIG.domains;
  return {
    domains,
    pageTemplates: { ...DEFAULT_WIKI_CONFIG.pageTemplates, ...(partial.pageTemplates ?? {}) },
    routing: partial.routing ?? DEFAULT_WIKI_CONFIG.routing,
    injection: partial.injection ?? DEFAULT_WIKI_CONFIG.injection,
  };
}

/** 该目录的治理策略 (未声明的目录按可合并处理)。 */
export function governanceOf(cfg: WikiConfig, domain: string): Governance {
  const d = cfg.domains.find((x) => slug(x.name) === slug(domain));
  return d?.governance ?? "mergeable";
}

/** 该目录的默认小节 (页面模板的首节; 无模板时用通用小节名)。 */
export function defaultSection(cfg: WikiConfig, domain: string): string {
  const tpl = cfg.pageTemplates[slug(domain)];
  return tpl?.[0] ?? "结论";
}

/** 目录集合 (用于校验路由目标是否存在)。 */
export function domainNames(cfg: WikiConfig): string[] {
  return cfg.domains.map((d) => slug(d.name));
}

export { DEFAULT_DOMAINS };
