// src/adapters/dsh/truth-files.ts — **真相文件的只读列举与读取** (面板"文件视图"的服务端)。
//
// 为什么需要它 (2026-09-20, §795): ADR-002 写着"真相在文件 (Markdown), 索引可重建" ——
// 而**用户在面板里看不到文件**。面板此前的每个视图都经 SQLite: 能搜、能删、能看注入预览,
// 但**没有任何入口"按文件浏览真相"**。于是"真相在文件"这条承诺在**人侧没有兑现**:
// 用户无法直接看到(hx-memory 到底写了什么), 也无法把它当知识库那样翻阅。
//
// 边界 (硬约束, 与 §64 的"浏览器碰不到文件系统"同源):
//   · 本模块**只读** —— 不写、不改、不删。写路径仍只走 store/facade。
//   · 路径必须**限制在 memory root 之内** —— 否则面板能读任意文件 (目录穿越)。
//     判据: 规范化后的绝对路径必须以 root 开头, 且不含 `..`。
//   · 只暴露 `.md` —— 索引 (`index.sqlite`) 与账本 (`.jsonl`) 不是"真相文件"。
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, normalize, relative, sep } from "node:path";

/**
 * 真相目录 —— **直接复用** `storage/truth-scan.ts` 的 `TRUTH_DIRS`。
 *
 * ⚠ 我第一版在这里**手写**了一份 `["daily","digest","rules"]`, 而 §725 建的
 * "真相目录清单副本" 检查**当场抓到它** —— 那正是那条检查要防的 (手写清单会静默漏目录)。
 * 现在只有一份来源。
 */
import { TRUTH_DIRS } from "../../storage/truth-scan.ts";
export { TRUTH_DIRS as TRUTH_DIRS };

export interface TruthFileInfo {
  /** 相对 root 的路径 (含目录), 如 `digest/2026-09-20.md`。 */
  path: string;
  /** 所在真相目录。 */
  dir: string;
  /** 文件字节数。 */
  bytes: number;
  /** 最后修改时间 (ISO)。 */
  modifiedAt: string;
}

/**
 * 列举真相文件 (只读)。
 *
 * @param root memory root 的绝对路径。
 * @param dir 限定目录; 省略则列全部真相目录。
 */
export function listTruthFiles(root: string, dir?: string): TruthFileInfo[] {
  const dirs = dir && (TRUTH_DIRS as readonly string[]).includes(dir) ? [dir] : TRUTH_DIRS;
  const out: TruthFileInfo[] = [];
  for (const d of dirs) {
    const base = join(root, d);
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue; // 目录不存在 = 该 kind 还没写过, 不是错误。
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const full = join(base, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      out.push({
        path: d + "/" + name,
        dir: d,
        bytes: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
      });
    }
  }
  return out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
}

/**
 * 读一个真相文件的原文 (只读)。
 *
 * ⚠ **目录穿越防护**: 只接受 `TRUTH_DIRS` 下的 `.md`, 且规范化后必须仍在 root 内。
 * 返回 `null` 表示"不允许/不存在" —— 调用方不该区分这两者 (区分等于泄露路径存在性)。
 */
export function readTruthFile(root: string, relPath: string): { path: string; text: string } | null {
  // ① 只允许 TRUTH_DIRS 下的 .md (白名单目录 + 扩展名)。
  const parts = relPath.split("/");
  if (parts.length !== 2) return null;
  const [dir, name] = parts as [string, string];
  if (!(TRUTH_DIRS as readonly string[]).includes(dir)) return null;
  if (!name.endsWith(".md") || name.includes("..") || name.includes(sep)) return null;
  // ② 规范化后再确认仍在 root 之内 (防奇怪输入)。
  const full = normalize(join(root, dir, name));
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel.includes(".." + sep)) return null;
  try {
    if (!statSync(full).isFile()) return null;
    // ③ ⚠ **解析符号链接后再判一次** (§795 实测缺口): `normalize` **不解析 symlink** ——
    // 在 `digest/` 下放一个指向 root **之外**的符号链接 (`digest/leak.md -> /tmp/secret.md`),
    // 上面那两条检查**全部通过**, 而 `readFileSync` 会真的把外部文件读出来 (实测读到 `OUTSIDE-SECRET`)。
    // 判据: `realpathSync` 后的路径必须仍在 root 之内 —— 那才是"这个文件属于本库"的充分判据。
    const real = realpathSync(full);
    const realRoot = realpathSync(root);
    const realRel = relative(realRoot, real);
    if (realRel.startsWith("..") || realRel.includes(".." + sep)) return null;
    return { path: dir + "/" + name, text: readFileSync(full, "utf8") };
  } catch {
    return null;
  }
}
