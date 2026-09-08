// tests/s2/project-plumbing.test.ts — project 全链路回归。
// 坑: 自动捕获不带 project → 所有记忆都是 scope:"agent"; memory_save 收到 project 也不落;
// 绑定/项目内召回按 session.id (UUID) 匹配 → 永远查不到。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileBackend } from "../../src/storage/file-store.ts";
import { CapturePipeline } from "../../src/capture/pipeline.ts";
import { HxMemoryRuntime, projectOfSession } from "../../src/adapters/dsh/runtime.ts";
import { registerMemoryTools } from "../../src/adapters/dsh/tools.ts";
import { GeneralizerService } from "../../src/generalize/service.ts";
import { Binder } from "../../src/kernel/binder.ts";

let root: string;
let store: FileBackend;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hxmem-project-"));
  store = new FileBackend({ root });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("projectOfSession", () => {
  it("取工作目录的目录名", () => {
    expect(projectOfSession({ id: "s", header: { cwd: "/home/me/code/api" } })).toBe("api");
    expect(projectOfSession({ id: "s", header: { cwd: "/home/me/code/api/" } })).toBe("api");
  });
  it("无 cwd → undefined", () => {
    expect(projectOfSession({ id: "s" })).toBeUndefined();
    expect(projectOfSession({ id: "s", header: { cwd: "" } })).toBeUndefined();
  });
});

describe("自动捕获带上 project", () => {
  it("session.header.cwd 派生的项目名进入记忆条目", async () => {
    const runtime = new HxMemoryRuntime(new CapturePipeline(store), () => ({ autoCapture: true }));
    const session = { id: "s-1", header: { cwd: "/code/api" } };
    runtime.onSessionStart(session);
    await runtime.capture(session, { type: "turn/start", data: { turn: 1 } });
    await runtime.capture(session, {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "队列并发踩坑, 下次注意幂等" }],
      },
    });
    await runtime.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });
    const hits = store.query({ kind: "lesson" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.scope).toBe("project");
    expect(hits[0]!.project).toBe("api");
  });

  it("绑定按项目名命中自动捕获的记忆", async () => {
    const runtime = new HxMemoryRuntime(new CapturePipeline(store), () => ({ autoCapture: true }));
    const session = { id: "s-1", header: { cwd: "/code/api" } };
    runtime.onSessionStart(session);
    await runtime.capture(session, { type: "turn/start", data: {} });
    await runtime.capture(session, {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "容器部署踩坑: 忘了设并发上限" }],
      },
    });
    await runtime.capture(session, { type: "turn/end", data: { reason: { kind: "completed" } } });

    const binder = new Binder(
      (q) => store.query(q),
      () => [
        {
          project: "api",
          bindings: [
            { id: "local-lessons", query: { kind: "lesson", scope: "project", project: "api" } },
          ],
        },
      ],
    );
    expect(binder.injectFor("api", "容器 并发")).toContain("并发上限");
    expect(binder.injectFor("other", "容器 并发")).toBe("");
  });
});

describe("memory_save 工具持久化 project", () => {
  it("传入 project 时落成 scope:project + project 字段", async () => {
    const tools: Array<{ name: string; execute: (args: unknown) => Promise<unknown> }> = [];
    registerMemoryTools(
      {
        tools: {
          register: (t: unknown) => {
            tools.push(t as never);
            return () => {};
          },
        },
      } as never,
      { store, generalizer: new GeneralizerService(store, join(root, "review")) },
    );
    const save = tools.find((t) => t.name === "memory_save")!;
    await save.execute({ content: "本项目约定: 接口必须幂等", kind: "preference", project: "api" });
    const hits = store.query({ text: "接口必须幂等" });
    expect(hits[0]!.scope).toBe("project");
    expect(hits[0]!.project).toBe("api");
  });
});
