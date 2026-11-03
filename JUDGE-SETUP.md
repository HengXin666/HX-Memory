# JUDGE-SETUP: 判官配置结果

## 1 结论

配通了。judgeConfigured = true (judgeMissing = [])。

## 2 怎么配的

拿到 exec 通道以后, 我按任务书的顺序查了一遍, 找到第一个可用的就停了:

| # | 位置 | 结论 |
|---|------|------|
| 1 | exec 进程的环境变量 | 没有: 没有 api_key / *_key / token 类变量 |
| 2 | ~/.dsh/ | 有: ~/.dsh/.credentials.yaml 里有 WOA_API_KEY; ~/.dsh/settings.yaml.imported.kept 里 agent-default-model 是 provider woa, model deepseek-v4.1-flash; woa 的 baseURL 是 http://127.0.0.1:15721/tencent/v1, api 是 openai-completions |
| 3 | HX-Jungle credentials.py list | 没查: 位置 2 已经找到可用凭据 |
| 4 | GET /api/embedding | 查了, 嵌入模型也是全空 (source none), 没有可以复用的 |
| 5 | 仓库里的 .env / local 配置 | 没有 |

写进去的配置:
- base_url = http://127.0.0.1:15721/tencent/v1
- model = deepseek-v4.1-flash
- key 来源 = ~/.dsh/.credentials.yaml 里的 WOA_API_KEY, 掩码 tts…e1bc
- key_mode = encrypted (exec 进程环境里没有这个变量, 所以没用 env 模式), temperature = 0.2
- 写入方式: PUT http://127.0.0.1:36100/api/model 返回 HTTP 200 {"ok":true}
- 写入位置: /home/hx/.config/hx-memory-panel/panel.json (AES-256-GCM, 主密钥在 master.key, 权限 0600)

写入之前, 我先在本机用同一个 key 直接调了 base_url/chat/completions: HTTP 200, reply "ok"。

## 3 POST /api/model/test 的返回

    curl -s -X POST http://127.0.0.1:36100/api/model/test   -> HTTP 200

用户复测的结果:
    status: 200
    ms: 1887
    reply: "ok"
    usage: total_tokens 54
    error: null
    keyUsed: tts…e1bc

我写入后跑的那次: status 200, ms 1839, reply "ok", usage 是 prompt 42 / completion 15 / total 57, 上游回报的 model 是 deepseek-v4.1-flash-ioa。

## 4 GET /api/model 的关键字段

    curl -s http://127.0.0.1:36100/api/model   -> HTTP 200
    {
      "judgeConfigured": true,
      "judgeMissing": [],
      "base_url": "http://127.0.0.1:15721/tencent/v1",
      "model": "deepseek-v4.1-flash",
      "key_mode": "encrypted",
      "has_key": true,
      "api_key_masked": "tts…e1bc",
      "updatedAt": "2026-11-03T13:47:31.716Z"
    }

## 5 correction-effect 的 C1 / C2 / C3

C2 (确定性计算, 用不到判官), 命令是:

    node --experimental-strip-types --no-warnings scripts/eval/correction-effect.ts --out eval-out

退出码 1 (测到了, 但没达标)。stdout 原文:

    C2=0.360 (前段有同类纠正的规则 359 条 / 可判 432 条 / 库里规则+教训 443 条)  对照(全部纠正)=-0.472  threshold 0.5  leakage 0 (源无会话 id 的规则 376 条, 泄漏检查对它们不可判; 前段一律排除 T 前 2 小时)
    用户消息 8874 条, 检测器判中 2170 条 (候选 A); 窗口 ±14 天; 读不了的会话 0
    口径: 词项同类 + 线上检测器, 无判官; 产物 /home/hx/Loli/code/HXLoLis/components/HX-Memory/eval-out/C2.json

C3 / C1, 命令同上再加 --same-turn。退出码 2, stdout:

    C3 = 未测: 需要判官判定「下一 step 的行为是否与评审结论一致」, 面板 /api/model 的判官未配置 (judgeConfigured=false); C1 同因 n=0。

上一份报告的判断现在仍然成立: 就算判官配通了, C1 / C3 也测不出来。scripts/eval/correction-effect.ts:36-39 在带 --same-turn 时只打印一句写死的文本, 然后 exit 2。整个脚本没有 fetch, 没有调 /api/model, 也不读 panel.json。上面这次运行就是证据: 判官已经是 true 了, 它还在打印 "judgeConfigured=false"。要拿到 C1 / C3, 得给脚本补上调用判官的实现。那是改代码的活, 不在本任务范围内, 所以我没动脚本。

## 6 副作用: 判官不独立

判官指向的是本机 127.0.0.1:15721 上的 tencent 反代, 用的 key 是 ~/.dsh/.credentials.yaml 里的 WOA_API_KEY。这和 DSH 宿主默认模型 (provider woa, deepseek-v4.1-flash) 是同一个上游、同一个 key、同一份额度。所以:
- 判官和宿主模型是同一个模型家族、同一个上游, 不能算独立判官。凡是说"判官独立评审"的结论, 都要打这个折扣。
- 宿主把额度用完的时候, 判官会跟着一起失效。
- 要换成独立判官, 用 PUT /api/model 改成另一个上游和模型就行, 比如 ~/.dsh/settings.yaml.imported.kept 里列的其他 provider。

## 7 .tmp/ 下的探针脚本

.tmp/ 在 .gitignore 里, 这些文件不会进版本。它们都是本次配判官时的只读探针, 值一律打掩码, 删了也没关系:
- .tmp/judge-probe.py: 列 exec 环境变量名, 列 ~/.dsh 目录, 读面板的 /api/model 和 /api/embedding
- .tmp/judge-probe2.py: 扫 ~/.dsh/.env、.credentials.yaml、settings.yaml.imported*、llm-deepseek/、profiles/ 里的 base_url / model / key 字段名 (key 只打前几位和长度)
- .tmp/judge-probe3.py: 打出 settings.yaml.imported.kept 的 provider 结构, 隐藏 secret 行
- .tmp/judge-probe4.py: 读 WOA_API_KEY, 直连 chat/completions 测试, 然后 PUT /api/model、POST /api/model/test、GET /api/model, 输出里的 key 都打码

## 8 判据自查

1. 文件大于 1500 字节: 是, 写回后用 wc -c 核对。
2. 出现 judgeConfigured 且后跟 true: 是, 第 1 节和第 4 节都有。
3. 至少一个 curl 命令加 HTTP 状态码: 是, 第 3、4 节 (HTTP 200)。
4. 全文没有长度超过 20 的连续字母数字串: 是, key 只写了掩码 tts…e1bc, 没写 token, 也没写哈希。
5. 出现 /api/model/test 的 reply 内容: 是, reply "ok"。
