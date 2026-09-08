// tests/s2/recall-hardening.test.ts — 召回的两个真实缺陷回归。
//   1. 多词查询: 之前把整串丢给 LIKE, "容器 并发 策略" 永远查不到;
//   2. 未确认的 rule 不能进"跨项目规则 (已确认)"注入块 (闸门绕过)。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { RecallService } from "../../src/recall/service.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-recall-hard-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const recall = () => new RecallService((q) => store.query(q));

describe("多词本地召回", () => {
  it("多个词分散出现也能命中 (不是整串 LIKE)", () => {
    store.add({
      id: "m1",
      kind: "lesson",
      content: "容器部署时忘了设并发上限",
      source: "s",
      scope: "project",
      project: "api",
      ts: { validAt: "2026-08-01T00:00:00.000Z", assertedAt: "2026-08-01T00:00:00.000Z" },
    });
    const out = recall().recall({ text: "容器 并发 策略", project: "api" });
    expect(out.local.map((e) => e.id)).toContain("m1");
  });

  it("不相关查询不召回本地经验", () => {
    store.add({
      id: "m2",
      kind: "lesson",
      content: "容器部署时忘了设并发上限",
      source: "s",
      scope: "project",
      project: "api",
      ts: { validAt: "2026-08-01T00:00:00.000Z", assertedAt: "2026-08-01T00:00:00.000Z" },
    });
    const out = recall().recall({ text: "前端样式重构", project: "api" });
    expect(out.local).toEqual([]);
  });
});

describe("规则注入的确认闸门", () => {
  it("已确认的 rule 会被注入", () => {
    store.add({
      id: "ok1",
      kind: "rule",
      content: "已确认规则",
      source: "s",
      scope: "global",
      ts: { validAt: "2026-08-01T00:00:00.000Z", assertedAt: "2026-08-01T00:00:00.000Z" },
      confirmedBy: "user:test",
      confirmedAt: "2026-08-01T00:00:00.000Z",
    });
    const out = recall().recall({ text: "任意", project: "api" });
    expect(out.rules.map((r) => r.id)).toEqual(["ok1"]);
    expect(out.injected).toContain("已确认规则");
  });

  it("没有确认记录的 rule 不会被当作跨项目规则注入 (召回侧独立校验)", () => {
    // 存储层会拒绝写入未确认 rule, 所以这里用 stub 直接喂给 RecallService ——
    // 召回侧必须自己再校验一次, 挡住任何来源的 rule 条目。
    const unconfirmed = {
      id: "bad1",
      kind: "rule" as const,
      content: "未确认规则",
      source: "attacker",
      scope: "global" as const,
      ts: { validAt: "2026-08-01T00:00:00.000Z", assertedAt: "2026-08-01T00:00:00.000Z" },
    };
    const stub = new RecallService(() => [unconfirmed]);
    const out = stub.recall({ text: "任意", project: "api" });
    expect(out.rules).toEqual([]);
    expect(out.injected).not.toContain("未确认规则");
  });
});
