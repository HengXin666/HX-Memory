// bench/lib/scale-corpus.ts — 规模压力语料: 真实条目当"针", 合成条目当"干扰项"。
//
// 为什么需要: 全上下文基线表明 80 条语料 32K 上下文就能装下, 因此当前规模测不出"检索的
// 必要性"。要测它必须扩大语料 —— 但真实记忆只有 80 条。
//
// 诚实的做法: **不伪造真实数据**。真实条目原样保留 (所有查询都指向它们), 另外合成
// 干扰项来制造检索压力。合成项由模板生成、字段完整、内容可辨认, 并在 stats 里显式标注,
// 因此结论只能说"在 N 条规模下的排序表现", 不能说"在真实记忆库上的表现"。
//
// 用法: node --experimental-strip-types bench/lib/scale-corpus.ts --n 1000 --out FILE
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Corpus, CorpusEntry } from "./corpus.ts";

/** 干扰项的题材池 —— 与真实记忆同域 (工程经验), 才构成真实压力。 */
const TOPICS = [
  "数据库连接池", "缓存击穿", "消息队列堆积", "分布式锁", "限流熔断", "日志采样",
  "灰度发布", "蓝绿部署", "容器编排", "服务网格", "链路追踪", "指标采集",
  "前端打包", "静态资源缓存", "骨架屏", "虚拟列表", "状态管理", "表单校验",
  "接口鉴权", "密钥轮换", "越权校验", "审计日志", "数据脱敏", "备份恢复",
  "分库分表", "读写分离", "慢查询治理", "索引失效", "事务隔离", "死锁检测",
];

const PROBLEMS = ["超时", "雪崩", "重复执行", "内存泄漏", "顺序错乱", "丢消息", "状态不一致", "容量不足"];
const ACTIONS = ["显式设置上限", "加退避重试", "先降级再扩容", "做成幂等", "加超时与熔断", "落盘再确认", "异步化", "分片处理"];
const LESSONS = ["只在压测环境复现过", "上线后第二天才暴露", "小流量时完全看不出来", "并发一上来就炸", "回滚过一次"];

function synth(i: number): CorpusEntry {
  const topic = TOPICS[i % TOPICS.length]!;
  const problem = PROBLEMS[(i * 7) % PROBLEMS.length]!;
  const action = ACTIONS[(i * 11) % ACTIONS.length]!;
  const lesson = LESSONS[(i * 13) % LESSONS.length]!;
  const day = String((i % 28) + 1).padStart(2, "0");
  return {
    id: "syn-" + String(i).padStart(5, "0"),
    content: `${topic}的${problem}问题: 生产实例 ${i % 13 + 2} 个并发时出现, 处理办法是${action},` +
      `并补了一条回归用例。教训是这类问题${lesson}, ${action}必须写进部署清单 (场景 ${i % 97})。`,
    kind: i % 3 === 0 ? "lesson" : i % 3 === 1 ? "decision" : "fact",
    scope: "project",
    project: "scale-fixture-" + (i % 12),
    tags: [topic, problem],
    entities: [],
    assertedAt: `2026-0${(i % 9) + 1}-T00:00:00.000Z`.replace("-T", "-" + day + "T"),
    validAt: `2026-0${(i % 9) + 1}-T00:00:00.000Z`.replace("-T", "-" + day + "T"),
    sourceRef: "bench:scale-fixture",
    confirmed: false,
    confirmedBy: null,
    confirmedAt: null,
    relations: [],
  };
}

function main(argv: string[]): number {
  let n = 1000;
  let base = join(".tmp", "bench", "corpus.json");
  let out = join(".tmp", "bench", "corpus-scale.json");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--n") n = Number(argv[++i] ?? n);
    else if (a === "--base") base = argv[++i] ?? base;
    else if (a === "--out") out = argv[++i] ?? out;
  }
  const real = JSON.parse(readFileSync(base, "utf8")) as Corpus;
  const distractors = Math.max(0, n - real.entries.length);
  const entries = [...real.entries];
  for (let i = 0; i < distractors; i++) entries.push(synth(i));

  const corpus: Corpus & { stats?: Record<string, unknown> } = {
    schema: "hxmem-corpus/1",
    exportedAt: new Date().toISOString(),
    source: { system: "HX-Memory + synthetic distractors", root: real.source.root,
              count: entries.length, droppedShadow: real.source.droppedShadow },
    entries,
  };
  corpus.stats = {
    real: real.entries.length,
    syntheticDistractors: distractors,
    note: "真实条目原样保留 (所有查询指向它们); 合成项仅用于制造检索压力。"
        + "结论只能说'N 条规模下的排序表现', 不能说'真实记忆库上的表现'。",
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(corpus, null, 2));
  console.log("规模语料: 真实 " + real.entries.length + " + 合成 " + distractors + " = " + entries.length);
  console.log("输出: " + out);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
