// scripts/verify-client-contract.ts — 面板渲染的字段, 服务端**必须提供**。
//
// 为什么需要它 (2026-09-18, §568): §565 修了一个缺陷 —— 面板渲染 `{b.content}`,
// 而服务端投影层**硬编码了 `content: ""`**。**类型上它合法** (`content: string`),
// 所以 tsc 不报错, 测试也没覆盖到 —— 而**用户只看到空白**。
//
// 这类缺陷的共同形态是: **客户端读一个字段, 而服务端没给/给了占位值**。
// tsc 挡不住 (两侧类型是各自声明的), 所以需要一道**跨层检查**:
//
//   ① 从客户端源码抽出它渲染的字段 (`{x.field}`);
//   ② 在**全服务端面** (src/adapters + src/app) 里找该字段的声明 (`field: T` / `field?: T`);
//   ③ 找不到 ⇒ 该字段**没有任何服务端来源** ⇒ 面板会渲染 undefined。
//
// ⚠ **它抓不到"字段存在但值恒为空串"** (那是 §565 的具体形态, 由测试锁住:
// tests/s2/always-on-blocked-content.test.ts)。本脚本覆盖的是**更粗也更常见**的一类:
// 客户端读了一个服务端根本没有的字段。
//
// 用法: node --experimental-strip-types scripts/verify-client-contract.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLIENT = join(ROOT, "src", "adapters", "dsh", "client");

/** 客户端渲染的字段: `{x.field}` (x 是任意单字母局部变量, 沿用面板的惯例)。 */
function renderedFields(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(CLIENT)) {
    if (!f.endsWith(".tsx")) continue;
    const text = readFileSync(join(CLIENT, f), "utf8");
    for (const m of text.matchAll(/\{[a-z]\.([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
      const field = m[1]!;
      out.set(field, [...(out.get(field) ?? []), f]);
    }
  }
  return out;
}

/** 服务端面 (adapters + app) 的全部源码。 */
function serverSources(): string {
  const dirs = [join(ROOT, "src", "adapters"), join(ROOT, "src", "app")];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "client") continue; // 客户端自己的类型不算服务端来源
        walk(p);
      } else if (entry.endsWith(".ts")) {
        out.push(readFileSync(p, "utf8"));
      }
    }
  };
  for (const d of dirs) walk(d);
  return out.join("\n");
}

const fields = renderedFields();
const server = serverSources();
const violations: string[] = [];
for (const [field, files] of fields) {
  // 声明形态: "field:" / "field?:" (含缩进与行首)
  const declared = new RegExp("\\b" + field + "\\s*[?:]").test(server);
  if (!declared) {
    violations.push(
      "客户端契约: 面板渲染 {" + files[0]!.replace(/\.tsx$/, "") + "} 里的字段 \"" + field +
        "\", 但**全服务端面 (src/adapters + src/app) 没有任何声明** —— 面板会渲染 undefined",
    );
  }
}

if (violations.length) {
  console.error("verify-client-contract: 发现 " + violations.length + " 处跨层字段缺失:");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(
  "verify-client-contract: " + fields.size + " 个面板字段全部有服务端声明 (" +
    relative(ROOT, CLIENT) + ")",
);
