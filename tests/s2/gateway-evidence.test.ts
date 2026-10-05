// tests/s2/gateway-evidence.test.ts — 面板证据链端点的端到端契约。
//
// 为什么单独一层: 面板看到的证据链必须与工具 (memory_evidence) 看到的是**同一份** ——
// 两侧若各自实现, 迟早出现"工具说要接证据源、面板说没有血缘"的分叉, 而用户不知道该信哪个。
// 本测试让 gateway 与工具走同一个 Facade 方法, 并断言两侧输出一致。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStack } from "../../src/app/stack.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { flushTurn } from "../../src/adapters/dsh/capture-ledger.ts";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";
import { registerMemoryTools } from "../../src/adapters/dsh/tools.ts";
import { HXMEM_REMOTE_METHODS } from "../../src/adapters/dsh/remote-methods.ts";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gw-evidence-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * 只挂 deps 的 gateway 替身 (面板端点不碰 cordis)。
 *
 * ⚠ 签名是 \`evidenceChain(id: string)\` 而**不是** \`(q: { id })\` —— 形参名就是协议面:
 * Typert gateway 按形参名把 \`{ args }\` 映射到方法参数。写成对象参数会被宿主拒:
 * \`args fields do not match the descriptor: unexpected "id"\` (2026-09-18 真机 smoke 抓到,
 * 单元测试当时测不出来 —— 它们直接调方法, 绕过了 gateway 的参数校验)。
 */
function gatewayWith(deps: Record<string, unknown>): {
  evidenceChain(id: string): Promise<unknown>;
} {
  const gw = Object.create(HxMemoryGateway.prototype) as { deps: unknown } & {
    evidenceChain(id: string): Promise<unknown>;
  };
  gw.deps = deps;
  return gw;
}

async function seed(stack: ReturnType<typeof openMemoryStack>) {
  const before = new Set(stack.store.all().map((e) => e.id));
  const pipe = new CapturePipeline(stack.store);
  await flushTurn(
    { episodes: () => stack.episodes, log: () => null, pipe, surface: "dsh" },
    {
      session: "session-gw",
      turn: 7,
      project: "gw",
      question: "记住: 面板的证据链要能追到原始对话原话",
      answer: "已记录: 面板的证据链要能追到原始对话原话。",
    } as never,
  );
  return stack.store.all().find((e) => !before.has(e.id) && (e.derivedFrom ?? []).length > 0)!;
}

describe("面板证据链端点", () => {
  it("evidenceChain 已在远端方法白名单里 (否则面板调用静默 404)", () => {
    expect((HXMEM_REMOTE_METHODS as readonly string[]).includes("evidenceChain")).toBe(true);
  });

  it("返回可完整溯源的链路, 含未改写的原文", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const entry = await seed(stack);
    const gw = gatewayWith({ facade: stack.facade });
    const chain = (await gw.evidenceChain(entry.id)) as {
      traceable: boolean;
      episodes: Array<{ role: string; text: string }>;
      reasons: string[];
    };
    expect(chain.traceable).toBe(true);
    expect(chain.episodes.some((e) => e.text.includes("原始对话原话"))).toBe(true);
    expect(chain.reasons).toEqual([]);
    stack.close();
  });

  it("与 memory_evidence 工具是同一份数据 (两侧不分叉)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const entry = await seed(stack);
    const gw = gatewayWith({ facade: stack.facade });
    const viaPanel = (await gw.evidenceChain(entry.id)) as {
      episodeIds: string[];
      episodes: Array<{ id: string; text: string }>;
    };

    const reg: Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<string> }> = [];
    registerMemoryTools(
      { tools: { register: (t: { name: string }) => { reg.push(t as never); return () => {}; } } },
      { store: stack.store, generalizer: null as never, facade: stack.facade },
    );
    const viaTool = await reg.find((t) => t.name === "memory_evidence")!.execute({ id: entry.id });

    // 工具输出里的每一条原文都必须出现在面板返回的 episodes 里
    for (const ep of viaPanel.episodes) {
      expect(viaTool).toContain(ep.text);
    }
    expect(viaPanel.episodeIds.length).toBeGreaterThan(0);
    stack.close();
  });

  it("无血缘条目如实降级 (面板能看到原因, 而不是空白)", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const e = stack.store.add({ kind: "fact", content: "面板无血缘条目", source: "session:x", scope: "agent" });
    const gw = gatewayWith({ facade: stack.facade });
    const chain = (await gw.evidenceChain(e.id)) as { traceable: boolean; reasons: string[] };
    expect(chain.traceable).toBe(false);
    expect(chain.reasons.length).toBeGreaterThan(0);
    stack.close();
  });

  it("缺 facade 时返回错误对象 (不抛异常打爆面板)", async () => {
    const gw = gatewayWith({});
    const res = (await gw.evidenceChain("m1")) as { error?: string };
    expect(res.error).toContain("facade unavailable");
  });

  it("空 id 被挡下 (不拿空 id 去查库)", async () => {
    const gw = gatewayWith({});
    const res = (await gw.evidenceChain("  ")) as { error?: string };
    expect(res.error).toBeDefined();
  });

  it("不存在的 id 返回错误对象而非静默空", async () => {
    const stack = openMemoryStack(root, { episodeRetentionDays: 0, embedder: null });
    const gw = gatewayWith({ facade: stack.facade });
    const res = (await gw.evidenceChain("mNotExist")) as { error?: string };
    expect(res.error).toContain("no memory entry");
    stack.close();
  });
});
