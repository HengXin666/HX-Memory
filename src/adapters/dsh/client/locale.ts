// src/adapters/dsh/client/locale.ts — review 面板文案。

export type Locale = typeof reviewEn;
export const reviewEn = {
  nav: "HX-Memory Review",
  title: "HX-Memory Review Queue",
  desc: "Confirm or reject generalization proposals. Confirmed proposals become cross-project rules.",
  queue: "Proposals",
  empty: "No pending proposals. Run a generalization batch to surface lessons here.",
  covers: "covers {n} instance(s)",
  confirm: "Confirm as rule",
  reject: "Reject",
  confirmed: "confirmed",
  rejected: "rejected",
  source: "source: {run}",
  browse: "Memory Browse",
  search: "Search memory...",
};

export const reviewZh = {
  nav: "HX-Memory 审阅",
  title: "HX-Memory 推广审阅队列",
  desc: "确认或驳回推广提议。确认后提议成为跨项目规则。",
  queue: "待审提议",
  empty: "暂无待审提议。运行一次推广批次后, 经验教训会出现在这里。",
  covers: "覆盖 {n} 条实例",
  confirm: "确认为规则",
  reject: "驳回",
  confirmed: "已确认",
  rejected: "已驳回",
  source: "来源: {run}",
  browse: "记忆浏览",
  search: "搜索记忆...",
};
