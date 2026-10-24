/** Compatibility CLI: execute the strict v2 graph. Historical fixture helpers have no gate authority. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../.agents/skills/hx-agent-notes/scripts/redline/run.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGate(["--all", ...process.argv.slice(2)]);
}
