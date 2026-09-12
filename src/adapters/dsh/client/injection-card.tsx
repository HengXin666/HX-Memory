// src/adapters/dsh/client/injection-card.tsx — 「记忆注入」设置卡 (宿主 设置 → 插件 页里)。
//
// 为什么需要它 (用户诉求): 记忆此前**每轮**都往上下文里注入一份常驻条目, 用户明确要求
// "只在第 1 轮注入一次, 至少给个开关"。宿主把插件设置暴露成 settings 命名空间, 但面板
// 只列**有卡片的命名空间** (dsh-client-ui-settings-plugins: 服务端提供的命名空间 ∩ 注册了
// settings.plugin.item 的卡片) —— 所以不注册这张卡, 用户在界面上根本看不到也改不了。
//
// 写路径不走自家 gateway RPC, 而是宿主的 settingsScope (与 Host 同一份权威值,
// 带 revision 栅栏): 走 RPC 会绕开宿主的校验与冲突恢复, 两套写路径还会互相覆盖。
import { useEffect, useState } from "react";
import { modeOf, settledTo, type InjectionSnapshot, type InjectMode } from "./injection-mode.js";
import type { SettingsScopeLike } from "./settings-scope.js";

interface Props {
  scope: SettingsScopeLike;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export function InjectionModeCard({ scope, t }: Props): JSX.Element {
  const [snap, setSnap] = useState<InjectionSnapshot>(
    () => scope.getSnapshot() as InjectionSnapshot,
  );
  const [msg, setMsg] = useState("");
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot() as InjectionSnapshot)), [scope]);
  const current = modeOf(snap);
  const disabled = snap.writable === false;

  const choose = (mode: InjectMode) => {
    if (mode === current) return;
    setMsg("");
    // 刻意不看 promise 是否 reject: settingsScope 的合同是"冲突时自行恢复并重新广播",
    // 它 settle 意味着视图已刷新, 成败要看**回调后读回的权威值** ——
    // 看 reject 会把"面板已回滚到旧值"当成保存成功报给用户。
    void scope.set("injectMode", mode).then(() => {
      const ok = settledTo(scope, mode);
      setSnap(scope.getSnapshot() as InjectionSnapshot);
      setMsg(ok ? t("saved") : t("saveFailed"));
    });
  };

  return (
    // 同时挂 .hxmem-bindings: 它就是"设置类"面板的样式作用域 (变量/按钮/hint/field-row 全在
    // 其中), 卡片不必另起一套; .hxmem-settings-card 只补卡片自己的留白。
    <div className="hxmem-bindings hxmem-settings-card">
      <div className="head">
        <h3>{t("title")}</h3>
        <span className="spacer" />
        {msg ? <span className="hint">{msg}</span> : null}
      </div>
      <p className="hint">{t("desc")}</p>
      <div className="field-row">
        <button
          type="button"
          className={current === "first" ? "primary" : "ghost"}
          disabled={disabled}
          onClick={() => choose("first")}
        >
          {t("modeFirst")}
        </button>
        <button
          type="button"
          className={current === "every-turn" ? "primary" : "ghost"}
          disabled={disabled}
          onClick={() => choose("every-turn")}
        >
          {t("modeEveryTurn")}
        </button>
      </div>
      <p className="hint">{current === "first" ? t("modeFirstHint") : t("modeEveryTurnHint")}</p>
    </div>
  );
}
