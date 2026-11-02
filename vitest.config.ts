import { defineConfig } from "vitest/config";

/**
 * HX-Memory 接入 Agent Notes v2
 * .agents/notes/implemented/process/2026-10-08-repository-agent-notes-v2-adoption.md
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 文件写入通道覆盖文件时会在同目录留 .hark-bak/ 备份 (通道行为, 不是仓库内容); 备份里的旧 *.test.ts 不许当用例跑。
    exclude: ["**/node_modules/**", "**/.hark-bak/**"],
    environment: "node",
  },
});
