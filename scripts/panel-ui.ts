// scripts/panel-ui.ts — @hx/ui 的按需入口 (暂存为 .tmp/panel/src/ui.ts)。
// 只引面板用到的组件源码, 不走整包 barrel (整包会拖进 monaco / xyflow); 路径范式与 HX-AI-Review/cf-admin/pages/vendor/ui-entry.ts 相同。
export { Button } from "../node_modules/@hx/ui/src/primitives/button.tsx";
export { Input } from "../node_modules/@hx/ui/src/primitives/input.tsx";
export { Textarea } from "../node_modules/@hx/ui/src/primitives/textarea.tsx";
export { Alert, AlertDescription, AlertTitle } from "../node_modules/@hx/ui/src/primitives/alert.tsx";
export { Badge } from "../node_modules/@hx/ui/src/layout/Badge.tsx";
export { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../node_modules/@hx/ui/src/layout/Card.tsx";
export { DataTable } from "../node_modules/@hx/ui/src/layout/DataTable.tsx";
export { NavTabs } from "../node_modules/@hx/ui/src/layout/NavTabs.tsx";
export { PageHeader } from "../node_modules/@hx/ui/src/layout/PageHeader.tsx";
export { StatCard, StatGrid } from "../node_modules/@hx/ui/src/layout/StatCard.tsx";
