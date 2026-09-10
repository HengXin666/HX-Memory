// tests/conformance/backend-contract.test.ts — 把同一套契约跑在所有引擎实现上。
//
// 新增引擎 (LanceDB/Qdrant/远端/自研) 只需在这里加一个 describeBackend, 契约即生效。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBackend, type BackendHarness } from "./suite.ts";
import { FileBackend } from "../../src/storage/file-store.ts";
import { MemoryBackend } from "../../src/storage/memory-store.ts";

describeBackend({
  name: "FileBackend (Markdown 真相 + SQLite 派生索引 + FTS5)",
  supports: { rebuild: true, persistence: true, fullText: true },
  create(): BackendHarness {
    const root = mkdtempSync(join(tmpdir(), "hxmem-conformance-"));
    let store = new FileBackend({ root });
    return {
      get store() {
        return store;
      },
      reopen() {
        store.close();
        store = new FileBackend({ root });
      },
      dispose() {
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
});

describeBackend({
  name: "MemoryBackend (纯内存, 第二实现)",
  supports: { rebuild: false, persistence: false, fullText: false },
  create(): BackendHarness {
    return { store: new MemoryBackend() };
  },
});
