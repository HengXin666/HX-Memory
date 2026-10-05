// tests/s3/truth-files.test.ts — 真相文件视图的服务端契约 (§795)。
//
// 为什么需要它: ADR-002 承诺"真相在 Markdown 文件, 索引可重建" —— 而面板此前**每个视图都经
// SQLite**。这两个端点是"真相在人侧可见"的唯一入口, 因此它们的**边界**必须被钉住:
//
// | 契约 | 若失去它 |
// | --- | --- |
// | 只列/只读 {daily,digest,rules} 下的 .md | 目录穿越 —— 面板能读任意文件 |
// | `..` / 绝对路径被拒 | 同上 (而且是最直接的那种) |
// | 未挂载时返回空数组而非抛错 | 面板在没有 truthFiles 依赖的环境里会崩 |
// | 读不到时返回 null 且**不区分**原因 | 区分"不存在"与"不允许" = 泄露路径存在性 |
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTruthFiles, readTruthFile } from "../../src/adapters/dsh/truth-files.ts";
import { HxMemoryGateway } from "../../src/adapters/dsh/gateway.ts";

/** 造一个只有真相文件的 root。 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "truthview-"));
  for (const d of ["daily", "digest", "rules"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "2026-09-20.md"), "# " + d + " 的正文\n\n条目一");
  }
  // 非真相目录 + 非 .md: 都不该出现。
  mkdirSync(join(root, "episodes"), { recursive: true });
  writeFileSync(join(root, "episodes", "x.jsonl"), "{}");
  mkdirSync(join(root, "schedule"), { recursive: true });
  writeFileSync(join(root, "schedule", "y.jsonl"), "{}");
  // 一个"看起来像 .md 但不在白名单目录"的文件。
  writeFileSync(join(root, "secret.md"), "不该被列到");
  return root;
}

describe("真相文件视图: 列举与读取的边界", () => {
  it("**只列白名单目录下的 .md** (episodes/schedule/根下的都被挡)", () => {
    const root = fixture();
    try {
      const paths = listTruthFiles(root).map((f) => f.path);
      expect(paths).toContain("daily/2026-09-20.md");
      expect(paths).toContain("digest/2026-09-20.md");
      expect(paths).toContain("rules/2026-09-20.md");
      expect(paths, "非真相目录不该出现").not.toContain("episodes/x.jsonl");
      expect(paths, "根下的 .md 不该出现 (不在白名单目录)").not.toContain("secret.md");
      expect(paths.every((p) => p.endsWith(".md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("**单目录过滤生效** (非法目录名退回全部, 而不是报错)", () => {
    const root = fixture();
    try {
      expect(listTruthFiles(root, "digest").every((f) => f.dir === "digest")).toBe(true);
      expect(listTruthFiles(root, "../etc").length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("### 负例: **目录穿越被拒** (`..` / 绝对路径 / 白名单外目录)", () => {
    const root = fixture();
    try {
      expect(readTruthFile(root, "../../etc/passwd")).toBeNull();
      expect(readTruthFile(root, "digest/../../etc/passwd")).toBeNull();
      expect(readTruthFile(root, "/etc/passwd")).toBeNull();
      expect(readTruthFile(root, "secret.md")).toBeNull();
      expect(readTruthFile(root, "episodes/x.jsonl")).toBeNull();
      expect(readTruthFile(root, "daily/../digest/2026-09-20.md")).toBeNull();
      // 而合法的读得到。
      expect(readTruthFile(root, "digest/2026-09-20.md")?.text).toContain("digest 的正文");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("### 负例: **未挂载 truthFiles 依赖时返回空/null 而不抛**", () => {
    const gw = Object.create(HxMemoryGateway.prototype) as Record<string, unknown>;
    gw.deps = {};
    expect((gw.truthFiles as () => unknown)()).toEqual([]);
    expect((gw.truthFile as (p: string) => unknown)("digest/x.md")).toBeNull();
  });

  it("### 负例: **符号链接穿不出 root** (§795 实测缺口 —— 唯一 load-bearing 的一条)**", () => {
    // 为什么这条必须单独测: 上面那三条 (白名单目录 / name 校验 / normalize) **都不是**
    // load-bearing —— 逐条拆掉它们测试仍绿 (因为彼此冗余)。而 \`normalize\` **不解析 symlink**:
    // 在 digest/ 下放 \`leak.md -> /tmp/outside.md\`, 前三层全部通过, 而 readFileSync
    // 会真的把外部文件读出来 (实测读到 OUTSIDE-SECRET)。⇒ 只有 realpath 那一条能挡住它。
    const root = mkdtempSync(join(tmpdir(), "truthsym-"));
    const outside = mkdtempSync(join(tmpdir(), "truthsecret-"));
    try {
      writeFileSync(join(outside, "leak.md"), "OUTSIDE-SECRET");
      mkdirSync(join(root, "digest"), { recursive: true });
      writeFileSync(join(root, "digest", "ok.md"), "inside");
      symlinkSync(join(outside, "leak.md"), join(root, "digest", "leak.md"));
      symlinkSync(outside, join(root, "digest", "link"));
      expect(readTruthFile(root, "digest/leak.md"), "指向外部的符号链接不该被读到").toBeNull();
      expect(readTruthFile(root, "digest/link/leak.md")).toBeNull();
      // 而库内的正常文件仍读得到 (防护不过宽)。
      expect(readTruthFile(root, "digest/ok.md")?.text).toBe("inside");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

});