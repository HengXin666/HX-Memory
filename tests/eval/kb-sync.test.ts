// tests/eval/kb-sync.test.ts — 知识库同步器 (src/kb/kb-sync.ts) 的行为: 增、改、删、缩、冲突、幂等、轮询延迟。
// 存储用真的 openMemoryStack (FileBackend + FTS), 检索用 store.searchText, 与 K4 脚本同一口径。
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStack, type MemoryStack } from "../../src/app/stack.ts";
import { KbSync, kbNamespace, kbSourceNamespace, sliceMarkdown } from "../../src/kb/kb-sync.ts";

const tmp: string[] = [];
const stacks: MemoryStack[] = [];
afterEach(() => {
  for (const s of stacks.splice(0)) s.close();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig() {
  const blog = mkdtempSync(join(tmpdir(), "kb-src-"));
  const mem = mkdtempSync(join(tmpdir(), "kb-mem-"));
  tmp.push(blog, mem);
  for (const d of ["blog", "ai-docs", "docs", "docs/.hark-bak"]) mkdirSync(join(blog, d), { recursive: true });
  const stack = openMemoryStack(mem, { episodeRetentionDays: 0, embedder: null });
  stacks.push(stack);
  const sync = new KbSync({ store: stack.store as never, root: blog });
  const write = (rel: string, text: string) => writeFileSync(join(blog, rel), text);
  const find = (q: string) => stack.store.searchText(q, 20).filter((e) => e.kind === "doc");
  const docs = () => stack.store.all().filter((e) => e.kind === "doc" && e.status !== "shadow");
  return { blog, stack, sync, write, find, docs };
}

const doc = (hxid: string, title: string, sections: string[]) =>
  `---\nhxid: ${hxid}\ntitle: "${title}"\ntags: ["t1"]\n---\n\n开头一段。\n\n` + sections.map((s) => `## ${s}\n\n${s} 的正文 内容。`).join("\n\n");

describe("sliceMarkdown", () => {
  it("按 ## 切, id = hxid-sN, 标题带小节 (J2.4)", () => {
    const { slices } = sliceMarkdown(doc("abc", "标题", ["安装", "配置"]), "blog/a.md");
    expect(slices.map((s) => s.id)).toEqual(["abc-s0", "abc-s1", "abc-s2"]);
    expect(slices[1]!.body.startsWith("# 标题 / 安装")).toBe(true);
    expect(slices[1]!.heading).toBe("安装");
  });
  it("没有 hxid 时用路径派生的稳定 id", () => {
    const a = sliceMarkdown("# x\n\n正文", "docs/x.md").slices[0]!.id;
    expect(a).toBe(sliceMarkdown("# x\n\n别的正文", "docs/x.md").slices[0]!.id);
  });
});

describe("KbSync.syncOnce", () => {
  it("新增 → 可检索; 第二轮幂等 (0 写)", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.write("docs/b.md", doc("bbb", "乙文", ["铁观音"]));
    const first = r.sync.syncOnce();
    expect(first.files).toBe(2);
    expect(first.added).toBe(4);
    expect(r.find("紫藤萝").some((e) => e.id === "aaa-s1")).toBe(true);
    const second = r.sync.syncOnce();
    expect([second.added, second.updated, second.removed]).toEqual([0, 0, 0]);
    expect(second.unchanged).toBe(4);
  });

  it("修改 → 新内容可检索, 旧内容不再命中", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.sync.syncOnce();
    r.write("blog/a.md", doc("aaa", "甲文", ["白玉兰"]));
    const rep = r.sync.syncOnce();
    expect(rep.updated).toBeGreaterThan(0);
    expect(r.find("白玉兰").length).toBeGreaterThan(0);
    expect(r.find("紫藤萝").length).toBe(0);
  });

  it("删除文件 → 它的切片 0 残留 (K4 删除口径)", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.write("blog/b.md", doc("bbb", "乙文", ["铁观音"]));
    r.sync.syncOnce();
    unlinkSync(join(r.blog, "blog/a.md"));
    const rep = r.sync.syncOnce();
    expect(rep.removed).toBe(2);
    expect(r.find("紫藤萝").length).toBe(0);
    expect(r.docs().every((e) => !String(e.source).includes("blog/a.md"))).toBe(true);
  });

  it("文件变短 → 多出的切片被移除 (kb-index.ts 不会删)", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["一", "二", "三"]));
    r.sync.syncOnce();
    r.write("blog/a.md", doc("aaa", "甲文", ["一"]));
    const rep = r.sync.syncOnce();
    expect(rep.removed).toBe(2);
    expect(r.docs().map((e) => e.id).sort()).toEqual(["aaa-s0", "aaa-s1"]);
  });

  it("删除后恢复同一文件 → 重新可检索", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.sync.syncOnce();
    unlinkSync(join(r.blog, "blog/a.md"));
    r.sync.syncOnce();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.sync.syncOnce();
    expect(r.find("紫藤萝").length).toBeGreaterThan(0);
  });

  it("hxid 冲突 → 两篇都在库里, 并记 warning", () => {
    const r = rig();
    r.write("blog/a.md", doc("dup", "甲文", ["紫藤萝"]));
    r.write("blog/b.md", doc("dup", "乙文", ["铁观音"]));
    const rep = r.sync.syncOnce();
    expect(rep.warnings.some((w) => w.includes("hxid dup"))).toBe(true);
    expect(r.find("紫藤萝").length).toBeGreaterThan(0);
    expect(r.find("铁观音").length).toBeGreaterThan(0);
  });

  it("空正文进失败清单; 隐藏目录跳过 (K3 口径)", () => {
    const r = rig();
    r.write("docs/empty.md", "---\ntitle: x\n---\n\n");
    r.write("docs/.hark-bak/old.md", doc("old", "旧", ["备份"]));
    const rep = r.sync.syncOnce();
    expect(rep.files).toBe(1);
    expect(rep.failed).toEqual([{ file: "docs/empty.md", reason: "空正文 (没有可切的内容)" }]);
  });

  it("只写 kind: doc 条目 (J2.5)", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.sync.syncOnce();
    expect(r.stack.store.all().every((e) => e.kind === "doc")).toBe(true);
  });
});

describe("KbSync 命名空间 (面板增量路径不许删主语料)", () => {
  it("同步第二个根 → 主语料 0 删除; 第二个根删文件 → 只删它自己的切片", () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    const main = r.sync.syncOnce();
    const extra = mkdtempSync(join(tmpdir(), "kb-extra-"));
    tmp.push(extra);
    mkdirSync(join(extra, "notes"), { recursive: true });
    // 与主语料同一个相对路径、同一个 hxid: 命名空间之前这会互相覆盖
    writeFileSync(join(extra, "notes/a.md"), doc("aaa", "外部", ["碧螺春"]));
    writeFileSync(join(extra, "notes/b.md"), doc("bbb", "外部二", ["大红袍"]));
    const ns = kbNamespace(extra);
    const side = new KbSync({ store: r.stack.store as never, root: extra, dirs: ["notes"], namespace: ns });
    const rep = side.syncOnce();
    expect(rep.removed).toBe(0);
    expect(rep.added).toBeGreaterThan(0);
    expect(r.find("紫藤萝").length).toBeGreaterThan(0);
    expect(r.find("碧螺春").length).toBeGreaterThan(0);
    // 主语料再同步一轮: 不认识 @ns 条目, 也不删它们
    const again = r.sync.syncOnce();
    expect(again.removed).toBe(0);
    expect(again.added + again.updated).toBe(0);
    expect(r.find("碧螺春").length).toBeGreaterThan(0);
    unlinkSync(join(extra, "notes/b.md"));
    const del = side.syncOnce();
    expect(del.removed).toBeGreaterThan(0);
    expect(r.find("大红袍").length).toBe(0);
    expect(r.find("紫藤萝").length).toBeGreaterThan(0);
    expect(main.added).toBeGreaterThan(0);
  });

  it("source 编码可逆; 主语料 source 不变 (向后兼容)", () => {
    expect(kbSourceNamespace("kb:blog/a.md")).toEqual({ ns: "", file: "blog/a.md" });
    expect(kbSourceNamespace("kb:@r0123456789/notes/a.md")).toEqual({ ns: "r0123456789", file: "notes/a.md" });
    expect(kbSourceNamespace("session:x")).toBeNull();
    expect(kbNamespace("/a/b/")).toBe(kbNamespace("/a/b"));
  });
});

describe("KbSync.start (轮询)", () => {
  it("改动在若干个轮询间隔内可检索", async () => {
    const r = rig();
    r.write("blog/a.md", doc("aaa", "甲文", ["紫藤萝"]));
    r.sync.start(30);
    try {
      r.write("blog/c.md", doc("ccc", "丙文", ["龙井茶"]));
      const t0 = Date.now();
      while (!r.find("龙井茶").length && Date.now() - t0 < 3000) await new Promise((ok) => setTimeout(ok, 20));
      expect(r.find("龙井茶").length).toBeGreaterThan(0);
    } finally {
      r.sync.stop();
    }
  });
});
