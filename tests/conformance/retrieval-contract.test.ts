// tests/conformance/retrieval-contract.test.ts — 同一份检索契约跑在所有引擎组合上。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRetrieval, type RetrievalHarness } from "./retrieval-suite.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";

describeRetrieval({
  name: "FileBackend (Markdown 真相 + FTS5 + 向量通道)",
  create(): RetrievalHarness {
    const root = mkdtempSync(join(tmpdir(), "hxmem-retrieval-conf-"));
    let store = new FileBackend({ root });
    return {
      get source() {
        return store;
      },
      reopen() {
        store.close();
        store = new FileBackend({ root });
      },
      rebuild() {
        store.rebuildFromFiles();
      },
      dispose() {
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
});

describeRetrieval({
  name: "MemoryBackend (纯内存 + 向量通道)",
  create(): RetrievalHarness {
    return { source: new MemoryBackend() };
  },
});

describeRetrieval({
  name: "FileBackend 关闭向量通道 (降级可见性)",
  vector: false,
  create(): RetrievalHarness {
    const root = mkdtempSync(join(tmpdir(), "hxmem-retrieval-novec-"));
    const store = new FileBackend({ root });
    return {
      source: store,
      dispose() {
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
});
