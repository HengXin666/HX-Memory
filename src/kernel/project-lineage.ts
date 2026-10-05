// kernel/project-lineage.ts — 项目键的**层级**契约: "一条记忆对哪个工作区可见"。
//
// 为什么需要它 (真实缺陷, 2026-09-18 实测):
//   HXLoLis 是一个 git 仓库, 它的 components/ 下挂着 3 个**独立仓库**
//   (HX-Memory / HX-Workflows / HXLoLi-NaGaMe; gitlink + .gitmodules 实测确认)。
//   项目键取 git root 的目录名, 于是:
//     在 HX-Memory 里开会话 → 键 "HX-Memory" (31 条)
//     在 HXLoLis  里开会话 → 键 "HXLoLis"  (46 条)
//   同一套代码库、同一个人的经验被切成两半, 彼此不可见 —— 这是"抓不住跨项目共通
//   经验"最具体的一条机制, 而它不会让任何测试变红 (两个键各自都是"正确"的)。
//
// 为什么不是"把键改成最外层仓库名" (被否掉的方案):
//   那样 HXLoLis 下 4 个组件仓库会合并成一个键, HX-Memory 的私有记忆会注入进
//   HX-Workflows 的对话 —— 那是本项目**已经修过一次**的跨项目泄漏
//   (见 tests/s2/trigger-cache-project.test.ts 的实测记录: 8 个项目的条目混进一次注入)。
//   合并与隔离都是错的, 因为真实关系既不是"同一个"也不是"无关", 而是**祖先与后代**。
//
// 决定: 项目键保留单值 (不改存储格式), 但**匹配**用祖先链上的偏序:
//   "当前工作区可见的条目" = 条目的 project 出现在当前工作区的祖先链上。
//   - 子仓库里工作 → 祖先链 [HX-Memory, HXLoLis] → 自己的记忆 + 父工程的记忆都可见;
//   - 父工程里工作 → 祖先链 [HXLoLis] → 只看得到父工程自己的记忆, 看不到子仓库私有的;
//   - 兄弟仓库 (HX-Sagasu) → 不在链上 → 严格不可见。
//   这个偏序是**非对称**的, 也正是嵌套仓库真实的可见性方向: 组件是父工程的一部分,
//   父工程不是组件的一部分。
//
// 放在 kernel: 纯函数、零依赖, 被捕获/召回/绑定/面板四层共用同一口径
// (口径分叉的症状是"记忆明明在, 换个目录就看不见了", 且不影响任何测试)。

/**
 * 工作区的**项目祖先链**: 从最内层仓库到最外层, 每项是一个仓库名 (项目键)。
 *
 * 例: 在 HXLoLis/components/HX-Memory 里工作 → ["HX-Memory", "HXLoLis"]。
 * 空数组 = 没有工作区上下文 (此时只该给跨项目规则, 一条项目内条目都不给)。
 */
export type ProjectLineage = readonly string[];

/**
 * 工作区上下文: 项目键 + 祖先链。
 *
 * 定义在 kernel 而不是 adapters: 它是**跨层契约** (捕获写、召回过滤、绑定匹配、面板预填
 * 共用它), 而 kernel 不许依赖 adapters —— 放在 adapter 里会让内核反向依赖外层。
 */
export interface ProjectScope {
  project?: string;
  lineage?: readonly string[];
}

/**
 * 工作区标识的两种写法: 字符串 = 只有项目键 (老调用点, 退化为单值语义);
 * 对象 = 带祖先链 (新调用点, 获得层级可见性)。
 * 两者都接受是为了让既有调用点与既有测试**一字不改** —— 层级能力是叠加的, 不是替换。
 */
export type ProjectScopeArg = string | ProjectScope;

/** 归一化工作区标识; 空字符串/空对象 → undefined (= "没有工作区上下文")。 */
export function normalizeScopeArg(scope?: ProjectScopeArg): ProjectScope | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope === "string") return scope ? { project: scope } : undefined;
  if (!scope.project && !scope.lineage?.length) return undefined;
  return scope;
}

/** 项目键的分隔符 (多层祖先链的序列化形式, 见 encodeLineage)。 */
export const LINEAGE_SEP = "\u0000";

/**
 * 一条工作区路径上的**仓库祖先链**, 从最内层到最外层。
 *
 * @param toplevels 当前目录到最外层依次的仓库根 (调用方用 git 解析; 越靠内越先)。
 *   解析不到任何仓库根时传空数组 —— 回退由调用方决定 (目录名), 这里只管层级。
 * @returns 去重后的仓库名链 (最内层在前); 空输入返回空数组。
 */
export function lineageOfToplevels(toplevels: readonly string[]): string[] {
  const out: string[] = [];
  for (const top of toplevels) {
    const name = dirNameOf(top);
    if (!name) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** 路径最后一段 (纯函数, 供 lineageOfToplevels 使用)。 */
export function dirNameOf(path: string): string | undefined {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const name = trimmed.split(/[\\/]/).pop();
  return name && name.length ? name : undefined;
}

/**
 * 祖先链 → 存储用的**单一项目键** (写路径)。
 *
 * 只写**最内层**仓库名: 存储格式因此完全不变 (老数据仍然可读), 而"谁能看见它"
 * 由读取期的祖先链匹配决定 —— 可见性是读取期的性质, 不该在写入期被固化成一条
 * 无法追溯的合成键 (那样老数据的 lineage 无从重建)。
 */
export function projectKeyOfLineage(lineage: readonly string[]): string | undefined {
  return lineage.length ? lineage[0] : undefined;
}

/**
 * 当前工作区的祖先链序列化 (缓存键用; 让"同一祖先链"的会话复用同一份 always-on)。
 *
 * 用 NUL 分隔而不是逗号/斜杠: 项目名里可能含这些字符, 用可打印分隔符会产生
 * "a.b|c" 与 "a|b.c" 这类碰撞 —— 缓存键一碰撞就是跨项目串数据。
 */
export function encodeLineage(lineage: readonly string[]): string {
  return lineage.join(LINEAGE_SEP);
}

/**
 * 那条记录对这条祖先链上的工作区**是否可见** (可见性判断的唯一口径)。
 *
 * 规则: 条目的 project 出现在祖先链上则可见 (条目属于本工作区或它的某个祖先);
 * 项目键为空 (agent/global 作用域) 的条目不属于任何项目, 由调用方按作用域另行处理。
 *
 * @param entryProject 条目的 project (undefined = 不属于任何项目)
 * @param lineage      当前工作区的祖先链 (最内层在前)
 */
export function lineageVisible(
  entryProject: string | undefined,
  lineage: readonly string[],
): boolean {
  if (!entryProject) return false;
  return lineage.includes(entryProject);
}

/**
 * 两条祖先链是否**可比** (同一条嵌套线上)。
 *
 * 用于绑定/面板的"这份配置是不是给我这个工作区的":
 * 绑定声明在父工程 (HXLoLis) 时, 子仓库 (HX-Memory) 里也应该命中 ——
 * 否则父工程写下的项目约定对组件内部完全无效, 那正是这次的缺陷。
 */
export function lineageComparable(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  // 可比 = 交集非空 (同一条祖先线上; 共享祖先即同一嵌套线)。
  for (const name of a) if (b.includes(name)) return true;
  return false;
}

/** 祖先链是否是另一条的**后代** (b 是 a 的祖先链)。 */
export function lineageDescendantOf(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || !b.length) return false;
  return b.every((name) => a.includes(name));
}

/**
 * 检索期的项目内条目**可见性判定** (HybridRetriever.inScope 用的唯一判据)。
 *
 * 抽到这里是为了让调用点只有一行 —— 检索主流程已经把"什么时候查"讲清楚了,
 * "谁可见"是另一个职责, 且必须与 selectAlwaysOn/绑定匹配共用同一份实现。
 *
 * @param entryProject 条目的 project
 * @param scope        请求的范围 (lineage 优先; 缺省退回单值精确匹配)
 * @returns true = 可见
 */
export function projectEntryVisible(
  entryProject: string | undefined,
  scope?: { project?: string; lineage?: readonly string[] },
  opts?: {
    /**
     * 调用方**要求项目范围** (agent 侧检索): 此时"没有工作区上下文" = **不可见**。
     *
     * ⚠ 为什么需要这个开关 (2026-09-27 实测的真实缺陷): 本函数在 scope 缺失时
     * 返回 true (全放行) —— 那是**面板 / CLI 搜索**要的语义 (管理面, 用户要看全库)。
     * 但 agent 侧检索的缺省必须**相反**: `memory_search` 不带 scope 时实测召回
     * **7/9 条属于别的项目** (HX-OutlookRegister / HX-Jungle / ds-test), 于是
     * "这个项目定了什么"被别的项目的结论回答。
     * 两者都对, 但不能共用一个缺省 —— 因此由调用方**显式声明**, 而不是改这里的默认值
     * (那会同时打断面板/CLI 的全库浏览)。语义与 `selectAlwaysOn` 一致:
     * 不知道是哪个工作区时, 一条项目内条目都不给, 而不是全都给。
     */
    required?: boolean;
  },
): boolean {
  if (scope?.lineage?.length) return lineageVisible(entryProject, scope.lineage);
  if (scope?.project !== undefined && entryProject !== undefined) {
    return entryProject === scope.project;
  }
  // 没有可用的工作区上下文: agent 侧要求范围 ⇒ 拒绝; 管理面 ⇒ 放行。
  return opts?.required ? false : true;
}
