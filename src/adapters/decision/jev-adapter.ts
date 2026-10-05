// src/adapters/decision/jev-adapter.ts — 决策端口的一个实现: 概率判官 (JEV)。
//
// ## 这只是**一个**实现, 不是唯一可能
//
// 任何满足 `DecisionPort` 的实现都能替换它 —— 调用方 import 的是 kernel/ports-decision.ts。
// 换成别的模型时, 只需在组装根换一个 `DecisionPort` 实例, 业务代码一行不改。
//
// ## 为什么走子进程而不是 HTTP 直连
//
// 判官实现 (`.agents/decision/adapters/jev.py`) 是 Python, 且它自己管着账号池、重试与投票。
// 本仓有两个选择:
//   · 在 TS 里重写一遍 HTTP + 账号池 + 投票 —— 两份实现必然漂移 (本仓反复踩过);
//   · 走子进程调用既有实现 —— 单一实现, 且它已被 HX-Jungle 真机验证过。
// 选后者 (与 `spawn-cli.ts` 维护子进程同一纪律: **一处实现**)。
//
// ## 能力声明从哪来
//
// 声明**写在这里**而不是运行时问子进程: 它是"这个实现的性质", 不随调用变化,
// 而且调用方要能在**不启动子进程**的前提下读到它 (例如决定要不要投票)。
// 数值来自 HX-Jungle 的实测标定 (见 PORT.md 的实现清单表), 不是猜的。
//
// ## 不可用的两种形态 (都要能被 doctor() 区分)
//
//   · **配置缺失** (没有 key) —— 该提示人去配;
//   · **上游故障** (超时/500) —— 该静默降级。
// 两者都在 `ok=false` 里, 但 `error` 不同; 由调用方决定怎么处置。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  DecisionCapabilities,
  DecisionDoctorReport,
  DecisionOutcome,
  DecisionPort,
  DecisionQuestion,
} from "../../kernel/ports-decision.ts";

/** 判官脚本的默认位置 (HX-Jungle 的决策端口目录)。 */
const DEFAULT_DECISION_DIR = "/home/hx/Loli/code/AI-Code/gpt-json-to-token/HX-Jungle/.agents/decision";

/**
 * 子进程桥: 用 `python3 -c` 内联调用既有实现, 不新增文件 (也就没有第二份实现要维护)。
 *
 * ⚠ 刻意**不 import `fallback`** (回退控制在 TS 侧实现): 多拉一个模块就多一处
 * "它依赖的某个东西在环境里缺失"的失败面, 而那个模块在本桥里完全用不到。
 * 桥只做两件事: 把问题转成 `Question`, 把 `DecisionResult` 转成 JSON。
 */
const BRIDGE_SOURCE = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from port import Question
from adapters.jev import load_adapter

payload = json.loads(sys.stdin.read())
adapter = load_adapter(payload.get("adapter") or None)
mode = payload.get("mode") or "decide"
if mode == "doctor":
    print(json.dumps(adapter.doctor(), ensure_ascii=False))
    sys.exit(0)
questions = [
    Question(qid=q["qid"], type=q["type"], instructions=q["instructions"], criteria=q.get("criteria") or {})
    for q in payload.get("questions") or []
]
r = adapter.decide(payload.get("state") or "", questions, samples=int(payload.get("samples") or 1))
print(json.dumps({
    "ok": bool(r.ok),
    "answers": r.answers or {},
    "agreement": float(r.agreement or 0.0),
    "sharpness": float(getattr(r, "sharpness", 0.0) or 0.0),
    "meta": r.meta or {},
    "error": str(getattr(r, "error", "") or ""),
}, ensure_ascii=False))
`;

export interface JevAdapterOptions {
  /** 决策端口目录 (含 port.py / fallback.py / adapters/)。 */
  decisionDir?: string;
  /** python 解释器 (默认 $HX_PYTHON → python3)。 */
  python?: string;
  /** 子进程硬超时 (ms)。判官单次实测 ~0.45s, 投票 7 次留足余量。 */
  timeoutMs?: number;
  /** 采样次数 (默认 7: 实测可收敛; 实现自报 needsVoting=true)。 */
  samples?: number;
  /** 环境变量覆盖 (测试注入用)。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 判官适配器 (子进程桥)。
 *
 * 类名不带 "Jev" 前缀会与 `name` 字段重复; 保持清晰: 这是 **JEV 实现**, 端口在 kernel。
 */
export class JevDecisionAdapter implements DecisionPort {
  readonly name = "jev";
  private readonly decisionDir: string;
  private readonly python: string;
  private readonly timeoutMs: number;
  private readonly samples: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: JevAdapterOptions = {}) {
    this.decisionDir = options.decisionDir ?? process.env.HX_DECISION_DIR ?? DEFAULT_DECISION_DIR;
    this.python = options.python ?? process.env.HX_PYTHON ?? "python3";
    // 投票 7 次 × ~0.45s ≈ 3.2s; 给 60s 是因为上游偶发 500 会在实现内重试。
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.samples = options.samples ?? 7;
    this.env = options.env ?? process.env;
  }

  capabilities(): DecisionCapabilities {
    // 数值来自 HX-Jungle 的实测标定 (PORT.md 实现清单), 不是猜的:
    // 同输入重复 10 次实测 A×8/B×2 ⇒ 非确定 ⇒ 必须投票。
    return {
      name: this.name,
      parallelQuestions: true,
      deterministic: false,
      needsVoting: true,
      latencyClass: "fast",
      costClass: "low",
    };
  }

  /** 脚本目录是否就位 (缺它就完全不必起子进程)。 */
  available(): boolean {
    return existsSync(this.decisionDir + "/port.py");
  }

  async decide(
    state: string,
    questions: readonly DecisionQuestion[],
    samples?: number,
  ): Promise<DecisionOutcome> {
    const empty: DecisionOutcome = { ok: false, answers: {}, agreement: 0, error: "" };
    if (!this.available()) {
      return { ...empty, error: "decision_dir_missing: " + this.decisionDir };
    }
    const n = samples ?? (this.capabilities().needsVoting ? this.samples : 1);
    const payload = {
      mode: "decide",
      state,
      samples: n,
      questions: questions.map((q) => ({
        qid: q.qid,
        type: q.type,
        instructions: q.instructions,
        ...(q.criteria ? { criteria: q.criteria } : {}),
      })),
    };
    const run = await this.runBridge(payload);
    if (!run.ok) return { ...empty, error: run.error };
    try {
      const parsed = JSON.parse(run.stdout) as Partial<DecisionOutcome>;
      return {
        ok: parsed.ok === true,
        answers: parsed.answers ?? {},
        agreement: Number(parsed.agreement ?? 0),
        ...(typeof parsed.sharpness === "number" ? { sharpness: parsed.sharpness } : {}),
        ...(parsed.meta ? { meta: parsed.meta } : {}),
        error: String(parsed.error ?? ""),
      };
    } catch (error) {
      // 输出不是 JSON: 最可能是子进程打了一行 Python traceback (脚本自身的问题)。
      // 把它截进 error 而不是丢弃 —— 否则"判官不可用"的排查只能靠猜。
      return { ...empty, error: "bad_output: " + String(run.stdout).slice(0, 200) + " " + String(error) };
    }
  }

  async doctor(): Promise<DecisionDoctorReport> {
    if (!this.available()) {
      return { ok: false, adapter: this.name, error: "decision_dir_missing: " + this.decisionDir };
    }
    const run = await this.runBridge({ mode: "doctor" });
    if (!run.ok) return { ok: false, adapter: this.name, error: run.error };
    try {
      const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
      // ⚠ 字段名归一 (实测: Python 侧自报的是 snake_case `latency_ms`, 而本仓契约用 camelCase
      // `latencyMs`)。不做这一步的话 TS 侧永远读不到延迟 —— 而"判官多慢"正是可用性判断的依据。
      // 其余未知键**原样保留** (契约允许实现自报元信息, 这里是 api/model/usage 等)。
      const latency = parsed["latency_ms"] ?? parsed["latencyMs"];
      return {
        ...parsed,
        ok: parsed["ok"] === true,
        adapter: this.name,
        ...(typeof latency === "number" ? { latencyMs: latency } : {}),
      } as DecisionDoctorReport;
    } catch (error) {
      return { ok: false, adapter: this.name, error: "bad_output: " + String(error) };
    }
  }

  /** 起子进程跑桥接脚本; 归一成 `{ok, stdout, error}` (超时/退出码/启动失败三种都要区分)。 */
  private runBridge(payload: unknown): Promise<{ ok: boolean; stdout: string; error: string }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.python, ["-c", BRIDGE_SOURCE, this.decisionDir], {
          cwd: this.decisionDir,
          env: this.env,
        });
      } catch (error) {
        resolve({ ok: false, stdout: "", error: "spawn_failed: " + String(error) });
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已退出
        }
        resolve({ ok: false, stdout, error: `timeout_${this.timeoutMs}ms` });
      }, this.timeoutMs);
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      // stderr 单独收: Python 的 traceback 会打在这里, 而它是排查"判官为什么不可用"的唯一线索。
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        resolve({ ok: false, stdout, error: "spawn_error: " + error.message });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true, stdout, error: "" });
        else resolve({ ok: false, stdout, error: `exit_${code}: ` + stderr.trim().slice(0, 200) });
      });
      try {
        child.stdin?.write(JSON.stringify(payload));
        child.stdin?.end();
      } catch (error) {
        clearTimeout(timer);
        resolve({ ok: false, stdout, error: "stdin_failed: " + String(error) });
      }
    });
  }
}
