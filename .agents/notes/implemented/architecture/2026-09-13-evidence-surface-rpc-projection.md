# Agent Note: 四类证据面的 RPC 投影 (契约面不搬家, 实现面按行数上限拆)

Status: implemented

## Problem

`scheduleLog` / `captureLog` / `maintenance` 三本账与"人审依据"都各自有了真相文件
(见对应的 feature Note), 但**没有任何出口**把它们送到面板:

- 账本是 JSONL 追加文件, 宿主侧只认 RPC。没有端点 = 用户还是只能 `tail` 文件;
- 面板要的是**视图形状** (聚合计数 + 最近记录 + 磁盘体量), 不是原始行; 在客户端做聚合意味着
  把保留期与体量逻辑复制一份到前端, 两处口径必然分叉;
- `gateway.ts` 同时是**契约面** (`HxMemoryGateway` 的 remote 方法 + 视图形状的导出点,
  宿主与既有测试都 import 它)。往里塞投影实现会先撞 400 行上限, 再让"契约"与"投影细节"混住。

## Decision

新增 5 个 RPC 端点, 并把投影实现移出 `gateway.ts`:

| 端点 | 证据面 | 回答的问题 |
| --- | --- | --- |
| `scheduleLog` | 注入调度账本 | 这一轮为什么注入 / 为什么没注入 |
| `captureLog` | 捕获耗时账本 | 沉淀有没有拖慢这一轮、拖在哪一段、为什么没沉淀 |
| `maintenance` | 维护调度器 | 它最近跑了没有、成功没有、下次什么时候 |
| `entriesByIds` | 人审提议 | 提议只带 covers 的 id, 原文必须能取回来 |
| `contradictions` / `projectFlagged` | 被标注记忆 | 反馈通道 (只记坏的) 的聚合出口 |

两条边界:

1. **视图形状仍从 `gateway.ts` 转出** (再导出)。宿主与既有测试 import 的是 gateway ——
   契约面不搬家, 搬的只是实现。把导出点也挪走会让调用方为了一个类型改 import。
2. **投影实现拆进 `gateway-observability.ts` (账本) 与 `gateway-review.ts` (人审)**。
   拆两处而不是一处: 账本是"时间序列聚合" (按会话/按天), 人审是"按 id 取原文再展开 covers",
   两者的输入形状与失效模式都不同, 合在一个文件里只是把两个职责塞进一个文件的下限。

`entriesByIds` 有两个被测试钉住的细节: **去重** (同一个 id 出现两次会让展开列表里出现
两条一模一样的依据) 与 **上限封顶** (面板一次最多展开一条提议, 防止被构造出大扫描)。

## Alternatives considered

**让面板直接读 JSONL 文件。** 宿主 UI 没有文件系统权限, 而且保留期/体量逻辑会被复制到前端 ——
两处口径分叉是这类"看起来能用"的方案最常见的失效方式。

**在 `gateway.ts` 里直接写投影。** 先撞 400 行上限 (本仓库的硬闸门), 更根本的是让
"契约"与"实现细节"混住: 契约的读者是宿主, 实现的读者是维护者。

**每个证据面各开一个 gateway 类。** 宿主按 service 发现 RPC, 多开会让"一个插件一个远端服务"
这条身份关系变模糊, 也会让 `assertRemoteContract` 的整组校验失去意义。

**视图形状改从投影文件导出 (契约随实现搬)。** 调用方要为一个类型改 import, 而"契约面在哪"
本该是稳定的; 实现怎么搬都不该让调用方知道。

## Consequences

- 四类证据第一次在面板上**可查**, 而不是"文件在那, 自己 tail"。每个端点在没有挂载对应账本时
  明确返回 `available:false`, 面板区分"没数据"与"没接上"。
- 代价: gateway 多了一层转发导出, 以及两个新的投影文件需要跟着契约走。
- `contradictions` 由旧位置移入 `gateway-review`, 因此 `remote-methods.ts` 的方法清单需要
  同步 —— 它是**单一事实源**, 由 `assertRemoteContract` 在装配期比对, 漏掉会在启动时炸而不是
  运行时静默 404。

## Testing

- `tests/s2/remote-methods.test.ts`: 方法清单与实现逐一对齐 (装配期整组校验)。
- `tests/s2/review-projection.test.ts` / `tests/s2/review-covers.test.ts`: 投影形状、
  `entriesByIds` 的去重与上限封顶。
- `tests/s2/schedule-log.test.ts` / `tests/s2/capture-log.test.ts`: 三个账本端点的聚合读数。
- `tests/s3/dsh-adapter.test.ts`: 端到端接线 (账本真的被前一步写入, 端点真的读得到)。
