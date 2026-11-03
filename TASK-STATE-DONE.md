# TASK-STATE-DONE

## 文件路径
- src/kernel/task-state.ts（新增）
- tests/kernel/task-state.test.ts（新增）
- 临时脚本（未入库）：.hark-tmp/ts-sample.ts、.hark-tmp/ts-samples.json（从 3 段真实 DSH 会话 jsonl 截取，每段取当前用户轮及之前的 80 条消息）

## 单测
命令：`npx vitest run tests/kernel/task-state.test.ts`
code 0
```
 RUN  v3.2.7 /home/hx/Loli/code/HXLoLis/components/HX-Memory
 ✓ tests/kernel/task-state.test.ts (9 tests) 6ms
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## 三个样例输出
命令：`node --experimental-strip-types --no-warnings .hark-tmp/ts-sample.ts`
code 0

```json
{
 "sample": "低信息 yes",
 "session": "1911b5f4-725c-4785-bc19-0efc7f76026d",
 "index": 1310,
 "userText": "yes",
 "state": {
  "modules": [
   "workspaces/browser-auto",
   "deepseek-ai/dsh-ptc-runtime-node",
   "vendor/genspark2api",
   ".agents/notes",
   "tmp",
   "services/hx-browser",
   ".agents/tools",
   "v1"
  ],
  "action": "新增",
  "project": "HX-Jungle",
  "files": [
   "workspaces/browser-auto/gh-pool/server/app/proto/join_loli.py",
   "deepseek-ai/dsh-ptc-runtime-node/lib/process.js",
   "vendor/genspark2api/cookies/cookies_proto_1791645235.json",
   ".agents/notes/implemented/bug-fix/2026-10-10-join-loli-web-channel-dead.md",
   ".agents/notes/implemented/feature/2026-10-10-gh-pool-batch-tasks-and-loli-join.md",
   "/tmp/trouble_msg.txt",
   "services/hx-browser/src/hx_browser/cloak.py",
   ".agents/tools/code_policy.py"
  ],
  "error": "ze=4,668,842 (完整) run2 http=200 size= 10,934 ← 只给 10KB run3 http=200 size= 637,798 ← 只给一部分 ``` 浏览器里对应的失败： ``` net::ERR_CONNECTION_CLOSED .../_i18n/a25a5110/en-U",
  "errorKeyword": "失败",
  "goal": "在 workspaces/browser-auto、deepseek-ai/dsh-ptc-runtime-node 新增, 最近报错 失败",
  "confidence": 0.9
 }
}
```

```json
{
 "sample": "修代理",
 "session": "1911b5f4-725c-4785-bc19-0efc7f76026d",
 "index": 1841,
 "userText": "你帮我修一下代理吧，让他自己能就是能控制这个数据面。因为他本身就是要去维护这个数据面的可用性的呀，所以他自己就得去重启的。你主要去搞这个。",
 "state": {
  "modules": [
   "workspaces/browser-auto",
   "tmp",
   "vendor/genspark2api"
  ],
  "action": "修改",
  "project": "HX-Jungle",
  "files": [
   "workspaces/browser-auto/genspark-register/src/genspark/proto_register.py",
   "/tmp/gs_bridge.log",
   "/tmp/batch_reg.log",
   "/tmp/new_accounts.json",
   "/tmp/batch_reg.py",
   "/vendor/genspark2api/accounts.json",
   "workspaces/browser-auto/genspark-register/.venv/lib/python3.13/site-packages/curl_cffi/requests/session.py",
   "/tmp/batch_alias.log"
  ],
  "error": ": true` — **新号立刻没额度** ⇒ 上游收紧了：新号不再发放每日 100。 ## 本轮关键发现（有实证） 1. **7890 端口整体未监听**（mihomo 数据面挂了）— 所有 svc-* 出口全 000。这是今天补号失败的真正原因（不是注册逻辑） 2. **直连可用**（200）— 台账页 03 早说",
  "errorKeyword": "失败",
  "goal": "在 workspaces/browser-auto、tmp 修改, 最近报错 失败",
  "confidence": 0.9
 }
}
```

```json
{
 "sample": "低信息 next",
 "session": "5d144edf-e119-4fab-961b-66a8be3d163b",
 "index": 490,
 "userText": "next",
 "state": {
  "modules": [
   "workspaces/browser-auto",
   "app",
   "tmp",
   ".agents/notes"
  ],
  "action": "修改",
  "project": "HX-Jungle",
  "files": [
   "workspaces/browser-auto/gmail-login/server/app/egress_src.py",
   "workspaces/browser-auto/gmail-login/server/app/egress_bind.py",
   "workspaces/browser-auto/gmail-login/tools/fp_probe.py",
   "app/egress_src.py",
   "/tmp/msg1.txt",
   "app/egress_bind.py",
   ".agents/notes/implemented/feature/2026-10-10-fingerprint-stability-no-legacy-self-replication.md",
   "workspaces/browser-auto/scripts/freebuff-register/cloak_launch.py"
  ],
  "error": "e[\"same_as_host\"] = bool(host_ip and info == host_ip) 307: else: 308: e[\"probe_error\"] = info 309: break 310: for e in items: 311: e.setdefault(\"same_as_host\", ",
  "errorKeyword": "Error",
  "goal": "在 workspaces/browser-auto、app 修改, 最近报错 Error",
  "confidence": 0.9
 }
}
```
