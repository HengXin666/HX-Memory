// src/adapters/dsh/guidance.ts — 会话首轮注入的记忆可用声明 + 工具描述工程。
//
// ## 2026-09-29: 7 句指引压成 1 行 (用户实测 "太多无用上下文")
//
// 旧版 `memoryGuidance()` 产出 7 句 / 420 字符 / **314 token**。实测这 7 句里有 5 句的语义
// **已逐字存在于 `memory_search` 的工具描述里** (何时该查 / 自动注入只覆盖常驻不变量 /
// 结果是指南不是指令 / 查不到即不存在), 而工具描述是常驻且必需的 (不给它模型不知道有这个工具)。
// 同一条语义在一个上下文里出现两次 —— 该砍的是注入块那一份。
//
// 保留的那一句只负责工具描述**覆盖不到**的事: 让模型知道"这里有东西可查"。
// 两句并行策略 (代码强制 + 意识引导) 不变, 变的只是引导的篇幅。
//
// ## 两条并行的可靠性策略 (只做其中一条都会漏)
//
//   1. **代码强制** (src/trigger/policy.ts + kernel/binder.ts): always-on 保底 + 意图门控,
//      不依赖模型是否"想起来要查" —— 这是记忆真正生效的保证 (用户确认的约束 r00155cdb954e41c7);
//   2. **意识引导** (本文件 + 工具描述): 让模型知道有这么个东西, 用于它**主动**发起更精确的检索
//      (代码通道给的是通用保底, 模型主动查能更贴题)。
import type { MessageSource } from "@deepseek-ai/dsh-llm";
import type { HxMemorySettings } from "./types.js";
import { memoryOnceNote } from "../../kernel/format-frame.ts";
import { SOURCE_ENTRY_IDS_FIELD } from "../../kernel/injection-format.ts";

export const MEMORY_PLUGIN_SOURCE = "hx-memory";

/**
 * 本插件注入消息的 v4 source kind。
 *
 * 为什么不能再写 `kind: "plugin"` (2026-09-28 实测, dsh 0.1.7-rc.2):
 * session 格式 v4 的原生接纳 (assertV4SourceRowAdmission → source()) 把
 * `kind === "plugin"` 判为**已废弃语法**并直接抛
 * "format v4 message requires a producer-owned source kind"。该错误发生在
 * user/message **写入**路径上, 于是每轮 pre-step 的注入都会让整轮 turn
 * 以 turnError 结束 —— 表现为"一发消息就报错"。
 *
 * 正确形态是生产者自有的 kind: 非第一方插件统一走 `plugin:<name>` 命名空间
 * (见 dsh-session-format-v3-to-v4 的 producerKind(): `plugin:${plugin}`)。
 * 注意 `plugin` 字段本身是 v3 wrapper 的痕迹, v4 里不再携带。
 */
export const MEMORY_SOURCE_KIND = `plugin:${MEMORY_PLUGIN_SOURCE}`;

/**
 * 本插件注入消息在 v4 下的 source (producer-owned kind, 不带废弃的 plugin 字段)。
 *
 * @param form 注入形态 (`instructions` = 条目块; 见 prestep.INJECTION_FORM)。
 * @param entryIds 本次注入的条目 id (2026-09-29 起 id 走这里而非正文)。
 *   实测该扩展字段能通过 v4 真实准入 (`assertV4RowAdmission`) 并经受 JSONL 往返 ——
 *   正文因此不再需要 `<!--hx-memory:id=…-->` 标记 (9 条约省 88 token)。
 *   不传时**不写该字段** (而不是写空数组): 空数组与"没有这个字段"在读取侧等价,
 *   但少一个字段让历史形态与当前形态的 JSON 更容易区分。
 */
export function memoryMessageSource(form: string, entryIds?: readonly string[]): MessageSource {
  // 断言的理由: 本仓 devDependency 的 dsh-llm 仍是 0.1.2-rc.1, 其 MessageSourceMap
  // 只认 `{kind:'plugin', plugin}`; 而宿主运行的是 0.1.7-rc.2 —— 后者把该包装判为
  // 已废弃并在写入时抛错, 只接受生产者自有的 kind。类型与运行时在这里必然错配,
  // 取运行时的真实契约 (实际写出的是新形态 JSON)。
  const base: Record<string, unknown> = { kind: MEMORY_SOURCE_KIND, form };
  if (entryIds?.length) base[SOURCE_ENTRY_IDS_FIELD] = [...entryIds];
  return base as unknown as MessageSource;
}

/**
 * 判断一条消息是否由本插件注入 (同时接受新旧两种形态)。
 *
 * 为什么读取侧必须兼容旧形态: 历史会话里已经存在大量
 * `{kind:'plugin', plugin:'hx-memory'}` 的行, 而跨 step/跨轮去重正是扫这些行
 * (scanPriorInjections / collectInjectionEntries)。只认新形态会让旧会话的
 * "已注入"基线瞬间清空 → 已经注入过的常驻记忆被整份重发。
 */
export function isMemorySource(
  source: { kind?: unknown; plugin?: unknown } | undefined,
): boolean {
  if (!source || typeof source.kind !== "string") return false;
  if (source.kind === MEMORY_SOURCE_KIND) return true;
  return source.kind === "plugin" && source.plugin === MEMORY_PLUGIN_SOURCE;
}

/**
 * 会话首轮的可用声明 (一行)。
 *
 * 名字保留 `memoryGuidance` (调用方与测试按它取); 语义已从"7 句使用说明"变成
 * "一行可用声明" —— 详见本文件头注的重复度实测。
 */
export function memoryGuidance(language: HxMemorySettings["language"]): string {
  return memoryOnceNote(language);
}
