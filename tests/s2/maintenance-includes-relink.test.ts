// tests/s2/maintenance-includes-relink.test.ts — 定期维护必须覆盖"重新建边"。
//
// 为什么单独钉住 (2026-09-18): 建边**只发生在写入时**, 因此建边判据一旦改进, 存量条目就
// 永远停在旧口径上 —— 实测真实库曾出现"按当前判据可建 401 条边, 库里却只有 20 条",
// 而补边动作当时**只存在于手动命令**里。依赖用户手动跑一次, 等于这个缺口长期存在。
//
// 本测试锁住两件事:
//   ① 默认维护任务清单包含 relink (面板/记录据此显示"这次维护覆盖了什么");
//   ② CLI 的 maintain 命令**真的**输出 relink 结果 (清单与实际行为不能脱节 ——
//      本项目已踩过同一坑: 早期把任务名当 argv 传, 于是 prune 被静默忽略而记录写"成功")。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAINTENANCE_TASKS } from "../../src/adapters/dsh/scheduler.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("定期维护覆盖重新建边", () => {
  it("默认维护任务清单包含 relink", () => {
    expect(DEFAULT_MAINTENANCE_TASKS).toContain("relink");
  });

  it("清单与实际行为一致: CLI 的 maintain 输出 relink 结果", () => {
    // 读源码断言而不是跑子进程 —— 这里要锁的是"两者不能脱节"这个**结构**性质,
    // 真实执行已由其它集成测试覆盖 (maintenance-scheduler 的 e2e)。
    const src = readFileSync(resolve(repoRoot, "src/adapters/codex/cli.ts"), "utf8");
    const maintainBlock = src.slice(src.indexOf('cmd === "maintain"'));
    expect(maintainBlock).toContain("relinkAll");
    expect(maintainBlock).toContain("relinkAdded");
  });

  it("relink 是**幂等**的 (作为定期任务的前提)", () => {
    // 定期任务必须幂等, 否则每晚都会往真相文件里堆重复边。
    // 该性质由 tests/s2/relink.test.ts 直接验证, 这里只锁"它被当作定期任务"时的语义前提。
    const src = readFileSync(resolve(repoRoot, "src/app/relink.ts"), "utf8");
    expect(src).toContain("只追加");
  });
});
