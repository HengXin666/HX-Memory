// scripts/lib/host-version.d.mts — 给 .mjs 脚本提供类型 (测试与 CI 步骤都要 import/调用它)。
// 为什么不改成 .ts: 这一步在 CI 里由 `node` 直接跑 (不经过 strip-types 的启动开销),
// 与同目录的 wrap-client-bundle.mjs 用同一套"实现是 .mjs + 手写 d.mts"的做法。

export interface NpmExec {
  (command: string, args: string[], options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "pipe"];
  }): string;
}

export interface Manifest {
  dsh?: { host?: unknown };
}

/** 从 package.json 的 dsh.host 读宿主范围; 缺失即报错。 */
export declare function hostRange(manifest: Manifest): string;

/** dist-tag `latest` 指向的版本。 */
export declare function latestHostVersion(options?: { exec?: NpmExec }): string;

/** 用 npm 自己的解析器判断该版本是否被范围接受。 */
export declare function isInRange(
  range: string,
  version: string,
  options?: { exec?: NpmExec },
): boolean;

/** 门禁要装的宿主版本 = latest, 且必须被 dsh.host 接受; 越界即抛错。 */
export declare function resolveHostVersion(
  manifest: Manifest,
  options?: { exec?: NpmExec },
): string;
