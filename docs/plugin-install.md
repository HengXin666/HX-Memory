# DSH 插件安装路径 (profile 的插件从哪来, 哪种写法真能用)

> 目的: 把 DSH 插件的安装通道、`dsh plugin` 的真实行为、以及本仓库实测通过/失败的写法,
> 写成一份可核对的清单 —— 避免照着"看起来是一句话"的教程安装, 结果静默装不上或装上一个加载不了的包。
> 边界 (不写什么): 不写 HX-Memory 的记忆机制与面板用法 (见 [README](../README.md) 与 [architecture-v2.md](architecture-v2.md));
> 不写宿主触发点清单 (见 [dsh-trigger-points.md](dsh-trigger-points.md))。
> 与代码的关系: 安装写入的是宿主 home 下的 profile 目录 (`~/.dsh/profiles/<name>/`), 不落在本仓库;
> 本仓库"可被安装"的那一层由 `package.json` 的 `dsh.bundle` 字段与 `dsh/cordis.patch.yml` 决定。

## 0. 一句话

`dsh plugin --profile <name> <pnpm 参数...>` 不是一个独立的包管理器, 它是**在 profile 目录里转发给 pnpm 的薄壳**:
pnpm 跑完之后, 它扫描 profile 的依赖, 把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`, 于是该插件成为启动时的一层 patch。

## 1. `dsh plugin` 的四步

1. **首次使用会初始化 profile**: 目录不存在 `package.json` 时按模板写入。`web` / `headless` / `acp` / `sdk` 有各自的模板,
   其余名字落到默认模板 (`dsh.profile.bundles = ["@deepseek-ai/dsh-base"]`)。
2. **相对路径按当前工作目录改写成绝对路径**: 在插件仓库里执行 `add .` 装的是这个仓库;
   在别处执行 `add ../plugin` 按那个位置解析 —— 不是按 profile 目录解析 (否则 profile 会被自己 link 成依赖)。
3. **在 profile 目录里执行 `pnpm <参数>`**。所以 `add` / `remove` / `update` / `install` 都是 pnpm 的原义。
4. **按"已安装状态"对账层级列表**: 依赖解析出的包声明了 `dsh.bundle.patch` 就加入 `dsh.profile.bundles`;
   被移除、或新版本不再声明, 就移出。未声明 `dsh.bundle` 的依赖只装为普通依赖, 并打印一条 warning (不是错误)。
   对账看的是**装出来的东西**而不是命令行参数, 所以 URL / git / 别名写法都能按真实包名对账。

`--profile` 是**必填**: 缺了会直接报 `required option '--profile <name>' not specified`。

## 2. 安装通道实测对照

| 通道 | 命令形态 | 结果 | 说明 |
| --- | --- | --- | --- |
| GitHub 归档 zip | `add https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip` | **失败** | pnpm 把 URL 依赖按 tarball 解析, 报 `ERR_PNPM_TARBALL_EXTRACT ... Invalid checksum for TAR header at offset 0` |
| GitHub 归档 tar.gz | `add https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.tar.gz` | 通过 | 同一仓库、同一分支, 只换扩展名即可 |
| Release 的打包产物 | `add https://github.com/<owner>/<repo>/releases/download/<tag>/<包名>-<版本>.tgz` | 通过 | 内容等于 `npm pack` 产物, 含构建输出 |
| 本地目录 | 在仓库内 `add .`, 或 `add file:<绝对路径>` | 通过 | 记成 `link:` / `file:` 依赖 (见 §5 的更新坑) |
| 注册表包名 | `add <pkg>` / `add @scope/<pkg>` | 视注册表 | GitHub Packages 即使包是 public, 匿名请求也返回 401, 需要 token |
| git 依赖 | `add github:<owner>/<repo>` | 视仓库 | 仅当仓库带构建脚本且该脚本被 profile 侧放行时可用 (见 §7) |

对照是实机跑出来的 (pnpm 10.25 与 11.7 各跑一遍, zip 与 tar.gz 各两种 URL 写法), 不是文档推测。

## 3. 为什么 GitHub 的 zip 装不上

pnpm 的 URL 依赖走的是 **tarball** 通道: 它按 tar 头解析下载到的字节流。zip 的前几个字节是 `PK\x03\x04`,
被当成 tar 头解析时校验失败, 于是报 `Invalid checksum for TAR header at offset 0`。
下载本身是成功的 (同一 URL 用 `curl` 或 `fetch` 都能拿到完整且合法的 zip), 失败发生在解包。

结论: 用 `.tar.gz` 归档链接, 不要用 `.zip`。

## 4. 归档安装的隐含前提: 归档里得真有构建产物

这是本仓库最容易踩的一条:

- 有的插件把构建产物一起提交进 git (例如 `lib/` 与客户端入口), 因此**源码归档可以直接被加载**。
- 本仓库把 `dist/` 排除在 git 之外 (见 `.gitignore`), 而 `package.json` 的 `main` / `exports` 指向 `dist/`。
  因此源码归档 (zip 或 tar.gz)、git 依赖、以及"克隆后不构建直接 `add .`" 都会装出一个**没有产物的包**:
  bundle 层能进列表, 但插件模块解析不到, 启动即失败。

所以本仓库的推荐通道只有两条:

```bash
# 已发布版本: 无需克隆、无需构建 (vX.Y.Z 换成 release 里的实际版本)
dsh plugin --profile web add https://github.com/HengXin666/HX-Memory/releases/download/vX.Y.Z/hengxin666-hx-memory-X.Y.Z.tgz

# 本地开发: 先构建, 再从仓库目录安装
pnpm run build && pnpm run build:client
cd <本仓库目录> && dsh plugin --profile web add .
```

发布产物由 release 流水线构建后打包并上传 (见 `.github/workflows/release.yml`), 因此它的内容与本地构建一致。

## 5. 装完还要做什么

- **重启宿主**。层列表在启动时组装, 运行中的进程不会热加一层。
- **核对层级**: `dsh --profile web --dump-config` 的输出里应出现该插件的 `# == <包名>` 段。
- **本地开发改完代码要重装**。pnpm 对"内容变了的 `file:` 依赖"会显示 `Already up to date` 而不重新拷贝,
  两次构建之间若新增或删除过文件, 结果是新旧混杂。可靠做法是先删安装副本再装, 细节见 [README](../README.md) 的快速上手一节。

## 6. 卸载

`dsh plugin --profile web remove <包名>`。依赖被移除后, 对账会把 `dsh.profile.bundles` 里的对应项一并去掉。
若插件对被改写过的宿主文件还有副作用 (例如打补丁类插件), 按插件自己的说明先还原再卸载。

## 7. 环境前提与常见报错

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `pnpm not found on PATH` (退出码 127) | `dsh plugin` 只是 pnpm 的转发壳, 自己不带包管理器 | 先装 pnpm 并确保在 `PATH` 上 |
| `Invalid checksum for TAR header at offset 0` | 用了 zip 归档 (见 §3) | 换 `.tar.gz` |
| `declares no dsh.bundle — installed as a plain dependency` | 该依赖不是插件, 只被装成普通依赖 | 确认包名; 这是 warning 不是失败 |
| 安装成功但启动报模块解析失败 | 归档里没有构建产物 (见 §4) | 用 release 的 `.tgz`, 或本地构建后安装 |
| git 依赖的构建脚本被拦截 | pnpm 默认不执行依赖的构建脚本 | 把 pnpm 打印的 key 加到 profile 的 pnpm-workspace.yaml 后重跑 |

profile 侧的 pnpm 配置默认是 `nodeLinker: hoisted` + `autoInstallPeers: false`:
依赖被平铺安装, 而 `@deepseek-ai/*` 这类 peer 由宿主安装闭包提供, 不会被重复解析成第二份实例。
