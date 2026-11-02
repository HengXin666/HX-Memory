// scripts/panel-main.tsx — 面板前端入口 (scripts/panel.sh 把它暂存为 .tmp/panel/src/main.tsx 再 vite build)。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
