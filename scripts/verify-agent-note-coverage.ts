/** Compatibility CLI: execute the strict v2 graph. Historical fixture helpers have no gate authority. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runGate } from "../.agents/skills/hx-agent-notes/scripts/redline/run.ts";
/**
 * Agent Note 沉淀流 (硬约束的方案记录)
 * .agents/notes/implemented/process/2026-09-10-agent-note-sedimentation-flow.md
 */
export { classifyChange, type CoverageVerdict } from "./lib/legacy-note-coverage.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGate([...process.argv.slice(2)]);
}
