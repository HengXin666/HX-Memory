// src/adapters/dsh/capture-review-bridge.ts — 待审队列的**面板桥** (磁盘 ↔ gateway)。
//
// 为什么抽出来 (2026-09-18): 这段注入块把 index.ts 顶过了 400 行上限, 而它本身是内聚的
// 一件事 —— "把 <root>/review-capture 下的队列文件包装成面板能用的三个方法"。
// 与 schedule-log / capture-log 同一范式: 服务端读盘, 浏览器侧碰不到文件系统。
//
// 为什么在这里过滤 pending: 面板的「待审」tab 展示的是**待裁决**的项;
// 已接受/已丢弃的留在文件里作审计痕迹 (见 review-queue.ts 的 setStatus 说明), 不占面板位置。
import type { CaptureReviewItem } from "../../capture/review-queue.ts";
import { readCaptureReview, setCaptureReviewStatus } from "../../capture/review-queue.ts";

/** 面板桥的形状 (与 gateway deps 的 captureReview 一致)。 */
export interface CaptureReviewBridge {
  recent(limit: number): CaptureReviewItem[];
  setStatus(id: string, status: "accepted" | "rejected"): boolean;
  item(id: string): CaptureReviewItem | null;
}

export function captureReviewBridge(root: string): CaptureReviewBridge {
  return {
    recent: (limit: number) =>
      readCaptureReview(root)
        .filter((x) => (x.status ?? "pending") === "pending")
        .slice(-limit)
        .reverse(),
    setStatus: (id: string, status: "accepted" | "rejected") =>
      setCaptureReviewStatus(root, id, status),
    item: (id: string) => readCaptureReview(root).find((x) => x.id === id) ?? null,
  };
}
