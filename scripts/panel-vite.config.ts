// scripts/panel-vite.config.ts — 面板的 vite 配置 (暂存为 .tmp/panel/vite.config.ts)。
// base "./": 产物里全是相对引用, 经 HX-WebX 的 /proxy/<name>/ 访问不需要子路径适配层。
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react({ exclude: /node_modules\/(?!.*@hx\/ui\/)/ }), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
});
