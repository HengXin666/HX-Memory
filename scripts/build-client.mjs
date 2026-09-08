// scripts/build-client.mjs — 把 DSH Web client (TSX) 打成 host 可加载包。
// 产出 dist/dsh/client.js: 模块 id 由 package.json 的 name 派生 (见 lib/wrap-client-bundle.mjs),
// 与宿主 dsh-client-modules 的 boot graph 行 id 必须逐字相等。
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { wrapClientBundle } from "./lib/wrap-client-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist/dsh/client.js");
const temporary = resolve(root, "dist/dsh/client.bundle.cjs");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

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
await writeFile(output, wrapClientBundle({ body, packageName: manifest.name }), "utf8");
await unlink(temporary);
console.log("client bundle ->", output, "(module id:", manifest.name + ")");
