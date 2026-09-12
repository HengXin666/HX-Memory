// src/adapters/dsh/client/styles.ts — HX-Memory 面板样式 (零依赖, 一段字符串)。
//
// 规则:
//  1) 所有选择器都以 .hxmem-review / .hxmem-bindings / .hxmem-settings-card 起头,
//     不会漏进宿主界面 (CSS 没有作用域); 设置卡同时挂 .hxmem-bindings 复用整套设置样式;
//  2) 颜色全部优先取宿主主题变量 (--dsw-alias-*), 缺失时退回中性命色, 明暗两套主题都不至于糊;
//  3) 间距走 --hxmem-s1..s4 一档比例, 行/卡片分离靠 background + radius, 不用 <hr>;
//  4) 徽章按 kind / scope / status 分色; status-* 是原生 badge (见 review-page 的 p.status)。
// 无 emoji (仓库约定)。

export const styles = `
.hxmem-review, .hxmem-bindings {
  --hxmem-s1: 4px;
  --hxmem-s2: 8px;
  --hxmem-s3: 12px;
  --hxmem-s4: 16px;
  --hxmem-radius: 8px;
  --hxmem-line: 1px solid rgba(128, 128, 128, 0.24);
  --hxmem-surface: rgba(128, 128, 128, 0.07);
  --hxmem-surface-strong: rgba(128, 128, 128, 0.13);
  --hxmem-text: var(--dsw-alias-label-primary, inherit);
  --hxmem-muted: var(--dsw-alias-label-tertiary, #83838c);
  --hxmem-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --hxmem-success: var(--dsw-alias-state-success-primary, #1f9d55);
  --hxmem-danger: var(--dsw-alias-state-error-primary, #e5484d);
  --hxmem-warn: var(--dsw-alias-state-warn-primary, #b8860b);
  font-size: var(--dsw-font-xs-13-font-size, 13px);
  line-height: var(--dsw-font-xs-13-line-height, 1.6);
  color: var(--hxmem-text);
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s3);
}

/* ---------- 通用构件 ---------- */

.hxmem-review h3,
.hxmem-bindings h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.hxmem-review p,
.hxmem-bindings p {
  margin: 0;
}

.hxmem-review .meta,
.hxmem-bindings .meta {
  color: var(--hxmem-muted);
  font-size: 12px;
}

.hxmem-review .hint,
.hxmem-bindings .hint {
  color: var(--hxmem-muted);
  font-size: 12px;
  line-height: 1.5;
}

.hxmem-review .spacer,
.hxmem-bindings .spacer {
  flex: 1;
}

.hxmem-review .empty,
.hxmem-bindings .empty {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s1);
  justify-content: center;
  min-height: 120px;
  padding: var(--hxmem-s4);
  border: 1px dashed rgba(128, 128, 128, 0.35);
  border-radius: var(--hxmem-radius);
  color: var(--hxmem-muted);
  text-align: center;
}

.hxmem-review .empty.small,
.hxmem-bindings .empty.small {
  min-height: 0;
  padding: var(--hxmem-s2);
  border: none;
  background: transparent;
  font-size: 12px;
  text-align: left;
}

/* 徽章: 基础为中性, 具体色由 kind/scope/状态类覆盖。 */
.hxmem-review .badge,
.hxmem-bindings .badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.7;
  white-space: nowrap;
  background: var(--hxmem-surface-strong);
  color: var(--hxmem-text);
}

.hxmem-review .badge.soft,
.hxmem-bindings .badge.soft {
  background: transparent;
  border: var(--hxmem-line);
  color: var(--hxmem-muted);
}

/* 状态 (审阅队列)。 */
.hxmem-review .badge.proposed {
  background: rgba(230, 168, 23, 0.16);
  color: var(--hxmem-warn);
}
.hxmem-review .badge.confirmed {
  background: rgba(46, 125, 50, 0.16);
  color: var(--hxmem-success);
}
.hxmem-review .badge.rejected {
  background: rgba(198, 40, 40, 0.16);
  color: var(--hxmem-danger);
}

/* 类型 (kind): 六种记忆各自一色, 未知类型退回中性基础样式。 */
.hxmem-review .badge.k-fact {
  background: rgba(28, 126, 214, 0.16);
  color: #1c7ed6;
}
.hxmem-review .badge.k-preference {
  background: rgba(103, 65, 217, 0.16);
  color: #6741d9;
}
.hxmem-review .badge.k-decision {
  background: rgba(214, 51, 108, 0.16);
  color: #d6336c;
}
.hxmem-review .badge.k-lesson {
  background: rgba(232, 89, 12, 0.16);
  color: #e8590c;
}
.hxmem-review .badge.k-rule {
  background: rgba(47, 158, 68, 0.16);
  color: #2f9e44;
}
.hxmem-review .badge.k-pattern {
  background: rgba(128, 128, 128, 0.2);
  color: inherit;
}

/* 深色主题: 宿主用 body[data-ds-dark-theme] / .dark 切换, 别名色会自动翻转;
   类型/范围徽章用的是固定色 (浅底深字), 深色下必须换成更亮的一档才不会糊。 */
body[data-ds-dark-theme] .hxmem-review .badge.k-fact,
.dark .hxmem-review .badge.k-fact {
  color: #74c0fc;
}
body[data-ds-dark-theme] .hxmem-review .badge.k-preference,
.dark .hxmem-review .badge.k-preference {
  color: #b197fc;
}
body[data-ds-dark-theme] .hxmem-review .badge.k-decision,
.dark .hxmem-review .badge.k-decision {
  color: #f783ac;
}
body[data-ds-dark-theme] .hxmem-review .badge.k-lesson,
.dark .hxmem-review .badge.k-lesson {
  color: #ffa94d;
}
body[data-ds-dark-theme] .hxmem-review .badge.k-rule,
.dark .hxmem-review .badge.k-rule {
  color: #69db7c;
}
body[data-ds-dark-theme] .hxmem-review .badge.s-global,
.dark .hxmem-review .badge.s-global {
  color: #69db7c;
  border-color: rgba(105, 219, 124, 0.5);
}
body[data-ds-dark-theme] .hxmem-review .badge.s-agent,
.dark .hxmem-review .badge.s-agent {
  color: #f783ac;
  border-color: rgba(247, 131, 172, 0.5);
}

/* 范围 (scope)。 */
.hxmem-review .badge.s-project {
  border-color: rgba(77, 107, 254, 0.5);
  color: var(--hxmem-accent);
}
.hxmem-review .badge.s-global {
  border-color: rgba(47, 158, 68, 0.5);
  color: #2f9e44;
}
.hxmem-review .badge.s-agent {
  border-color: rgba(214, 51, 108, 0.5);
  color: #d6336c;
}

.hxmem-review .badge.rank {
  font-variant-numeric: tabular-nums;
  color: var(--hxmem-muted);
  background: transparent;
  border: var(--hxmem-line);
}

/* 记忆注入设置卡 (宿主「设置 → 插件」页): 只加卡片自身的留白与标题行, 其余复用上面这套。 */
.hxmem-settings-card {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s3) 0;
}

.hxmem-settings-card .head {
  display: flex;
  align-items: baseline;
  gap: var(--hxmem-s2);
}

/* 按钮: 默认中性, .primary/.confirm/.reject/.danger/.ghost 各自着色。 */
.hxmem-review button,
.hxmem-bindings button {
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  border: var(--hxmem-line);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.hxmem-review button:hover:not(:disabled),
.hxmem-bindings button:hover:not(:disabled) {
  background: var(--hxmem-surface-strong);
}

.hxmem-review button:focus-visible,
.hxmem-bindings button:focus-visible {
  outline: 2px solid var(--hxmem-accent);
  outline-offset: 1px;
}

.hxmem-review button:disabled,
.hxmem-bindings button:disabled {
  opacity: 0.55;
  cursor: default;
}

.hxmem-review button.primary,
.hxmem-bindings button.primary {
  background: var(--hxmem-accent);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}

.hxmem-review button.confirm {
  color: var(--hxmem-success);
  border-color: rgba(46, 125, 50, 0.5);
}

.hxmem-review button.reject,
.hxmem-review button.danger,
.hxmem-bindings button.danger {
  color: var(--hxmem-danger);
  border-color: rgba(198, 40, 40, 0.4);
}

.hxmem-review button.ghost,
.hxmem-bindings button.ghost {
  color: var(--hxmem-muted);
}

.hxmem-review input,
.hxmem-review select,
.hxmem-bindings input,
.hxmem-bindings select {
  font: inherit;
  font-size: 12px;
  min-width: 0;
  padding: 3px 8px;
  border-radius: 6px;
  border: var(--hxmem-line);
  background: var(--dsw-alias-bg-base, transparent);
  color: inherit;
}

.hxmem-review input:focus,
.hxmem-review select:focus,
.hxmem-bindings input:focus,
.hxmem-bindings select:focus {
  outline: none;
  border-color: var(--hxmem-accent);
}

/* 提示条 (信息/警告/错误)。 */
.hxmem-review .banner,
.hxmem-bindings .banner {
  padding: var(--hxmem-s2) var(--hxmem-s3);
  border-radius: var(--hxmem-radius);
  border-left: 3px solid var(--hxmem-muted);
  background: var(--hxmem-surface);
  font-size: 12px;
  line-height: 1.55;
}

.hxmem-review .banner.info,
.hxmem-bindings .banner.info {
  border-left-color: var(--hxmem-accent);
}

.hxmem-review .banner.warn,
.hxmem-bindings .banner.warn {
  border-left-color: var(--hxmem-warn);
  background: rgba(230, 168, 23, 0.12);
}

.hxmem-review .banner.err,
.hxmem-bindings .banner.err {
  border-left-color: var(--hxmem-danger);
  background: rgba(198, 40, 40, 0.12);
}

/* ---------- 审阅页 ---------- */

.hxmem-review .tabs {
  display: flex;
  gap: var(--hxmem-s1);
  padding: var(--hxmem-s1);
  border-radius: 999px;
  background: var(--hxmem-surface);
}

.hxmem-review .tab {
  flex: 1;
  border-color: transparent;
  border-radius: 999px;
  color: var(--hxmem-muted);
}

.hxmem-review .tab.on {
  background: var(--dsw-alias-bg-base, rgba(128, 128, 128, 0.18));
  color: var(--hxmem-text);
  font-weight: 600;
}

.hxmem-review .pane {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s3);
}

.hxmem-review .section-title {
  display: flex;
  align-items: baseline;
  gap: var(--hxmem-s2);
  margin-top: var(--hxmem-s1);
}

.hxmem-review .section-title .count {
  color: var(--hxmem-muted);
  font-size: 12px;
  font-weight: 400;
}

/* 批次状态栏 */
.hxmem-review .status {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s3);
  border: var(--hxmem-line);
  border-radius: var(--hxmem-radius);
  background: var(--hxmem-surface);
}

.hxmem-review .status-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--hxmem-s2);
}

.hxmem-review .status-title {
  font-weight: 600;
}

.hxmem-review .status-head .ghost {
  margin-left: auto;
}

.hxmem-review .stats {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--hxmem-s4);
}

.hxmem-review .stat {
  display: flex;
  align-items: baseline;
  gap: var(--hxmem-s1);
}

.hxmem-review .stat b {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.hxmem-review .stat-label {
  color: var(--hxmem-muted);
  font-size: 11px;
}

.hxmem-review .actions {
  display: flex;
  align-items: center;
  gap: var(--hxmem-s2);
}

/* 运行时脉冲点 (纯 CSS 动画)。 */
.hxmem-review .pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--hxmem-accent);
  animation: hxmem-pulse 1.1s ease-in-out infinite;
}

@keyframes hxmem-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.15); }
}

@media (prefers-reduced-motion: reduce) {
  .hxmem-review .pulse {
    animation: none;
    opacity: 0.7;
  }
}

/* 批次报告 */
.hxmem-review .report {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s3);
  border: var(--hxmem-line);
  border-left: 3px solid var(--hxmem-accent);
  border-radius: var(--hxmem-radius);
}

.hxmem-review .report.bad {
  border-left-color: var(--hxmem-danger);
}

.hxmem-review .report-head {
  display: flex;
  align-items: center;
  gap: var(--hxmem-s2);
}

/* 行 / 列表 */
.hxmem-review .list {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s1);
}

.hxmem-review .row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s2) var(--hxmem-s3);
  border-radius: var(--hxmem-radius);
  background: var(--hxmem-surface);
  transition: background 0.15s ease;
}

.hxmem-review .row:hover {
  background: var(--hxmem-surface-strong);
}

.hxmem-review .rule-text {
  flex: 1;
  min-width: 180px;
  overflow-wrap: anywhere;
}

.hxmem-review .row-actions {
  display: flex;
  gap: var(--hxmem-s1);
}

.hxmem-review .search {
  display: flex;
  gap: var(--hxmem-s2);
}

.hxmem-review .search input {
  flex: 1;
  padding: 5px 10px;
}

/* 调用记录 */
.hxmem-review .inv {
  padding: var(--hxmem-s2) var(--hxmem-s3);
  border: var(--hxmem-line);
  border-radius: var(--hxmem-radius);
}

.hxmem-review .inv summary {
  display: flex;
  align-items: center;
  gap: var(--hxmem-s2);
  cursor: pointer;
  list-style: none;
}

.hxmem-review .inv summary::-webkit-details-marker {
  display: none;
}

.hxmem-review .inv-task {
  font-weight: 600;
}

.hxmem-review .inv summary .meta {
  margin-left: auto;
}

.hxmem-review .inv-body {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s2);
  margin-top: var(--hxmem-s2);
}

.hxmem-review .inv-field b {
  display: block;
  color: var(--hxmem-muted);
  font-size: 11px;
  font-weight: 600;
}

.hxmem-review .inv-field pre {
  margin: var(--hxmem-s1) 0 0;
  padding: var(--hxmem-s2);
  border-radius: 6px;
  background: var(--dsw-alias-markdown-code-block, var(--hxmem-surface));
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow: auto;
}

/* ---------- 绑定页 ---------- */

.hxmem-bindings .head {
  display: flex;
  align-items: flex-start;
  gap: var(--hxmem-s2);
}

.hxmem-bindings .head > div {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s1);
}

.hxmem-bindings .toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--hxmem-s1);
  padding: 2px 10px 2px 6px;
  border: var(--hxmem-line);
  border-radius: 999px;
  font-size: 12px;
  color: var(--hxmem-muted);
  cursor: pointer;
  white-space: nowrap;
}

.hxmem-bindings .toggle:hover {
  background: var(--hxmem-surface);
}

/* 一键模板 */
.hxmem-bindings .presets {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s3);
  border: var(--hxmem-line);
  border-radius: var(--hxmem-radius);
  background: var(--hxmem-surface);
}

.hxmem-bindings .presets-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--hxmem-s1) var(--hxmem-s2);
}

.hxmem-bindings .presets-title {
  font-weight: 600;
  font-size: 12px;
}

.hxmem-bindings .preset-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--hxmem-s2);
}

.hxmem-bindings .chip {
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--hxmem-accent);
  border-color: rgba(77, 107, 254, 0.45);
}

.hxmem-bindings .chip:hover:not(:disabled) {
  background: rgba(77, 107, 254, 0.14);
}

/* 项目卡片 */
.hxmem-bindings .projects {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s3);
}

.hxmem-bindings .project {
  display: flex;
  flex-direction: column;
  gap: var(--hxmem-s1);
  padding: var(--hxmem-s2) var(--hxmem-s3) var(--hxmem-s3);
  border: var(--hxmem-line);
  border-radius: var(--hxmem-radius);
}

.hxmem-bindings .project.current {
  border-color: rgba(77, 107, 254, 0.45);
}

.hxmem-bindings .project-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--hxmem-s2);
  padding-bottom: var(--hxmem-s2);
  border-bottom: var(--hxmem-line);
}

.hxmem-bindings .project-head .proj {
  width: 160px;
  font-weight: 600;
}

/* 字段行: 高密度但每格都有标签 */
.hxmem-bindings .field-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--hxmem-s2);
  padding: var(--hxmem-s2) 0;
}

.hxmem-bindings .field-row + .field-row {
  border-top: var(--hxmem-line);
}

.hxmem-bindings .field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.hxmem-bindings .field input,
.hxmem-bindings .field select {
  width: 100%;
}

.hxmem-bindings .field:not(.grow) {
  width: 130px;
}

.hxmem-bindings .field.grow {
  flex: 1;
  min-width: 160px;
}

.hxmem-bindings .field-label {
  color: var(--hxmem-muted);
  font-size: 11px;
}

.hxmem-bindings .foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--hxmem-s2);
  padding-top: var(--hxmem-s2);
  border-top: var(--hxmem-line);
}
`;
