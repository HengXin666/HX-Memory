# Agent Note: 插件安装通道以 release tarball 为唯一对外通道 (zip 归档不可用)

Status: implemented

## Problem

社区里有插件用"一条命令从 GitHub 归档安装"作为推荐安装方式, 写法是
`dsh plugin --profile web add https://github.com/<owner>/<repo>/archive/refs/heads/<branch>.zip`。
本仓库的快速上手当时写的是 `dsh plugin add @hengxin666/hx-memory`, 有两个具体缺陷:

1. **缺少 `--profile`**。`dsh plugin` 把 `--profile` 声明为必填, 照抄这条命令只会得到
   `required option '--profile <name>' not specified`。
2. **指向 GitHub Packages**。该注册表即使对 public 包也要求认证, 匿名请求返回 401, 外部用户装不上。

同时需要回答一个更基础的问题: 照搬社区的 zip 归档写法, 在本仓库能不能用。实测结论是**不能** ——
pnpm 把 URL 依赖按 tarball 解析, zip 字节流在解包阶段报 `ERR_PNPM_TARBALL_EXTRACT: Invalid checksum for TAR header at offset 0`
(pnpm 10.25 与 11.7、github.com 归档链接与 codeload 直链, 四种组合全部复现; 同一 URL 用 `curl` 与 `fetch` 下载均完整合法)。
换成同仓库同分支的 `.tar.gz` 立即成功。

## Decision

对外**只推荐 release 的 `.tgz`** 作为"一条命令安装"通道, 并把三种可用/不可用写法与判据写成
[plugin-install.md](../../../../docs/plugin-install.md) (含 zip 失败根因、源码归档为何不适用于本仓库、环境前提与报错对照)。

- 已发布版本: `dsh plugin --profile web add https://github.com/HengXin666/HX-Memory/releases/download/vX.Y.Z/hengxin666-hx-memory-X.Y.Z.tgz`
- 本地开发: `pnpm run build && pnpm run build:client` 后在仓库内 `dsh plugin --profile web add .`
- README 的安装段改为上述两条, 不再写裸的 `dsh plugin add <包名>`。

选择 release tarball 而不是源码归档, 原因是本仓库 `dist/` 不进 git:
源码归档 / git 依赖 / 克隆后不构建都能"安装成功"却拿不到 `main` 指向的产物, 只有在启动时才炸 ——
这是最难排查的一类失败, 必须在文档层面堵死。

## Alternatives considered

**照搬 zip 归档写法, 让本仓库也支持 `.../archive/refs/heads/main.zip`。**
否定理由是它在 pnpm 下根本不成立 (见上), 而不是"不方便": 写进文档等于把一个必然失败的路径当成推荐路径。

**改用 git 依赖 (`add github:HengXin666/HX-Memory`), 靠 `prepare` 在安装时构建。**
这条路理论上可行, 但要求仓库新增 `prepare` 脚本, 且 pnpm 默认拦截依赖的构建脚本, 用户必须先手工把
pnpm 打印的 key 加进 profile 侧配置再重跑。为了省掉一次 `pnpm run build`, 把失败面从"一次命令"扩大到
"构建依赖闭包 + 构建脚本放行", 不划算。

**把 `dist/` 提交进 git, 换取源码归档可直接安装。**
改动最小, 但会把构建产物带进每一次 diff 与 review, 且引入"构建产物与源码不同步"这一持久性风险。
真正需要"一条命令"的用户, release tarball 已经提供同样的效果, 且产物由流水线构建并验证。

**发布到公共 npm registry, 用包名安装。**
外部用户最熟悉的形态, 但需要新增发布目标与凭据管理, 且当前的 GitHub Packages 通道已经产出可用 tarball。
在包名通道打通之前, 文档先指向不带认证要求的 tarball URL。

## Consequences

- 对外安装路径只有 release tarball 与本机构建两种, 两者都在实机验证过 (安装后 `dsh.profile.bundles` 自动追加, `dsh --profile web --dump-config` 出现对应 `# ==` 段)。
- 安装失败面从"启动时才炸"前移到"文档里已写明判据": 缺产物、zip 归档、缺 `--profile`、缺 pnpm 各有对应条目。
- 每次发版后 README 里的示例 URL 需要跟着版本走; 这是刻意的 —— 恒定文件名的 "latest" 链接会让 pnpm 按旧 spec 判定 `Already up to date`, 静默留旧版本, 比手改版本号更危险。
- `dist/` 继续保持不进 git。
- 相关: 发布流水线本身的取舍见 [release-bump 未导出](2026-09-11-release-bump-not-exported.md); 发布产物是这个安装通道的前提。
