import { spawnSync } from "node:child_process";
const result = spawnSync("uv", ["run", ".agents/skills/hx-agent-notes/scripts/setup/new_note.py", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 2);
