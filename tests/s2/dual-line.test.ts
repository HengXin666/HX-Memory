// tests/s2/dual-line.test.ts — S2: 双线对照 (用户要求的核心测试)。
// 同一份记忆库, 同一条已确认规则, 两种接入方式:
//  旧线 (ReMe/传统): session-start 注入指引 + memory_search 工具 → 召回靠模型自觉。
//  新线 (VCP 式):    项目声明绑定 + 预步确定性注入 → 召回靠代码判定, 与模型自觉无关。
// 证明: 记忆库里有规则时, 新线保证注入; 旧线则取决于"模型会不会调工具"。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { RecallService } from "../../src/recall/service.ts";
import { Binder, type BindingConfig } from "../../src/kernel/binder.ts";

let root: string;
let store: FileBackend;
let ruleId: string;

// 一条已确认的跨项目规则: "所有容器都要显式设计并发上限"
function addRule(content: string) {
  const id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  store.add({
    id,
    kind: "rule",
    content,
    source: "generalizer:t",
    scope: "global",
    ts: { validAt: "2026-01-01T00:00:00.000Z", assertedAt: "2026-01-01T00:00:00.000Z" },
    confirmedBy: "u",
    confirmedAt: "t",
  });
  return id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hxmem-2line-"));
  store = new FileBackend({ root });
  ruleId = addRule("所有容器都要显式设计并发上限");
  await new Promise((r) => setTimeout(r, 20)); // 等索引
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("旧线 (靠模型自觉调 memory_search 工具)", () => {
  // 模拟: 模型并非每次都想起来调工具 (有 p 的概率记得)。这是旧线的固有概率性。
  function oldLineTurn(rememberToSearch: boolean, text: string): string {
    const recall = new RecallService((q) => store.query(q));
    if (!rememberToSearch) return "（模型未调工具, 直接作答）";
    return recall.recall({ text, limit: 5 }).injected;
  }

  it("规则在库中, 但模型若不调工具 → 规则不进上下文 (召回率 < 100%)", () => {
    // 模型"记得调工具"的概率假设为 60% → 4/10 会漏
    const turns = Array.from({ length: 10 }, (_, i) =>
      oldLineTurn(i % 5 < 3, "帮我部署一个容器上线"),
    ); // 10 轮里 6 轮调, 4 轮没调
    const recalled = turns.filter((t) => t.includes("并发上限")).length;
    expect(recalled).toBeLessThan(10); // 旧线无法保证 100%
    expect(recalled).toBe(6); // 恰好只有调的 6 轮拿到规则
  });

  it("对照: 工具本身能查到规则 (说明规则在库、旧线仅差在触发概率)", () => {
    const recall = new RecallService((q) => store.query(q));
    const out = recall.recall({ text: "部署一个容器", limit: 5 });
    expect(out.injected).toContain("并发上限");
  });
});

describe("新线 (VCP 式: 项目声明绑定 + 确定性注入)", () => {
  const configs: BindingConfig[] = [
    {
      project: "proj-web",
      bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
    },
  ];
  const binder = new Binder(
    (q) => store.query(q),
    () => configs,
  );

  it("规则在库中, 项目有绑定 → 每一轮 100% 注入 (无论模型行为)", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      binder.injectFor("proj-web", "帮我部署一个容器上线 #" + i),
    );
    const injected = turns.filter((t) => t.includes("并发上限")).length;
    expect(injected).toBe(10); // 新线确定性: 10/10
  });

  it("绑定注入发生在模型思考之前 (pre-step), 不依赖任何模型决策", () => {
    const preStepInjected = binder.injectFor("proj-web", "上线新服务");
    const fullContext = "【系统】相关跨项目规则:\n" + preStepInjected;
    expect(fullContext).toContain("并发上限");
  });

  it("未声明绑定的项目 → 零注入 (不污染无关会话)", () => {
    expect(binder.injectFor("other-proj", "部署容器")).toBe("");
  });
});
