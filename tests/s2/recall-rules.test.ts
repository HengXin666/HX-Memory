// tests/s2/recall-rules.test.ts — S2: 召回服务接真实存储, 验证跨项目规则生效。
// 自证场景: 项目 A 确认的规则, 在项目 B 的新会话里被召回 (泛化的真正价值)。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";
import { RecallService } from "../../src/recall/service.ts";

let root: string;
let store: FileBackend;
let pipe: CapturePipeline;
let generalizer: GeneralizerService;
let recall: RecallService;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hxmem-r6-"));
  store = new FileBackend({ root });
  pipe = new CapturePipeline(store);
  generalizer = new GeneralizerService(store, join(root, "review"));
  recall = new RecallService((q) => store.query(q));

  // 项目 A: 并发事故 → lesson ×2
  await pipe.run({ text: "踩坑: 后端队列并发丢消息", session: "A1", project: "projA" });
  await pipe.run({ text: "踩坑: 网关并发竞态丢请求", session: "A2", project: "projA" });
  // 项目 A 还有一个无关 lesson
  await pipe.run({ text: "踩坑: 部署忘了健康检查", session: "A3", project: "projA" });
  // 推广 + 人工确认 → 全局规则
  const lessons = store.query({ kind: "lesson" });
  const proposals = await generalizer.runBatch("s6-1", lessons);
  const concurrency = proposals.find((p) => p.proposal.covers.length >= 2)!;
  generalizer.confirm(concurrency.id, "user:hengxin");
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("RecallService + FileBackend: 跨项目规则生效", () => {
  it("项目 B 的新会话召回全局并发规则", () => {
    const out = recall.recall({ text: "容器 并发 策略", project: "projB" });
    const rule = out.rules.find((r) => r.kind === "rule" && r.scope === "global");
    expect(rule).toBeTruthy();
    expect(rule!.confirmedBy).toBe("user:hengxin");
    expect(out.injected).toContain("跨项目规则");
    expect(out.injected).toContain(rule!.id);
  });

  it("项目 B 不召回项目 A 的本地经验", () => {
    const out = recall.recall({ text: "健康检查", project: "projB" });
    expect(out.local.some((e) => e.content.includes("健康检查"))).toBe(false);
  });

  it("项目 A 的本地经验只在 A 内被召回", () => {
    const out = recall.recall({ text: "健康检查", project: "projA" });
    expect(out.local.some((e) => e.content.includes("健康检查"))).toBe(true);
  });
});
