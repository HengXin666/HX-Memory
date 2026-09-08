// scripts/lib/wrap-client-bundle.mjs — DSH client bundle 的包装器 (纯函数, 可单测)。
//
// 为什么单独抽出来: 宿主 @deepseek-ai/dsh-client-modules 以 loader entry 名 (= 包名)
// 作为 boot graph 行 id, 从 /plugins/<包名>/client.js 取 bundle, 并要求该 bundle 用
// **同一个 id** 调 window.__ModuleLoader__.load(...); 否则 arrive() 抛
// "loaded without registering \"<id>\" via __ModuleLoader__.load"。
// 手写 id 字符串是这个契约最容易漂移的点, 因此这里由包名派生, 并有测试盯着。

/**
 * 派生 client bundle 必须注册的模块 id。
 * @param {string} packageName - package.json 的 name。
 * @returns {string} 同一个字符串 (契约要求与包名逐字相等)。
 */
export function clientModuleId(packageName) {
  if (typeof packageName !== "string" || packageName.trim().length === 0) {
    throw new TypeError("clientModuleId: package name must be a non-empty string");
  }
  return packageName;
}

/**
 * 把 esbuild 的 CJS 产物包成宿主可加载的 bundle。
 * @param {{ body: string, packageName: string }} input - 已打包的 CJS 代码与包名。
 * @returns {string} 可直接写盘的 client bundle 文本。
 */
export function wrapClientBundle(input) {
  const { body, packageName } = input ?? {};
  if (typeof body !== "string") throw new TypeError("wrapClientBundle: body must be a string");
  const id = clientModuleId(packageName);
  const indented = body
    .split("\n")
    .map((line) => "    " + line)
    .join("\n");
  return [
    "window.__ModuleLoader__.load({",
    "  id: " + JSON.stringify(id) + ",",
    "  factory: (require) => {",
    "    var module = { exports: {} };",
    "    var exports = module.exports;",
    indented,
    "    return module.exports;",
    "  }",
    "});",
    "",
  ].join("\n");
}
