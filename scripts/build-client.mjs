// scripts/build-client.mjs — 把 DSH Web client (TSX) 打成 host 可加载包。
// 产出 dist/dsh/client.js, 用 window.__ModuleLoader__.load 包装 (仿 ReMe)。
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/dsh/client.js");
const temporary = resolve(root, "dist/dsh/client.bundle.cjs");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/adapters/dsh/client/index.tsx")],
  outfile: temporary,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  sourcemap: false,
  logLevel: "info",
});
const body = await readFile(temporary, "utf8");
const wrapped = `window.__ModuleLoader__.load({
  id: "@hx/hx-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
    return module.exports;
  }
});
`;
await writeFile(output, wrapped);
await unlink(temporary);
console.log("client bundle ->", output);
