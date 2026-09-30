# 开发环境搭建（Windows 已验证）

验证日期：2026-09-30，Windows 11，Node v24.19.0。

## 1. 工具版本

- Node：>= 24（项目推荐 24.14.0，24.19.0 实测可用）。
- pnpm：必须 10.33.2（`package.json` 的 `packageManager`）。全局装的 pnpm 版本不同也没关系，用 corepack 调用即可：

```bash
corepack pnpm@10.33.2 --version
```

## 2. 安装依赖

官方源在国内很慢（5~20 KiB/s，偶发 ECONNRESET），建议用 npmmirror。不需要桌面版时跳过 Electron 二进制下载：

```bash
cd ZCode
ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
corepack pnpm@10.33.2 install --registry=https://registry.npmmirror.com
```

PowerShell 写法：

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD=1
$env:COREPACK_NPM_REGISTRY="https://registry.npmmirror.com"
corepack pnpm@10.33.2 install --registry=https://registry.npmmirror.com
```

耗时约 2~3 分钟。安装过程会用 node-gyp 编译 ssh2 等原生模块（需要 VS Build Tools，本机已有）；node-pty 在 Windows 使用预编译包。

检查原生依赖：

```bash
node -e "require('esbuild'); require('koffi'); require('node:sqlite'); console.log('ok')"
```

## 3. 只构建 CLI

```bash
corepack pnpm@10.33.2 --filter "@zcode/cli..." build
```

`...` 表示连同它依赖的 workspace 包一起构建（provider、shared、contracts、core、adapters、tui、bootstrap 等），不会构建 desktop/web。

产物：`apps/zcode-cli/packages/cli/dist/zcode.cjs`（约 30 MB）。

注意：`@zcode/tui`、`playwright-core`、`koffi` 没有打进 bundle（见 `cli/scripts/build.mjs` 的 `resolveBuildExternal`），运行时依赖 node_modules。发布 npm 包时要处理（PLAN T5.1）。

## 4. 运行

```bash
cd apps/zcode-cli/packages/cli
node dist/zcode.cjs --version
node dist/zcode.cjs --help
node dist/zcode.cjs doctor
node dist/zcode.cjs                        # 打开 TUI
node dist/zcode.cjs -p "列出当前目录文件" --mode plan   # 无头单次
```

开发模式（不用构建，直接跑源码）：

```bash
corepack pnpm@10.33.2 --dir apps/zcode-cli dev
```

## 5. 数据目录

当前仍使用 `~/.zcode`（T1.2 之后改为 `~/.comecode`）。如果本机装过 ZCode 桌面版，CLI 会直接复用它的 Provider 配置和登录状态，会话记录也会写进同一个目录。

想和桌面版隔离，设置独立数据目录：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.comecode-dev" node dist/zcode.cjs
```

隔离后需要重新配置 Provider。
