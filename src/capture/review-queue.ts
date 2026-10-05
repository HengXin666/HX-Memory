// src/capture/review-queue.ts — 捕获侧的**待审队列**: 可疑落盘的候选先进这里, 由人决定去留。
//
// 为什么需要它 (2026-09-18 独立盲审指出 + 我方证实): 捕获路径此前**没有任何撤回前置机制** ——
// 结构化器读出什么就直接 active 落盘。后果可量化: 真库里自动捕获通道 55 条被人工撤回 **28 条 (51%)**,
// 而工具通道 (memory_save) 110 条仅撤回 2 条 (2%)。净结论: **自动通道精确率约 60%**。
// 撤回是人在事后一条条做的, 而那本可以更早发生 —— 把"直接落盘"改成"可疑的先待审",
// 是把人的工作从"事后清理"前移到"事前裁决"。
//
// 判据 (三条, 全部来自实测的"低可信落盘"特征):
//   1. 无结论: 结构化器没读出 conclusion, 条目内容只能是原文转录 —— 那正是"用户原话被当记忆"。
//   2. 与原文字符重合度过高 (>0.9): 说明没有任何提炼, 只是把用户那句搬了过来。
//   3. 不含来自 answer 的具体标识符: 结论没有引用任何本轮产出的具体东西 (路径/端口/文件名),
//      说明它可能只是复述了问题。
//
// 边界:
//   · **不删除、不改状态**: 队列是"待审", 条目不落 active 也不消失 (真相仍在 episode 日志里);
//   · 与推广队列 (generalize) 分开: 那是"规则提议", 这是"条目可信度", 读者与处置都不同;
//   · 本身是追加写 (appendFileSync), 坏行不影响整份队列。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CAPTURE_REVIEW_DIR = "review-capture";

/** 一条待审的捕获候选。 */
/** 待审项的裁决状态 ("pending" = 尚未裁决)。 */
export type CaptureReviewStatus = "pending" | "accepted" | "rejected";

export interface CaptureReviewItem {
  id: string;
  at: string;
  /** 裁决状态; 旧数据缺省视为 pending (向后兼容: 队列是追加写的真相文件)。 */
  status?: CaptureReviewStatus;
  /** 为什么进待审 (可审计; 多条并列)。 */
  reasons: string[];
  /** 该轮的用户原文 (人工裁决的依据之一)。 */
  question: string;
  /** 结构化器给出的结论 (可能为空)。 */
  conclusion: string;
  /** 助手回答的开头 (人工据此判断"到底产出了什么")。 */
  answerExcerpt: string;
  project?: string;
  session: string;
  /**
   * 该轮对应的 episode id (**保留溯源** —— 待审条目也能接进证据链)。
   *
   * 为什么必须记: 待审的意义是"交给人裁决", 而人裁决时需要能追到原话判断真伪。
   * 若不记, accept 后这条记忆的 source 只能是 `panel:captureReview` 这类无信息的值,
   * 它会成为下一个"来源是常量"的坑 (与 memory_save 曾经的 `session:tool` 同类)。
   */
  episodeIds?: string[];
}

/** 捕获待审的文件 (与真相文件同根, 位于 <root>/review-capture/queue.jsonl)。 */
export function captureReviewFile(root: string): string {
  return join(root, CAPTURE_REVIEW_DIR, "queue.jsonl");
}

/** 追加一条待审项 (不存在则建目录)。 */
export function enqueueCaptureReview(root: string, item: CaptureReviewItem): void {
  const file = captureReviewFile(root);
  mkdirSync(join(root, CAPTURE_REVIEW_DIR), { recursive: true });
  appendFileSync(file, JSON.stringify(item) + "\n", "utf8");
}

/**
 * 判定一条候选是否应当**先进待审**而不是直接落盘。
 *
 * 返回空数组 = 可直接落盘。返回原因列表 = 应进待审。
 * 纯函数 (无 IO), 便于测试与在 pipeline 里复用。
 */
export function reviewReasons(input: {
  conclusion: string;
  question: string;
  answer: string;
  /**
   * 本轮是否走过**可提炼实现** (默认 true)。
   *
   * 为 false 时"无结论"是**能力缺失** (heuristic 兜底 / LLM 调用失败回退), 不是可疑 ——
   * 此时不该产出 no-conclusion 这条原因 (否则无 LLM 环境的候选会全部进队列)。
   */
  expectConclusion?: boolean;
}): string[] {
  const reasons: string[] = [];
  const conclusion = input.conclusion.trim();
  const expect = input.expectConclusion !== false;

  // 能力缺失时**整体跳过**可信度检查 (2026-09-18 实测修复)。
  //
  // 此前 expectConclusion 只守住了"无结论"这一条判据, 另两条**不受它管** ——
  // 而它们在没有提炼能力时同样会误触发: 启发式兜底让 content 退回原文, 于是
  // "结论与用户原文重合 >90%" 对**每一条**都成立。实测真实库重放: 无 LLM 环境下
  // 424 轮里有 **83 条**被误推进待审队列 (而落盘只有 11 条) —— 队列被灌满,
  // 人审界面变成垃圾场, 机制反而制造了它本想消灭的噪声。
  //
  // 判据: 可信度检查的前提是"系统**有能力**提炼"。没有能力时, 任何一条判据的触发
  // 都只反映"能力不足"而不是"候选可疑", 因此应当整体不做判断 (退回原行为: 直接落盘)。
  if (!expect) return reasons;

  if (!conclusion) {
    // 没有结论 = 条目内容只能是原文转录。这是"用户原话被当记忆"最直接的成因
    // (实测 content 与某条提问完全相等的自动捕获条目 29 条 = 18%)。
    reasons.push("no-conclusion: 结构化器未读出结论, 内容只能是原文转录");
  } else {
    // 与原文重合度过高: 说明没有提炼。
    //
    // ⚠ 2026-09-18 自查修复: 原实现用"逐字符看在较长串里是否出现"算重合 ——
    // **完全忽略顺序与重复次数**, 于是 "abcde" vs "edcba" (同字乱序) 与
    // "aaaaaa" vs "a" (重复字) 都被判成 100% 重合 (实测确认)。
    // 后果: 一份**乱序复述**或**单字重复**的结论会被误判成"无提炼"而进待审。
    // 判据改为 **最长公共子序列比例** (有序, 且要求两边长度同量级):
    //   · LCS 比例高 = 真的只是把原文搬过来 (无论顺序) → 判无提炼;
    //   · 长度差距悬殊 (如 "a" vs "aaaaaa") 时 LCS/较短者 仍高, 故再叠一道**长度比**门槛。
    const norm = (s: string): string => s.replace(/\s+/g, "");
    const a = norm(conclusion);
    const b = norm(input.question);
    if (a.length > 0 && b.length > 0) {
      const lcsRatio = lcs(a, b) / Math.min(a.length, b.length);
      const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      // 长度比 < 0.5 时不判"无提炼" —— 那是"结论比原文短很多", 正是提炼的结果。
      const overlap = lenRatio < 0.5 ? 0 : lcsRatio;
      if (overlap > 0.9) {
        reasons.push("high-overlap: 结论与用户原文重合 " + (overlap * 100).toFixed(0) + "% (>90%), 无提炼");
      }
    }
    // 不含来自 answer 的具体标识符: 结论没引用本轮产出的任何具体东西。
    const answer = input.answer;
    const specifics: string[] = [];
    // ⚠ **2026-10-05 修 (真实缺陷, 误杀率实测 133/139)**: 交替分支里 `js` 排在 `json`
    // **前面**, 于是正则先命中 `js` 就把 `.json` 截成 `.js` ——
    //   实测 "见 /openapi.json 与 users.json" ⇒ specifics = ["/openapi.js", "/users.js"]
    // 而结论里写的是 `openapi.json` / `users.json`, 永远匹配不上那个被截断的 token ⇒
    // 判 `uncited`。真库 139 条待审里 133 条是这个原因, 全部 `pending` (0 条被裁决过) ——
    // 也就是说这条判据实际上把待审队列变成了垃圾场。
    // 修法: 长扩展名排在短之前 (json → js / tsx → ts / yaml|yml → ...), 让交替分支先试长的。
    for (const m of answer.match(/[\w./-]+\.(?:tsx|ts|mjs|cjs|js|py|go|rs|json|md|yaml|yml|sql)/gi) ?? []) specifics.push(m);
    for (const m of answer.match(/\b\d{2,5}\b/g) ?? []) specifics.push(m);
    // 判据要**同时**看两处: 结论里也可能出现 answer 没有的路径 (那是结论自己补的上下文,
    // 不是"没引用") —— 因此只在"answer 有具体标识符**且结论一个都没沾到**"时才可疑。
    // 另一半是根因: 中文结论常写"管理端自带 OpenAPI" 而 answer 写 `/openapi.json` ——
    // 字面对不上不是"没引用", 而是**中英混写**。因此同时接受"结论含 answer 里的某个词根"。
    if (specifics.length >= 2) {
      const lower = conclusion.toLowerCase();
      const cited = specifics.some((s) => lower.includes(s.toLowerCase()));
      const stemCited = specifics.some((s) => {
        const stem = s.replace(/^.*\//, "").replace(/\.[a-z]+$/i, "").replace(/^\d+$/, "");
        return stem.length >= 3 && lower.includes(stem.toLowerCase());
      });
      if (!cited && !stemCited) {
        reasons.push("uncited: 结论未引用回答里出现的具体标识符 (" + specifics.slice(0, 3).join(", ") + " 等)");
      }
    }
  }
  return reasons;
}

/** 读队列 (人工审阅用; 坏行保留原样不丢)。 */
export function readCaptureReview(root: string): CaptureReviewItem[] {
  const file = captureReviewFile(root);
  if (!existsSync(file)) return [];
  const out: CaptureReviewItem[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CaptureReviewItem);
    } catch {
      // 坏行跳过 —— 一行坏数据不该让整份队列不可读。
    }
  }
  return out;
}

/**
 * 更新一条待审项的裁决状态 (接受 / 丢弃)。
 *
 * 为什么用"改状态"而不是"从队列里删掉": 与项目的治理价值观一致 ——
 * **不删除**: 裁决记录本身是可审计的 (谁在什么时候把什么候选接受/丢弃了)。
 * 且队列是追加写的真相文件, 直接删行会让"这条候选存在过"这件事失去痕迹。
 *
 * 与 generalize/service.ts 的 setStatus 同一范式 (那份处理规则提议, 这份处理条目可信度)。
 * 找不到该 id 时返回 false (由调用方决定是否报错)。
 */
export function setCaptureReviewStatus(
  root: string,
  id: string,
  status: CaptureReviewStatus,
): boolean {
  const file = captureReviewFile(root);
  if (!existsSync(file)) return false;
  let found = false;
  const out = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const item = JSON.parse(line) as CaptureReviewItem;
        if (item.id !== id) return line;
        found = true;
        return JSON.stringify({ ...item, status });
      } catch {
        return line; // 坏行原样保留 (人工可修), 不因一行坏数据丢整份队列
      }
    });
  if (found) writeFileSync(file, out.join("\n"), "utf8");
  return found;
}

/**
 * 最长公共子序列长度 (滚动数组, O(min(a,b)) 空间)。
 *
 * 为什么用 LCS 而不是"字符集合重合": 后者忽略顺序与重数, 会把**乱序复述**与
 * **单字重复**误判成"与原文完全重合" (实测: "abcde" vs "edcba" 被判 100%)。
 * LCS 是**有序**比较, 因此"把原文重新排列"不会被当成"照搬原文"。
 */
function lcs(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  let prev = new Array<number>(n + 1).fill(0);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return prev[n] ?? 0;
}
