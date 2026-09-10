// tests/s2/llm-agent.test.ts — 一次性 LLM 调用必须按真实宿主契约走。
//
// 真实契约 (dsh-llm): ctx.llm.stream({provider, model, messages, system, maxTokens, signal})
// 返回 StreamChunk 异步流, 用 BlockAssembler 拼块取文本。**不用 ctx.agents.create()**:
// 那会造一个带工具面、会产生自己会话事件的完整 agent, 而本插件在根级监听 session/event,
// 子会话会被再次捕获 → 递归 + 会话污染。
import { describe, expect, it } from "vitest";
import { agentSummarize, resolveRoute } from "../../src/adapters/dsh/llm-agent.ts";

interface StreamCall {
  provider?: unknown;
  model?: unknown;
  system?: unknown;
  maxTokens?: unknown;
  messages?: unknown;
  signal?: unknown;
}

function makeCtx(options: {
  call: StreamCall;
  text?: string;
  selection?: { provider?: string; model?: string } | undefined;
  neverEnd?: boolean;
  includeToolCall?: boolean;
  noLlm?: boolean;
}) {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const ctx = {
    get(name: string) {
      if (name === "agentDefaultModel") {
        return { currentSelection: () => options.selection };
      }
      if (name === "llm") {
        if (options.noLlm) return undefined;
        return {
          async *stream(call: StreamCall) {
            options.call.provider = call.provider;
            options.call.model = call.model;
            options.call.system = call.system;
            options.call.maxTokens = call.maxTokens;
            options.call.messages = call.messages;
            options.call.signal = call.signal;
            yield { type: "block-start", index: 0, blockType: "text" };
            if (options.text !== undefined) {
              yield { type: "text-delta", index: 0, text: options.text };
            }
            if (options.includeToolCall) {
              yield { type: "block-start", index: 1, blockType: "tool-call" };
              yield {
                type: "tool-call-delta",
                index: 1,
                id: "call-1",
                name: "bash",
                argumentsDelta: "{}",
              };
            }
            if (options.neverEnd) await new Promise<void>(() => {});
          },
        };
      }
      return undefined;
    },
    emit(name: string, data: unknown) {
      emitted.push({ name, data });
    },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  };
  return { ctx, emitted };
}

describe("resolveRoute", () => {
  it("取宿主默认模型的 provider/model", () => {
    const { ctx } = makeCtx({ call: {}, selection: { provider: "p", model: "m" } });
    expect(resolveRoute(ctx as never)).toEqual({ provider: "p", model: "m" });
  });

  it("没有默认模型时抛错 (调用方回退启发式)", () => {
    const { ctx } = makeCtx({ call: {}, selection: undefined });
    expect(() => resolveRoute(ctx as never)).toThrow(/no default model/);
  });
});

describe("agentSummarize", () => {
  it("按 llm.stream 契约调用, 拼出文本并记录成功", async () => {
    const call: StreamCall = {};
    const { ctx, emitted } = makeCtx({
      call,
      text: "RULE: 容器必须设并发上限\nCONFIDENCE: 0.8",
      selection: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    });
    const out = await agentSummarize(ctx as never, {
      task: "abstractor",
      system: "你是提炼器",
      input: "实例1",
    });
    expect(out).toContain("RULE:");
    expect(call.provider).toBe("deepseek-official");
    expect(call.model).toBe("deepseek-v4-flash");
    expect(call.system).toBe("你是提炼器");
    expect(call.maxTokens).toBe(512);
    expect(Array.isArray(call.messages)).toBe(true);
    const record = emitted[0]?.data as { ok: boolean; task: string };
    expect(record.ok).toBe(true);
    expect(record.task).toBe("abstractor");
  });

  it("忽略 tool-call 块 (只要文本)", async () => {
    const { ctx } = makeCtx({
      call: {},
      text: "纯文本",
      selection: { provider: "p", model: "m" },
      includeToolCall: true,
    });
    await expect(
      agentSummarize(ctx as never, { task: "t", system: "s", input: "i" }),
    ).resolves.toBe("纯文本");
  });

  it("超时 → 中止请求并抛出 (由调用方回退)", async () => {
    const call: StreamCall = {};
    const { ctx, emitted } = makeCtx({
      call,
      neverEnd: true,
      selection: { provider: "p", model: "m" },
    });
    const pending = agentSummarize(ctx as never, {
      task: "structurer",
      system: "s",
      input: "i",
      timeoutMs: 10,
    });
    const rejected = expect(pending).rejects.toThrow(/timed out after 10ms/);
    await rejected;
    expect((call.signal as AbortSignal).aborted).toBe(true);
    const firstEmit = emitted[0];
    expect(firstEmit).toBeDefined();
    expect(((firstEmit as { data: { ok: boolean } }).data as { ok: boolean }).ok).toBe(false);
  });

  it("流以 error/aborted/max-tokens 结束时必须失败 (半截输出不能当成功)", async () => {
    for (const kind of ["error", "aborted", "max-tokens"]) {
      const ctx = {
        get(name: string) {
          if (name === "agentDefaultModel") {
            return { currentSelection: () => ({ provider: "p", model: "m" }) };
          }
          if (name === "llm") {
            return {
              async *stream() {
                yield { type: "text-delta", index: 0, text: "RULE: 半截规则" };
                yield { type: "finish", reason: { kind } };
              },
            };
          }
          return undefined;
        },
        emit: () => {},
        logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      };
      await expect(
        agentSummarize(ctx as never, { task: "abstractor", system: "s", input: "i" }),
      ).rejects.toThrow(new RegExp(kind));
    }
  });

  it("没有 llm 服务时立刻抛错", async () => {
    const { ctx } = makeCtx({ call: {}, noLlm: true });
    await expect(
      agentSummarize(ctx as never, { task: "t", system: "s", input: "i" }),
    ).rejects.toThrow(/llm service unavailable/);
  });
});
