// src/adapters/dsh/llm-agent.ts — 一次性文本调用 (结构化/提炼用的"最小 LLM 调用")。
//
// 为什么不用 ctx.agents.create(): 那会造一个**完整 agent** —— 它拥有工具面、产生自己的
// 会话事件, 而本插件在根级监听 session/event, 于是子会话的 user/message 会被再次捕获 →
// 递归调用 + 会话文件污染 (第一方做法见 dsh-session-title-llm: 用 ctx.llm.stream 直接发一次
// 请求, 无 agent、无工具、无会话事件)。这里采用同一形态。
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { MEMORY_PLUGIN_SOURCE } from "./guidance.js";

export interface AgentCallOptions {
  /** 任务描述 (显示/审计用)。 */
  task: string;
  /** 系统提示词。 */
  system: string;
  /** 用户输入。 */
  input: string;
  /** 超时毫秒。 */
  timeoutMs?: number;
  /** 最大输出 token。 */
  maxTokens?: number;
}

/** 一次调用的可审计记录 (面板「调用记录」tab + host 事件)。 */
export interface LlmInvocationRecord {
  task: string;
  prompt: string;
  input: string;
  output: string;
  ok: boolean;
  ms: number;
  at: string;
}

interface StreamOptionsLike {
  provider: string;
  model: string;
  messages: unknown[];
  system?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

interface LlmServiceLike {
  stream(options: StreamOptionsLike): AsyncIterable<unknown>;
}

interface DefaultModelLike {
  currentSelection?: () => { provider?: string; model?: string } | undefined;
}

/** 从宿主默认模型服务解析 provider/model; 取不到就抛错 (调用方回退启发式)。 */
export function resolveRoute(ctx: Context): { provider: string; model: string } {
  const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.(
    "agentDefaultModel",
  ) as DefaultModelLike | undefined;
  const selection = service?.currentSelection?.();
  if (!selection?.provider || !selection.model) {
    throw new Error("hx-memory: no default model selected (agentDefaultModel)");
  }
  return { provider: selection.provider, model: selection.model };
}

/** 取模型输出的纯文本 (忽略 tool-call 块)。 */
function textOfChunks(assembler: BlockAssembler): string {
  return assembler
    .blocks()
    .map((block) => (block.type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/**
 * 调一次模型并返回文本。失败 (无 llm 服务 / 无默认模型 / 超时 / 空输出) 抛错,
 * 由调用方回退启发式 —— 记忆捕获不能因为一次 AI 故障而失败。
 */
export async function agentSummarize(ctx: Context, opts: AgentCallOptions): Promise<string> {
  const started = Date.now();
  const record: LlmInvocationRecord = {
    task: opts.task,
    prompt: opts.system,
    input: opts.input,
    output: "",
    ok: false,
    ms: 0,
    at: new Date().toISOString(),
  };
  const finish = (out: string, ok: boolean): string => {
    record.output = out;
    record.ok = ok;
    record.ms = Date.now() - started;
    try {
      (ctx as unknown as { emit?: (name: string, data: unknown) => void }).emit?.(
        "hx-memory/llm-invocation",
        record,
      );
      ctx
        .logger("hx-memory")
        .info(
          "[llm] %s %s (%dms) %s",
          ok ? "ok" : "fail",
          opts.task,
          record.ms,
          ok ? "" : out.slice(0, 200),
        );
    } catch {
      // 事件/日志失败不阻断
    }
    return out;
  };

  const llm = (ctx as unknown as { get?: (name: string) => unknown }).get?.("llm") as
    LlmServiceLike | undefined;
  if (typeof llm?.stream !== "function") {
    throw new Error("hx-memory: llm service unavailable");
  }

  const timeoutMs = opts.timeoutMs ?? 15000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  // 超时自己拒绝, 不依赖流实现配合 abort: 否则一个不响应 signal 的适配器会让捕获永久挂住。
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error("hx-memory: llm call timed out after " + timeoutMs + "ms");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    const route = resolveRoute(ctx);
    const assembler = new BlockAssembler();
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: opts.system.trim() || undefined,
      maxTokens: opts.maxTokens ?? 512,
      signal: controller.signal,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: opts.input }],
          source: { kind: "plugin", plugin: MEMORY_PLUGIN_SOURCE, form: "instructions" },
        }),
      ],
    });
    const consume = (async () => {
      for await (const chunk of stream) assembler.push(chunk as never);
    })();
    consume.catch(() => {
      // 超时后流仍可能拒绝: 这里挂一个 handler, 避免 unhandled rejection
    });
    await Promise.race([consume, deadline]);
    if (timedOut) throw new Error("hx-memory: llm call timed out after " + timeoutMs + "ms");
    // 失败不是异常而是终止块: dsh-llm 把 adapter/dispatch 故障归一化成 finish{kind:'error'|'aborted'},
    // 此时已流出的文本是**不完整**的, 必须丢弃 (否则半截 "RULE: ..." 会被当成成功提议)。
    const reason = (assembler.finish as { kind?: string } | undefined)?.kind;
    if (reason === "error" || reason === "aborted") {
      throw new Error("hx-memory: llm stream finished with " + reason);
    }
    if (reason === "max-tokens") {
      throw new Error("hx-memory: llm output truncated (max-tokens)");
    }
    const text = textOfChunks(assembler).trim();
    if (!text) throw new Error("hx-memory: llm returned no text");
    return finish(text, true);
  } catch (error) {
    finish(String(error), false);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
