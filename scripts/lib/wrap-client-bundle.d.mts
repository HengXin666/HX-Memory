// scripts/lib/wrap-client-bundle.d.mts — 给 .mjs 包装器提供类型 (测试直接 import)。
export declare function clientModuleId(packageName: string): string;
export declare function wrapClientBundle(input: { body: string; packageName: string }): string;
