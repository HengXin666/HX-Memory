// src/adapters/dsh/client/styles.ts — HX-Memory review 面板样式 (零依赖内联)。
export const styles = `
.hxmem-review { font-size: 13px; line-height: 1.6; }
.hxmem-review h3 { margin: 0 0 8px; font-size: 14px; }
.hxmem-review .row { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(128,128,128,.2); }
.hxmem-review .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.hxmem-review .badge.proposed { background: #e6a81722; color: #b8860b; }
.hxmem-review .badge.confirmed { background: #2e7d3222; color: #2e7d32; }
.hxmem-review .badge.rejected { background: #c6282822; color: #c62828; }
.hxmem-review .rule-text { flex: 1; }
.hxmem-review .meta { color: #888; font-size: 12px; }
.hxmem-review button { font-size: 12px; padding: 2px 10px; border-radius: 6px; border: 1px solid #8888; background: transparent; cursor: pointer; }
.hxmem-review button.confirm { color: #2e7d32; border-color: #2e7d3288; }
.hxmem-review button.reject { color: #c62828; border-color: #c6282888; }
.hxmem-review .empty { color: #888; padding: 12px 0; }
`;
