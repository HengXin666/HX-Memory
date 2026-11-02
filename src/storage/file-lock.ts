// storage/file-lock.ts — 同步的跨进程排他锁 (一个锁文件一把锁)。
//
// 为什么要它 (REVIEW.md D1 / D17): canonical bundle 与真相 markdown 都是"读-改-写整文件"。
// 原子 rename 只能保证不出半文件, 挡不住两个进程各读一份旧值再各写回 —— 后写者会抹掉先写者。
// 根治只能让"读-改-写"整段串行: 本锁。
//
// 实现约束:
//   · 同步: 调用方 (upsertBlockInFile / CanonicalStore.saveMemory) 都是同步 API, 不能为此改成 async。
//   · 只用 node:fs 原语: `openSync(path, "wx")` 是 O_CREAT|O_EXCL, 本地文件系统上原子。
//   · 持锁进程崩溃不能把锁永久留下: 锁文件里写 pid + 时间; 等待方发现 pid 已不存在, 或锁超过
//     staleMs 仍未释放, 就接管。接管本身用一个 mkdir 互斥 (mkdir 原子), 防止两个等待方同时删锁、
//     互相删掉对方刚建的新锁。
//   · 不可重入: 同一进程对同一把锁嵌套加锁会等到超时 —— 调用方保证锁内不再回调加锁的 API。
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface FileLockOptions {
  /** 最多等多久 (ms), 超时抛错。默认 10000。 */
  timeoutMs?: number;
  /** 持锁超过这个时长 (ms) 视为遗留锁, 允许接管。默认 30000。 */
  staleMs?: number;
}

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: 进程存在但不属于我们 —— 仍算活着。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): { pid: number; at: number } | null {
  try {
    const [pid, at] = readFileSync(lockPath, "utf8").trim().split(" ");
    return { pid: Number(pid), at: Number(at) };
  } catch {
    return null;
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  const owner = readOwner(lockPath);
  if (owner && Number.isFinite(owner.pid) && owner.pid > 0 && !pidAlive(owner.pid)) return true;
  try {
    // 锁文件内容还没写完 (owner 为 null) 时只按 mtime 判定。
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** 尝试接管遗留锁。返回 true 表示已删掉遗留锁 (调用方随后重试加锁)。 */
function takeOver(lockPath: string, staleMs: number): boolean {
  const guard = lockPath + ".takeover";
  try {
    mkdirSync(guard);
  } catch {
    // 别人正在接管; 若接管者自己也崩了 (guard 超过 5s), 清掉 guard 让下一轮重来。
    try {
      if (Date.now() - statSync(guard).mtimeMs > 5000) rmdirSync(guard);
    } catch {
      /* 已被别人清掉 */
    }
    return false;
  }
  try {
    // 拿到 guard 后再判一次: 期间锁可能已被正常释放并被别人重新拿到。
    if (!isStale(lockPath, staleMs)) return false;
    try {
      unlinkSync(lockPath);
    } catch {
      /* 已不存在 */
    }
    return true;
  } finally {
    try {
      rmdirSync(guard);
    } catch {
      /* ignore */
    }
  }
}

/** 加锁。返回释放函数。 */
export function acquireFileLock(lockPath: string, opts: FileLockOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const staleMs = opts.staleMs ?? 30000;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let wait = 1;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, process.pid + " " + Date.now());
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // 只删自己的锁: 若因超时被别人接管, 现在那把锁属于别人。
        const owner = readOwner(lockPath);
        if (owner && owner.pid !== process.pid) return;
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已不存在 */
        }
      };
    }
    if (isStale(lockPath, staleMs) && takeOver(lockPath, staleMs)) continue;
    if (Date.now() > deadline) {
      const owner = readOwner(lockPath);
      throw new Error(
        "file lock timeout after " + timeoutMs + "ms: " + lockPath + (owner ? " (held by pid " + owner.pid + ")" : ""),
      );
    }
    sleepMs(wait + Math.floor(Math.random() * wait));
    wait = Math.min(wait * 2, 50);
  }
}

/** 在锁内执行 fn (同步)。 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts?: FileLockOptions): T {
  const release = acquireFileLock(lockPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}
