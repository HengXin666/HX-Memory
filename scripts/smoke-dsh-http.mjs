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
const inv = await callApi("pluginInventory/list", {});
const entries = inv.result?.value?.entries ?? [];
for (const name of ["hx-memory-runtime", "hx-memory-client"]) {
  const row = entries.find((e) => e.entryId.endsWith(name));
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
await check("hxMemory/reviewQueue", { status: "proposed" }, "reviewQueue 200 + ok");
await check("hxMemory/runGeneralization", { limit: 100 }, "runGeneralization 触发点可用");
await check("hxMemory/generalizationStatus", {}, "generalizationStatus 可用 (批次可观测面)");
// runGeneralization 现在返回漏斗报告: 面板要读 considered/clusters/proposed/usedLlm,
// 缺字段会让状态条显示 undefined —— 在这里断言形状而不只是"没报错"。
const runReport = await callApi("hxMemory/runGeneralization", { limit: 100 });
const report = runReport?.result?.value ?? {};
for (const field of ["at", "considered", "coveredSkipped", "clusters", "proposed", "usedLlm", "tookMs"]) {
  if (!(field in report)) fail("runGeneralization 报告缺字段 " + field);
}
if (typeof report.proposed !== "number") fail("runGeneralization.proposed 不是数字");
ok("runGeneralization 返回漏斗报告 (considered/clusters/proposed/usedLlm/tookMs)");
await check("hxMemory/listInvocations", { limit: 10 }, "listInvocations 可用");
await check("hxMemory/recentCaptures", { limit: 10 }, "recentCaptures 可用");
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
