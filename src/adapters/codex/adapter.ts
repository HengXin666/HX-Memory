// src/adapters/codex/adapter.ts — Codex harness 适配器。
// 实现 kernel 的 HarnessAdapter 端口 (name:"codex")。Codex 是 CLI harness,
// 持久记忆载体是仓库根 AGENTS.md。职责:
//   - onSessionStart: 同步跨项目规则进 AGENTS.md (让新会话自动带上)
//   - onTurnEnd: 捕获完成的 turn (落 review 队列/记忆)
//   - registerTools: 暴露 memory_search / memory_rule_propose 等 CLI 子命令
// 注意: 不 import 任何 DSH 依赖 — 保持 harness 可插拔。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import type { HarnessAdapter, TurnData, Recall, SessionContext } from "../../kernel/ports.ts";
import type { MemoryEntry, GeneralizationProposal } from "../../kernel/types.ts";
import type { FileBackend } from "../../storage/file-store.ts";
import { RecallService } from "../../recall/service.ts";
import { EMPTY_MARKER, START, updateAgentsMd } from "./agents-md.ts";

export interface CodexAdapterOptions {
  store: FileBackend;
  /** 仓库根 (AGENTS.md 所在)。 */
  repoRoot: string;
  /** AGENTS.md 相对/绝对路径, 默认 repoRoot/AGENTS.md。 */
  agentsPath?: string;
  language?: "zh" | "en";
}

export class CodexAdapter implements HarnessAdapter {
  readonly name = "codex" as const;
  private readonly recall: RecallService;
  private readonly agentsPath: string;
  // 不用参数属性 (constructor(private x)): Node 的 strip-only TS 模式会拒绝它,
  // 而 CLI/MCP 这类入口需要能被 `node src/....ts` 直接跑 (见 tests/s2/mcp-surface.test.ts 的真机测试)。
  private readonly opts: CodexAdapterOptions;

  constructor(opts: CodexAdapterOptions) {
    this.opts = opts;
    this.recall = new RecallService((q) => opts.store.query(q));
    this.agentsPath = opts.agentsPath ?? opts.repoRoot + "/AGENTS.md";
  }

  /** 读取已确认的全局规则。 */
  private confirmedRules(): MemoryEntry[] {
    return this.opts.store.query({ kind: "rule", scope: "global" });
  }

  /**
   * 会话开始: 把规则同步进 AGENTS.md。返回是否更新。
   * 保守策略: 索引里查不到规则时**不要**把已有规则段清空 —— 空结果更可能是索引丢失
   * (虽然 FileBackend 现在会自动重建), 而误清会把已同步的规则抹掉。
   */
  async onSessionStart(_ctx: SessionContext): Promise<unknown> {
    const existing = existsSync(this.agentsPath) ? readFileSync(this.agentsPath, "utf8") : "";
    const rules = this.confirmedRules();
    if (rules.length === 0 && existing.includes(START) && !existing.includes(EMPTY_MARKER)) {
      return { updated: false, rules: 0, skipped: "existing rules section kept (index empty)" };
    }
    const updated = updateAgentsMd({ existing, rules, language: this.opts.language });
    if (updated !== existing) writeFileSync(this.agentsPath, updated, "utf8");
    return { updated: updated !== existing, rules: rules.length };
  }

  /** turn 结束: 捕获。Codex CLI 场景通常由独立命令触发, 这里留空实现。 */
  async onTurnEnd(_turn: TurnData): Promise<never[]> {
    return [];
  }

  /** 按需召回 (预步注入)。 */
  async onPreStep(step: { text: string; at: string }): Promise<Recall | null> {
    const out = this.recall.recall({ text: step.text, limit: 5 });
    if (!out.injected) return null;
    return { entries: [...out.rules, ...out.local], maxTokens: 2000 };
  }

  registerTools(registry: { define(name: string, fn: unknown): void }): void {
    registry.define("memory_search", async (q: string) => {
      const out = this.recall.recall({ text: q, limit: 8 });
      return out.injected || "无相关记忆。";
    });
    registry.define("memory_rule_propose", async (proposal: GeneralizationProposal) => {
      // Codex 场景: 提议直接落 review 队列由人确认 (简化: 返回提示)
      return "推广提议由 HX-Memory review 队列处理, 请用 DSH Web 面板或 CLI 确认。";
    });
  }
}
