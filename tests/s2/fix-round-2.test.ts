// tests/s2/fix-round-2.test.ts — FIX-ROUND-2 / BLIND-AUDIT-2 指出「新代码零单测」的补测:
//   选型严格门限 (choose)、M2 引用核对判据 (judge)、嵌入配置来源 (embedding-config)、面板后端模块在 strip-only 下可加载。
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { choose, type CandidateResult } from "../../scripts/eval/train-frustration.ts";
import { judge, parseAt } from "../../scripts/lib/m2-judge.ts";
import { decryptSecret, embedderFromConfig, embeddingSource, encryptSecret } from "../../src/app/embedding-config.ts";

const cand = (id: string, recall: number, fpr: number, reg: { pass: number; total: number; lostVsA?: string[] }, lo = fpr - 0.03, hi = fpr + 0.04): CandidateResult => ({
  id, name: id, complexity: 1, tp: 0, fn: 0, fp: 0, tn: 0, recall, fpr, recallCI: [0, 1],
  boot: { recall: [0, 1], fpr: [lo, hi] } as never, features: null,
  regression: { pass: reg.pass, total: reg.total, hits: [], failed: [], lostVsA: reg.lostVsA ?? [] }, preds: [],
});

describe("choose: 严格门限 (FPR 点估计 > 0.05 即淘汰, 区间不豁免)", () => {
  it("区间覆盖 0.05 但点估计 0.083 的候选被淘汰 (BLIND-AUDIT 第 3 条的 E)", () => {
    const r = choose([cand("A", 0.269, 0.042, { pass: 15, total: 15 }), cand("E", 0.442, 0.083, { pass: 15, total: 15 }, 0.046, 0.133)]);
    expect(r.id).toBe("A");
    expect(r.qualified).toBe(true);
    expect(r.excluded.join(" ")).toContain("E (FPR 点估计 0.083 > 0.05");
  });
  it("全部淘汰时写「无候选达标」并回退 A, qualified=false", () => {
    const r = choose([cand("A", 0.3, 0.06, { pass: 15, total: 15 }), cand("B", 0.4, 0.07, { pass: 15, total: 15 })]);
    expect(r.qualified).toBe(false);
    expect(r.id).toBe("A");
    expect(r.why).toContain("无候选达标");
  });
  it("回归句少于 A 的候选即使 FPR 合格也淘汰", () => {
    const r = choose([cand("A", 0.2, 0.04, { pass: 15, total: 15 }), cand("D", 0.25, 0.049, { pass: 2, total: 15, lostVsA: ["r01"] })]);
    expect(r.id).toBe("A");
  });
});

describe("M2 judge: 引用核对判据", () => {
  it("回答复述用户原话不算用上记忆 (严格口径去掉用户消息里的词项)", () => {
    const entry = "部署之前必须先跑回归测试并且检查迁移脚本";
    const user = "部署之前必须先跑回归测试并且检查迁移脚本吗";
    const ans = "是的，部署之前必须先跑回归测试并且检查迁移脚本。";
    expect(judge(entry, ans, user).strict).toBe(false);
    expect(judge(entry, ans, user).loose).toBe(true);
  });
  it("回答用上了用户没说过的记忆内容 → 严格命中", () => {
    const entry = "派生索引必须可以从真相文件全量重建";
    expect(judge(entry, "按约定，派生索引必须可以从真相文件全量重建，所以先删索引再重建。", "索引坏了怎么办").strict).toBe(true);
  });
  it("账本时间格式解析到分钟", () => {
    expect(new Date(parseAt("Sun 2026-10-11 2:49 PM CST (UTC+08:00)")).toISOString()).toBe("2026-10-11T06:49:00.000Z");
  });
});

describe("embedding-config: 来源优先级与密钥", () => {
  const dir = mkdtempSync(join(tmpdir(), "hx-emb-cfg-"));
  it("环境变量优先于面板配置", () => {
    writeFileSync(join(dir, "panel.json"), JSON.stringify({ embedding: { baseUrl: "http://127.0.0.1:1/v1", model: "panel-m", keyMode: "none" } }));
    const s = embeddingSource({ HX_MEMORY_EMBEDDING_BASE_URL: "http://e/v1", HX_MEMORY_EMBEDDING_MODEL: "env-m" }, dir);
    expect(s.source).toBe("env");
    expect(s.model).toBe("env-m");
  });
  it("没有环境变量时读面板 embedding 段, 加密 key 能解开", () => {
    const env = { HX_PANEL_SECRET: "test-secret" };
    process.env.HX_PANEL_SECRET = "test-secret";
    const enc = encryptSecret("sk-abc123", dir);
    expect(decryptSecret(enc, dir)).toBe("sk-abc123");
    writeFileSync(join(dir, "panel.json"), JSON.stringify({ embedding: { baseUrl: "http://127.0.0.1:4399/v1", model: "Qwen3-Embedding-0.6B", keyMode: "encrypted", keyEnc: enc } }));
    const s = embeddingSource(env, dir);
    expect(s).toMatchObject({ source: "panel", model: "Qwen3-Embedding-0.6B", key: "sk-abc123" });
    expect(embedderFromConfig(env, dir)).not.toBeNull();
    delete process.env.HX_PANEL_SECRET;
  });
  it("都没配 → none, 不造嵌入器; vitest 下默认不读本机面板配置", () => {
    expect(embeddingSource({}, mkdtempSync(join(tmpdir(), "hx-emb-empty-"))).source).toBe("none");
    expect(embeddingSource({ VITEST: "1" }).source).toBe("none");
  });
});

describe("面板后端模块在 Node strip-only 下可加载 (FIX-ROUND-2 拆分时踩过: 类型名必须 import type)", () => {
  it("panel-ctx/state/kb/hooks/detect/model 逐个 import 不报错", () => {
    const mods = ["ctx", "state", "kb", "hooks", "detect", "model"].map((m) => `await import("./scripts/panel-${m}.ts");`).join("");
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", mods + "console.log('ok')"], { cwd: join(import.meta.dirname, "../.."), encoding: "utf8", env: { ...process.env, HX_PANEL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "hx-panel-cfg-")) } });
    expect(out.trim()).toBe("ok");
  });
});

describe("capture-check: 只读体检的退出码", () => {
  const run = (args: string[], env: Record<string, string>) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/capture-check.ts", ...args], { cwd: join(import.meta.dirname, "../.."), encoding: "utf8", env: { ...process.env, ...env } }) };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { code: x.status, out: String(x.stdout) + String(x.stderr) };
    }
  };
  it("插件未选入 → 3 (用户关闭, 不是故障)", () => {
    const home = mkdtempSync(join(tmpdir(), "hx-cc-home-"));
    const root = mkdtempSync(join(tmpdir(), "hx-cc-root-"));
    execFileSync("mkdir", ["-p", join(home, "profiles", "web")]);
    writeFileSync(join(home, "profiles", "web", "package.json"), JSON.stringify({ dependencies: { "@hengxin666/hx-memory": "link:." }, dsh: { profile: { bundles: [] } } }));
    const r = run(["--root", root], { DSH_HOME: home });
    expect(r.code).toBe(3);
    expect(r.out).toContain("未选入");
  });
  it("找不到 profile → 2", () => {
    const r = run(["--root", mkdtempSync(join(tmpdir(), "hx-cc-root-"))], { DSH_HOME: mkdtempSync(join(tmpdir(), "hx-cc-empty-")) });
    expect(r.code).toBe(2);
  });
});
