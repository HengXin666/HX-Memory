#!/usr/bin/env node
// scripts/smoke-dsh-http.mjs — 真机 DSH 行为门禁的 HTTP 断言部分 (由 smoke-dsh.sh 调用)。
//
// 为什么独立成 Node 脚本: shell 里拼 JSON 信封 + 反斜杠引号极易写错 (真实踩过),
// 这里用 fetch + 对象序列化, 无转义问题, 且 cookie 认证 (0.1.2+) / 双传输形态
// (settings/describe 走 Typert 信封 vs settings.describe 走 apiproxy) 都集中在一处。
//
// 用法: node scripts/smoke-dsh-http.mjs <token-url> <package-name> <smoke-home>
//   0.1.2+ 的 URL 带 ?token= → 先换 authority 绑定 cookie; 0.1.1 没有 → 直接裸调。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [tokenUrl, pkgName, smokeHome] = process.argv.slice(2);
if (!tokenUrl || !pkgName || !smokeHome) {
  console.error("[smoke-http] usage: smoke-dsh-http.mjs <token-url> <package-name> <smoke-home>");
  process.exit(2);
}

// 去掉尾部斜杠: tokenUrl 形如 http://host:port/?token=..., split 后带 "/", 拼 /api 会变成 //api。
const origin = (tokenUrl.split("?")[0] ?? "").replace(/\/+$/, "");
let cookie = "";

if (tokenUrl.includes("token=")) {
  const res = await fetch(tokenUrl, { redirect: "manual" });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  if (!cookie) {
    console.error("[smoke-http] FAIL: no session cookie issued for token URL");
    process.exit(1);
  }
  console.log("[smoke] session cookie minted (0.1.2+ token auth)");
}

const headers = {
  "content-type": "application/json",
  ...(cookie ? { cookie } : {}),
};

/** Typert Remote 统一形态: POST /api/<ns>/<method> + { args } 信封。 */
async function callApi(method, args) {
  const res = await fetch(`${origin}/api/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId: crypto.randomUUID(),
      method,
      payload: { args },
    }),
  });
  return res.json();
}

function fail(msg) {
  console.error("[smoke-http] FAIL: " + msg);
  process.exit(1);
}
function ok(msg) {
  console.log("[smoke] ok: " + msg);
}

// --- 3) 两个 fiber 都 active ---
// runtime 条目 id 现在是 `hx-memory` (0.1.7 起它就是设置命名空间), client 仍是 `hx-memory-client`。
const inv = await callApi("pluginInventory/list", {});
const entries = inv.result?.value?.entries ?? [];
for (const name of ["hx-memory", "hx-memory-client"]) {
  const row = entries.find((e) => e.entryId === name || e.entryId.endsWith(":" + name));
  if (!row) fail("missing entry " + name);
  if (row.fiberPhase !== "active") fail(name + " fiber=" + row.fiberPhase);
}
ok("runtime + client fibers active");

// --- 4) RPC 约定: 信封 ok:true 且业务结果不能是 {ok:false} ---
async function check(method, args, label) {
  const res = await callApi(method, args).catch((error) => fail(label + " (" + method + "): " + error));
  if (res?.result?.ok !== true) fail(label + " (" + method + "): envelope not ok");
  const value = res.result.value;
  if (value !== null && typeof value === "object" && value.ok === false) {
    fail(label + " (" + method + "): business failure");
  }
  ok(label);
}
// reviewQueue: 本行只验"端点挂上了"; **队列内容的断言在 runGeneralization 之后** ——
// 见下面那段前的注释 (队列要先被泛化器跑过才有内容, 那是**顺序依赖**, 不是缺陷)。
await check("hxMemory/reviewQueue", { status: "proposed" }, "reviewQueue 200 + ok");
await check("hxMemory/generalizationStatus", {}, "generalizationStatus 可用 (批次可观测面)");
// runGeneralization 现在返回漏斗报告: 面板要读 considered/clusters/proposed/usedLlm,
// 缺字段会让状态条显示 undefined —— 在这里断言形状而不只是"没报错"。
//
// ⚠ **只能调一次** (2026-09-18, 我第一版调了两次 —— 第一次是 check 那次):
// `runRecent` 会把产出的提议写进队列, 而**下一次**调用会用队列算 `covered`,
// 把刚覆盖的条目全部跳过 ⇒ **第二次必然 clusters=0 / proposed=0** (实测 coveredSkipped=3)。
// 那是**有意的幂等设计** ("同一批不重复提议"), 不是缺陷 —— 而我的断言把它当成了缺陷。
// 教训: 断言里**不要重复调用有副作用的 RPC**, 否则测的是"第二次"而不是"这个功能行不行"。
const runReport = await callApi("hxMemory/runGeneralization", { limit: 100 });
const report = runReport?.result?.value ?? {};
if (runReport?.result?.ok !== true) fail("runGeneralization: envelope not ok");
for (const field of ["at", "considered", "coveredSkipped", "clusters", "proposed", "usedLlm", "tookMs"]) {
  if (!(field in report)) fail("runGeneralization 报告缺字段 " + field);
}
if (typeof report.proposed !== "number") fail("runGeneralization.proposed 不是数字");
// **漏斗必须真的产出** (2026-09-18, §478): 只验"字段存在"会让一个**恒返回空漏斗**的实现通过。
// 播种了 3 条同主题 lesson ⇒ 它们应当聚成 >=1 簇并产出 >=1 条提议。
if (report.considered === 0) fail("runGeneralization.considered 为 0 (播种的 lesson 没被扫到)");
if (report.clusters === 0) fail("runGeneralization.clusters 为 0 (同主题 lesson 没聚成簇)");
if (report.proposed === 0) fail("runGeneralization.proposed 为 0 (漏斗没产出提议)");
ok(
  "runGeneralization 返回漏斗报告且**确实产出** (considered=" + report.considered +
    " clusters=" + report.clusters + " proposed=" + report.proposed + ")",
);
// reviewQueue 的**内容**断言必须排在 runGeneralization 之后 —— 那是**顺序依赖**:
// 队列由泛化批次产出 (runRecent 写队列), 空库起步时它在第一次跑批之前必然是空的。
// (2026-09-18 我第一版把它放在前面, 于是断言 FAIL —— 那次失败**指出了一个真实的顺序约束**,
//  而不是产品缺陷。记在这里免得后人再踩。)
const rq = await callApi("hxMemory/reviewQueue", { status: "proposed" });
const rqVal = rq?.result?.value;
if (!Array.isArray(rqVal)) fail("reviewQueue 必须返回数组");
if (rqVal.length === 0) {
  fail("跑过泛化后 reviewQueue 仍为空 (播种 lesson 没聚成簇, 或产出没落队列)");
}
// 字段清单取自 ReviewQueueView (gateway-review.ts): 面板据此渲染"这条提议概括了哪几条原文"。
// (我第一版写了 "proposal" —— 那是**内层结构**的名字; 视图层展平了它, 实际字段是 `rule`。)
for (const k of ["id", "status", "rule", "covers", "confidence", "sourceRun", "generatedAt", "suggestedAction"]) {
  if (!(k in rqVal[0])) fail("reviewQueue 元素缺字段 " + k);
}
if (!Array.isArray(rqVal[0].covers)) fail("reviewQueue.covers 必须是数组 (人审要按 id 追原文)");
if (typeof rqVal[0].rule !== "string" || rqVal[0].rule.length === 0) fail("reviewQueue.rule 必须是非空字符串");
ok("reviewQueue 在泛化后**确有提议且形状完整** (播种 lesson 聚簇产出, " + rqVal.length + " 条)");

// --- 人工闸门 (ADR-003): confirmProposal 必须真的把提议变成规则 ---
//
// 为什么必须在真机验 (2026-09-18, §481): 这条路径此前**零覆盖** —— 而它是
// "规则只由人改" (ADR-003) 的**唯一执行点**。它有三个不能只靠单测的性质:
//   ① 提议 → 规则的**落盘** (不是只改队列里的状态);
//   ② 新规则要**真的进 always-on 通道** (否则"确认了但没生效");
//   ③ 队列状态要**真的变** (proposed → confirmed)。
//
// ⚠ 用**队尾那条**而不是第一条: 前面的提议可能已被其它断言路径覆盖, 而我们要一个干净的对象。
const target = rqVal[rqVal.length - 1];
if (!target?.id) fail("confirmProposal: 队列里没有可确认的提议");
const conf = await callApi("hxMemory/confirmProposal", { id: target.id, by: "smoke" });
if (conf?.result?.ok !== true) fail("confirmProposal: envelope not ok");
const confVal = conf.result.value ?? {};
if (confVal.ok !== true) fail("confirmProposal 失败: " + String(confVal.error));
if (typeof confVal.ruleId !== "string" || !confVal.ruleId) {
  fail("confirmProposal 未返回 ruleId (确认后应当产出一条规则)");
}
// ① 队列状态真的变了
const afterQueue = await callApi("hxMemory/reviewQueue", { status: "confirmed" });
const confirmedIds = new Set((afterQueue?.result?.value ?? []).map((x) => x.id));
if (!confirmedIds.has(target.id)) fail("confirmProposal 后队列里找不到已确认的那条 (状态没落盘)");
// ② 规则真的进了库 (查得到, kind=rule, 且带确认记录)
const pend = await callApi("hxMemory/entriesByIds", { ids: [confVal.ruleId] });
const ruleRow = (pend?.result?.value ?? [])[0];
if (!ruleRow) fail("confirmProposal 声称产出了规则, 但按 id 查不到 (ruleId=" + confVal.ruleId + ")");
if (ruleRow.kind !== "rule") fail("确认后产出的不是 rule: kind=" + ruleRow.kind);
if (ruleRow.status !== "active") fail("确认后的规则 status 不是 active: " + ruleRow.status);
// ⚠ **刻意不断言"它进了 always-on"** (2026-09-18, §481 第一版就错在这里):
// 我播种的 lesson 是**启发式兜底**产出的, 于是确认后的规则正文是
// "经验: testing 相关的 N 条实例已沉淀 …" —— 那是一条**占位草稿**,
// 而 `selectAlwaysOnDetailed` **按设计挡住它** (isHeuristicRulePlaceholder, 见 trigger/policy.ts 的长注释:
// 占位草稿不含可执行约束, 会把 400 token 的保底预算吃光)。
//
// ⇒ 那条断言 FAIL 是**产品正确**的证据, 不是缺陷。要验"确认 → 进 always-on"这条链,
//   需要一个**真规则**样本 (库外主题 + 关掉启发式兜底), 而冒烟环境没有 LLM ⇒ 做不到。
//   所以这里只验"规则真的落盘且形状正确"; "进 always-on"由 §421 的 alwaysOnPreview 断言覆盖
//   (它验的是**播种的已确认规则**, 那条是真规则)。
ok("confirmProposal 端到端: 提议 → 规则落盘 (ruleId=" + confVal.ruleId + ", kind=rule, active)");
await check("hxMemory/listInvocations", { limit: 10 }, "listInvocations 可用");
// recentCaptures: 它是**面板「最近沉淀」的主出口**, 而这里能验到**元素形状**
// (探路确认过: 隔离库播种后它返回数组且元素键完整; 其它几个端点在本环境下是空数组, 无元素可验)。
//
// ⚠ **覆盖限界 (2026-09-18 记)**: reviewQueue / contradictions / listInvocations 在此环境下
// 返回**空数组** ⇒ 只证明"端点挂上了 + 是数组", **不证明元素形状正确**。它们的能力侧由单测覆盖。
const rc = await callApi("hxMemory/recentCaptures", { limit: 10 });
if (rc?.result?.ok !== true) fail("recentCaptures: envelope not ok");
const rcVal = rc.result.value;
if (!Array.isArray(rcVal)) fail("recentCaptures 必须返回数组");
if (rcVal.length === 0) fail("recentCaptures 应当至少返回播种的那条 (空数组说明查询或可见性有问题)");
for (const k of ["id", "kind", "content", "scope", "assertedAt"]) {
  if (!(k in rcVal[0])) fail("recentCaptures 元素缺字段 " + k);
}
ok("recentCaptures 可用且**元素形状完整** (面板最近沉淀出口, " + rcVal.length + " 条)");
// 主动整理 (无损迁移): 面板必须能拿到**干跑报告**, 且报告里不能有 error 字段
// (normalizer 未挂载时返回 {error}, check 只会看到"对象"—— 这里显式断言它真挂上了)。
const norm = await callApi("hxMemory/normalizeMemory", { dryRun: true });
const normReport = norm?.result?.value ?? {};
if (normReport.error) fail("normalizeMemory: " + normReport.error);
// sweptTemps 也在此列 (2026-09-18 补): 它是"顺手清扫原子写孤儿临时文件"的计数。
// **新字段必须进这张清单** —— 否则真机门禁不会检查它, 而报告形状是面板的契约。
for (const field of ["scanned", "changed", "unchanged", "dryRun", "toFormat", "changes", "sweptTemps"]) {
  if (!(field in normReport)) fail("normalizeMemory 报告缺字段 " + field);
}
if (typeof normReport.sweptTemps !== "number") fail("normalizeMemory.sweptTemps 必须是数字");
if (normReport.dryRun !== true) fail("normalizeMemory 默认必须是干跑 (不得默认写盘)");
ok("normalizeMemory 返回干跑报告 (主动整理入口可用)");
// 播种的矛盾条目 id —— **必须与 scripts/smoke-dsh.sh 里的字面量一致**。
// 为什么硬编码而不是传参: 与上面 SEED_RULE_ID 同一做法 (它在 161 行也是硬编码);
// 两处不一致会让断言报"未同时列出播种的两条", 而那正是它该报的错。
const SEED_CONTRA_A = "mseed0000000contra";
const SEED_CONTRA_B = "mseed0000000contbz";

// contradictions: **播种之后**这条断言才真的在跑 (§475)。
// 此前它在冒烟环境里返回空数组, 只证明"端点挂上了"; 现在播种了一对互相矛盾的条目 ⇒
// 可以验**元素形状**, 也就是"矛盾真的能被发现" —— 那是 keep-both 保守设计的唯一出口。
const contra = await callApi("hxMemory/contradictions", { limit: 20 });
if (contra?.result?.ok !== true) fail("contradictions: envelope not ok");
const contraVal = contra.result.value;
if (!Array.isArray(contraVal)) fail("contradictions 必须返回数组");
if (contraVal.length === 0) {
  fail("contradictions 应当至少返回播种的那对矛盾 (空数组说明播种没生效, 断言退回空转)");
}
for (const k of ["id", "kind", "content", "withId"]) {
  if (!(k in contraVal[0])) fail("contradictions 元素缺字段 " + k);
}
// 播种的那一对必须**成对出现** (双向边) —— 单向会让面板只显示一半
const contraIds = new Set(contraVal.map((x) => x.id));
if (!(contraIds.has(SEED_CONTRA_A) && contraIds.has(SEED_CONTRA_B))) {
  fail(
    "contradictions 未同时列出播种的两条 (双向 contradicts 边不完整): " +
      JSON.stringify([...contraIds].filter((x) => x.startsWith("mseed"))),
  );
}
ok("contradictions 可用且**元素形状完整** (播种的矛盾成对出现, " + contraVal.length + " 条)");
// agent 标注面: 必须是**数组**且元素形状完整 —— 标注会降权排序, 面板据此解释"为什么排到后面了"。
//
// ⚠ **覆盖限界 (2026-09-18 记)**: 空数组在这里是**预期**的 (没有标注才是常态),
// 因此本断言**不证明"标注能被读出"** —— 标注是**用户/agent 的行为**, 脚本产生不了。
// 换句话说: 它证明的是"这个面存在且形状稳定", 不是"它能工作"。
// ── 注入预览: "这一轮会注入什么" + "什么因配额没进来" ──────────────────────────
// 为什么断言它 (2026-09-18): 面板此前有"新沉淀/搜索/待审"三个 tab, 但**没有"注入"** ——
// 而注入是用户唯一能感知的记忆行为; 更糟的是被配额挡掉的规则**完全静默**
// (实测真实库 9 条已确认规则里 2 条永远注入不进)。
//
// 断言分两层:
//   1. **形状与自洽性** (picked 与 blocked 不相交) —— 这是出口的正确性所在;
//   2. **播种的规则必须出现在 picked 里** —— 这一条把断言从"空集恒真"变成真的在跑。
//      (2026-09-18: 此前隔离 DSH_HOME 是空库, 自洽性断言在空集上恒真, 属空转。
//       现在 smoke-dsh.sh 会先播种一条已确认规则, 于是这条断言有意义。)
//
// 刻意仍**不**断言具体条数: 条数随库内容变化, 断言它会变成 flaky。
const SEED_RULE_ID = "mseed00000000smoke";
const preview = await callApi("hxMemory/alwaysOnPreview", { project: "hx-memory" });
if (preview?.result?.ok !== true) fail("alwaysOnPreview: envelope not ok");
const pv = preview.result.value;
if (!Array.isArray(pv?.picked)) fail("alwaysOnPreview.picked 必须是数组");
if (!Array.isArray(pv?.blocked)) fail("alwaysOnPreview.blocked 必须是数组");
if (typeof pv?.budgetTokens !== "number") fail("alwaysOnPreview.budgetTokens 必须是数字");
// 自洽: 被挡的条目不得同时出现在选中里 (否则这个出口会误导用户)
const pickedIds = new Set(pv.picked.map((e) => e.id));
const conflict = pv.blocked.filter((b) => pickedIds.has(b.id));
if (conflict.length) fail("alwaysOnPreview: 同一条既被选中又被挡 (" + conflict.length + " 条)");
// blocked 的成因必须是两种已知值之一 (自由字符串会让前端无法分支)
const badReason = pv.blocked.filter((b) => b.reason !== "over-group-cap" && b.reason !== "over-total-budget");
if (badReason.length) fail("alwaysOnPreview: 未知的 blocked.reason: " + JSON.stringify(badReason[0]?.reason));
// 播种的那条已确认规则**必须**在选中里 —— 若它不在, 说明这条断言又退回空转了。
// (规则是用户确认过的跨项目不变量, 承诺无条件注入; 它没进来就是真问题。)
if (!pv.picked.some((e) => e.id === SEED_RULE_ID)) {
  fail(
    "alwaysOnPreview: 播种的已确认规则未出现在 picked 里 (id=" + SEED_RULE_ID + ") — " +
      "要么播种没生效 (断言退回空转), 要么规则真的被挡了",
  );
}
ok("alwaysOnPreview 可用 (选中 " + pv.picked.length + " 条 / 被挡 " + pv.blocked.length + " 条, 播种规则在列)");

const flagged = await callApi("hxMemory/flaggedMemories", { limit: 50 });
if (flagged?.result?.ok !== true) fail("flaggedMemories: envelope not ok");
if (!Array.isArray(flagged.result.value)) fail("flaggedMemories 必须返回数组 (空数组 = 没有坏评, 是好事)");
ok("flaggedMemories 可用 (agent 标注面)");
// 证据链 (面板「追来源」按钮的端点): 断言的是**这个端点真的挂上了**, 而不是"某个 id 能溯源" ——
// 全新宿主上还没有带血缘的条目, 所以"返回 error 对象"与"返回链路"都算通过;
// 只有"端点不存在" (静默 404) 才是失败。宿主重启前调用它会 404, 这正是本断言要拦的。
const evMissing = await callApi("hxMemory/evidenceChain", { id: "mSmokeNonexistent" });
if (evMissing?.result?.ok !== true) fail("evidenceChain: envelope not ok (端点未挂载?)");
const evVal = evMissing.result.value;
if (typeof evVal !== "object" || evVal === null) fail("evidenceChain 必须返回对象");
if (!("error" in evVal) && !("entryId" in evVal)) {
  fail("evidenceChain 返回值既不是错误对象也不是证据链 (形状不符合契约)");
}
ok("evidenceChain 可用 (面板追来源入口, 且对不存在的 id 有明确回应)");

// **对存在的 id** 追来源: 上面那条只证明端点挂上了; 这一条才证明"可溯源"真的能跑。
//
// 为什么可以断言了 (2026-09-18): smoke 现在会**先播种**一条已确认规则 (见 smoke-dsh.sh),
// 因此隔离库里确实有条目 —— 此前"全新宿主还没有条目"的限制不再成立。
// 播种规则由 import 写入, 因此它**带 source**, 追溯必须能返回它。
const evSeed = await callApi("hxMemory/evidenceChain", { id: SEED_RULE_ID });
if (evSeed?.result?.ok !== true) fail("evidenceChain(播种 id): envelope not ok");
const evSeedVal = evSeed.result.value;
if (typeof evSeedVal !== "object" || evSeedVal === null) {
  fail("evidenceChain(播种 id) 必须返回对象");
}
if ("error" in evSeedVal) {
  fail("evidenceChain(播种 id) 返回了 error: " + String(evSeedVal.error) + " — 播种的条目应当可溯源");
}
if (evSeedVal.entryId !== SEED_RULE_ID) {
  fail("evidenceChain(播种 id) 返回的 entryId 不匹配: " + String(evSeedVal.entryId));
}
ok("evidenceChain 对**存在的条目**能返回溯源 (可溯源承诺真的在跑, 非仅端点可达)");
// 捕获待审队列: 断言 available 字段存在 (它是"机制是否接线"的标志, 与"有没有待审"分开)。
//
// ⚠ **覆盖限界 (2026-09-18 记)**: 隔离库是空的, 因此这里只证明了
// "端点挂上了 + 形状对", **不证明"它能列出真实待审项"** —— 待审需要**可疑候选**,
// 而那是捕获管道的产物, 播种一条规则产生不了。
// 能力侧由单测与 §捕获管道的集成测试覆盖。**改动这块时不要以为本断言已经验过它。**
const cq = await callApi("hxMemory/captureReviewQueue", { limit: 10 });
if (cq?.result?.ok !== true) fail("captureReviewQueue: envelope not ok (端点未挂载?)");
const cqv = cq.result.value;
if (typeof cqv !== "object" || cqv === null) fail("captureReviewQueue 必须返回对象");
if (typeof cqv.available !== "boolean") fail("captureReviewQueue 必须给出 available");
if (!Array.isArray(cqv.items)) fail("captureReviewQueue.items 必须是数组");
ok("captureReviewQueue 可用 (待审队列有出口, 不会变成悄悄丢弃)");
// 注入调度账本: 面板「注入调度」tab 的唯一出口。断言形状而不是内容 ——
// 全新宿主上还没有任何预步判定, 所以 sessions/records 为空是**正常**的 (available 才是契约)。
//
// ⚠ **覆盖限界 (2026-09-18 记)**: 同上, 这里只证明端点可达 + 形状正确。
// **不证明它真能记录一次判定** —— 那需要真实会话走完一轮预步, 播种条目做不到。
const sched = await callApi("hxMemory/scheduleLog", { limit: 20 });
if (sched?.result?.ok !== true) fail("scheduleLog: envelope not ok");
const schedValue = sched.result.value;
if (typeof schedValue !== "object" || schedValue === null) fail("scheduleLog 必须返回对象");
if (typeof schedValue.available !== "boolean") fail("scheduleLog 必须给出 available (账本是否挂载)");
if (!Array.isArray(schedValue.sessions) || !Array.isArray(schedValue.records))
  fail("scheduleLog 必须返回 sessions/records 数组");
if (typeof schedValue.size?.records !== "number") fail("scheduleLog.size.records 必须是数字");
ok("scheduleLog 可用 (注入调度的'为什么'可查)");
// 捕获耗时账本: 面板「沉淀耗时」tab 的唯一出口。同样断言形状而不是内容 ——
// 全新宿主上还没跑过任何完成的轮次, 所以 records 为空、各统计为 0 都是**正常**的。
const capLog = await callApi("hxMemory/captureLog", { limit: 20 });
if (capLog?.result?.ok !== true) fail("captureLog: envelope not ok");
const capValue = capLog.result.value;
if (typeof capValue !== "object" || capValue === null) fail("captureLog 必须返回对象");
if (typeof capValue.available !== "boolean") fail("captureLog 必须给出 available (账本是否挂载)");
if (!Array.isArray(capValue.records)) fail("captureLog 必须返回 records 数组");
if (typeof capValue.stats?.count !== "number") fail("captureLog.stats.count 必须是数字");
if (typeof capValue.stats?.totalMs?.p95 !== "number") fail("captureLog.stats.totalMs.p95 必须是数字");
if (typeof capValue.stats?.mean?.enrichMs !== "number") fail("captureLog.stats.mean.enrichMs 必须是数字");
ok("captureLog 可用 (沉淀耗时与'为什么没沉淀'可查)");
await check("hxMemory/listBindings", {}, "listBindings 可用 (bindingStore 已挂载)");
await check(
  "hxMemory/saveBindings",
  {
    configs: [
      {
        project: "smoke",
        bindings: [{ id: "cross-rules", query: { kind: "rule", scope: "global" } }],
      },
    ],
  },
  "saveBindings 写入成功",
);

// --- 真往返: 写进去的绑定必须能读回来 ---
const listed = await callApi("hxMemory/listBindings", {});
const configs = listed.result?.value ?? [];
if (!Array.isArray(configs) || !configs.some((c) => c && c.project === "smoke")) {
  fail("saveBindings → listBindings 往返");
}
ok("saveBindings → listBindings 真往返");

// --- 5) 设置命名空间注册 (两种传输形态: Typert settings/describe 与 apiproxy settings.describe) ---
const viaTypert = await (async () => {
  try {
    const res = await callApi("settings/describe", {});
    const ns = res?.result?.value?.namespaces ?? [];
    return Array.isArray(ns) && ns.some((n) => n && n.ns === "hx-memory");
  } catch {
    return false;
  }
})();
if (viaTypert) {
  ok("设置命名空间已注册 (Typert settings/describe)");
} else {
  const res = await fetch(origin + "/api/settings.describe", {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "client-request",
      rpcId: crypto.randomUUID(),
      method: "settings.describe",
      payload: {},
    }),
  });
  const parsed = await res.json().catch(() => null);
  const ns = parsed?.result?.value?.namespaces ?? [];
  if (!Array.isArray(ns) || !ns.some((n) => n && n.ns === "hx-memory")) {
    fail("settings 命名空间未注册 (两种传输形态都试过)");
  }
  ok("设置命名空间已注册 (apiproxy settings.describe)");
}

// --- 5b) 注入时机开关必须能从宿主设置面读到并写得动 ---
// 为什么断言到字段级: 命名空间注册了但 schema 里没有 injectMode (或默认值写错), 用户在
// 「设置 → 插件」里就看不到这个开关 —— 而"看不到"和"没注册"在面板上长得一样。
// 这条曾经真实发生: 开关只是代码里的常量, 面板上没有任何入口。
const hxns = ((await callApi("settings/describe", {}))?.result?.value?.namespaces ?? []).find(
  (n) => n && n.ns === "hx-memory",
);
if (!hxns) fail("hx-memory 设置命名空间缺失 (无法配置注入时机)");
if (!JSON.stringify(hxns.schema ?? {}).includes("injectMode")) {
  fail("hx-memory schema 里没有 injectMode");
}
if (hxns.value?.injectMode !== "every-turn") {
  fail("injectMode 默认值应为 every-turn, 实际 " + JSON.stringify(hxns.value?.injectMode));
}
// 写路径真往返 (与面板同一合同: settings.update + revision 栅栏), 再读回确认。
const written = await callApi("settings/update", {
  ns: "hx-memory",
  patch: { injectMode: "first" },
  expectedRevision: hxns.revision,
});
if (written?.result?.ok !== true) fail("settings.update(injectMode) 被拒: " + JSON.stringify(written));
if (written.result.value?.value?.injectMode !== "first") fail("写入后读回的 injectMode 不是 first");
const after = ((await callApi("settings/describe", {}))?.result?.value?.namespaces ?? []).find(
  (n) => n && n.ns === "hx-memory",
);
if (after?.value?.injectMode !== "first") fail("重新 describe 后 injectMode 未生效 (面板会显示旧值)");
ok("注入时机开关可读可写 (schema 含 injectMode, 默认 every-turn, 真往返)");

// --- 6) truth-in-files: 绑定必须真的落盘 ---
const bindingsFile = join(smokeHome, "hx-memory", "bindings.json");
let onDisk;
try {
  onDisk = JSON.parse(readFileSync(bindingsFile, "utf8"));
} catch (error) {
  fail("bindings.json not readable: " + error);
}
if (!Array.isArray(onDisk) || !onDisk.some((c) => c && c.project === "smoke")) {
  fail("bindings.json 内容不对");
}
ok("绑定已落盘 (truth-in-files)");

// --- 7) boot manifest 必须包含我们的 client 行 (id == 包名)。
// 不再直接抓 bundle 文件: 0.1.2 的 bundle URL 是 combo 形式 (/plugins/??<id>/client.js&rev=...)
// 且校验 rev, 直接构造 URL 会 404; 模块 id 契约由 tests/s2/client-bundle.test.ts 对着构建产物断言,
// 真机侧只验证"宿主确实发现了我们的 client 插件"。
const page = await fetch(tokenUrl, { headers: cookie ? { cookie } : {} }).then((r) => r.text());
// 取 globalThis["__DSH_BOOT__"] = {...}</script> 之间的完整 JSON (到 </script> 为止, 不能贪到第一个 })。
let manifest = { entries: [] };
{
  const marker = 'globalThis["__DSH_BOOT__"] = ';
  const start = page.indexOf(marker);
  if (start !== -1) {
    const open = page.indexOf("{", start);
    const close = page.indexOf("</script>", start);
    const end = close === -1 ? page.length : close;
    const raw = page.slice(open, end).trim().replace(/;?\s*$/, "");
    try {
      manifest = JSON.parse(raw);
    } catch {
      manifest = { entries: [] };
    }
  }
}
const row = (manifest.entries ?? []).find((entry) => entry && entry.id === pkgName);
if (!row) fail("boot manifest has no row for " + pkgName);
ok("boot manifest 包含 " + pkgName + " 行 (client 插件已发现)");

console.log("[smoke] PASS");
