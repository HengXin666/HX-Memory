// scripts/purge-secrets.ts — 从记忆库里**撤回**含明文凭据的条目 (一次性治理脚本)。
//
// ## 为什么需要它 (2026-10-05 真库审计发现)
//
// 真库实测有 **5 条**含明文凭据的条目, 其中 2 条是 API Key:
//   · `https://freebuff.woa.qzz.io  sk-fb-1c077e713e7e40709ac5ea6b7…` (context)
//   · `freebuff 远程站点 … 的 API Key = sk-fb-…` (fact)
//   · `pw=qq282000500` (context)
//   · `使用 W@daodun666 作为解压密码` (context)
//   · `loli 的密码为 qq282000500` (context)
//
// 它们会被注入上下文、被检索返回、被面板展示、被 git 提交 (真相是 Markdown)。
// 捕获侧的**写入闸门**已加上 (kernel/secret-shape.ts), 但那只拦新的  存量必须单独治理。
//
// ## 为什么用 shadow 而不是物理删除
//
// 与全仓的治理价值观一致 (`remove()` 写 `status: shadow`, 撤回持久且重建不复活)。
// 但**凭据是例外情形**: shadow 只让检索不再返回它, **正文仍在 Markdown 文件里** 
// 对"密码已泄漏"这件事, 留在文件里等于没处理。因此本脚本提供两档:
//   · 默认 `shadow`   与治理价值观一致 (可审计、可复原);
//   · `--delete`      真删块 (仅当用户明确要求"把凭据从仓库里拿掉"时)。
// 两档都会先打印清单, 且**必须显式 `--apply`** 才写盘。
//
// ## 用法
//
//   node --experimental-strip-types scripts/purge-secrets.ts --root <memRoot>              # 只列 (dry-run)
//   node --experimental-strip-types scripts/purge-secrets.ts --root <memRoot> --apply
//   node --experimental-strip-types scripts/purge-secrets.ts --root <memRoot> --apply --delete
import { detectSecret } from "../src/kernel/secret-shape.ts";
import { FileBackend } from "../src/storage/file-store.ts";

interface Flags {
  root: string;
  apply: boolean;
  delete: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = get("--root") ?? process.env.HX_MEMORY_ROOT;
  if (!root) {
    console.error("用法: purge-secrets.ts --root <memRoot> [--apply] [--delete]");
    process.exit(2);
  }
  return { root, apply: argv.includes("--apply"), delete: argv.includes("--delete") };
}

const flags = parseFlags(process.argv.slice(2));
const store = new FileBackend({ root: flags.root, allowTruthDelete: flags.delete });
const all = await store.all();
const hits = all.filter((e) => detectSecret(e.content).isSecret);

if (!hits.length) {
  console.log("purge-secrets: 没有发现可撤回的凭据条目。");
  process.exit(0);
}

console.log("发现 " + hits.length + " 条含凭据的条目:");
for (const e of hits) {
  const v = detectSecret(e.content);
  // ⚠ 打印时**打码**: 这个脚本的输出会被人贴到对话/issue 里, 明文回显等于二次泄漏。
  const masked = e.content.slice(0, 40).replace(/[A-Za-z0-9_-]{6,}/g, (m) => m.slice(0, 3) + "***");
  console.log("  " + e.id + " [" + e.kind + "] " + JSON.stringify(masked) + "\n     依据: " + v.reason);
}

if (!flags.apply) {
  console.log("\n(dry-run) 加 --apply 才会写盘。默认走 shadow (写入 status: shadow, 保留可审计记录);");
  console.log("        加 --delete 则真删块  对'凭据已泄漏'这件事, 文件里留着正文等于没处理。");
  process.exit(0);
}

for (const e of hits) store.remove(e.id);
console.log(
  "\npurge-secrets: 已处理 " + hits.length + " 条 (" + (flags.delete ? "物理删除块" : "写入 shadow") + ")。",
);
