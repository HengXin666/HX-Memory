// src/adapters/dsh/llm-agent.ts — 经 DSH agents 服务调一个最小 agent 做总结/结构化。
// 形态: ctx.agents 是 DSH 官方 agent 生命周期服务 (dsh-agent); 我们只做"一次最小对话":
//   - 用独立 session (不污染用户会话);
//   - 单轮 prompt, 要求纯文本输出;
//   - 超时/失败 → 抛错, 由调用方 (structurer/abstractor) 回退启发式。
// 不直接 import dsh-agent (非声明依赖): 用宽松结构类型, 运行时若 agents 不可用则立即回退。
import type { Context } from "@deepseek-ai/cordis";

export interface AgentCallOptions {
  /** 任务描述 (显示用)。 */
  task: string;
  /** 系统提示词。 */
  system: string;
  /** 用户输入。 */
  input: string;
  /** 超时毫秒。 */
  timeoutMs?: number;
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

/** 宽松的 agents 服务形态 (运行时探测, 不静态依赖 dsh-agent)。 */
interface AgentsLike {
  create?(options: unknown): Promise<unknown>;
}

/** 宽松的 agent handle: 只取最终文本。 */
export async function agentSummarize(
  ctx: Context,
  opts: AgentCallOptions,
): Promise<string> {
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
      ctx.logger("hx-memory").info(
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
  const agents = (ctx as unknown as { agents?: AgentsLike }).agents;
  if (!agents?.create) throw new Error("hx-memory: agents service unavailable");
  const handle = await agents.create({
    // 最小 agent: 单轮纯文本响应, 不进入用户会话
    session: {
      seed: [{ role: "system", content: opts.system }, { role: "user", content: opts.input }],
    },
    options: {
      maxTurns: 1,
      maxSteps: 2,
      model: undefined, // 用宿主默认
    },
  });
  const h = handle as unknown as {
    session?: { messages?: Array<{ role: string; content?: unknown }> };
    text?(): Promise<string>;
  };
  // 优先取 session 里最后一条 assistant 文本
  const msgs = h.session?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === "assistant") {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        const t = c.map((x) => (typeof x === "string" ? x : (x as { text?: string })?.text ?? "")).join("");
        if (t) return t;
      }
    }
  }
  if (h.text) return await h.text();
  throw new Error("hx-memory: agent returned no text");
}
