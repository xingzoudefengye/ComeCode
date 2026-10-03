# 开发环境搭建（Windows 已验证）

验证日期：2026-09-30，Windows 11，Node v24.19.0。

## 1. 工具版本

- Node：>= 24（项目推荐 24.14.0，24.19.0 实测可用）。
- pnpm：以 `engine/package.json` 的 `packageManager` 为准，当前锁定 10.33.2。以下命令从 `engine/` 执行；Corepack 不可用时，先自行安装相同版本的 pnpm。不要用「或更高版本」替代锁定工具链。

```bash
corepack pnpm@10.33.2 --version
```

## 2. 安装依赖

仅开发 CLI 时可以跳过 Electron 二进制下载；桌面开发则不要设置此变量。默认使用 npm 官方源；遇到网络限制可自行选择可信镜像，镜像不是运行或构建的强制依赖：

```bash
# 从仓库根目录进入 engine 后执行
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm@10.33.2 install --frozen-lockfile
```

PowerShell 写法：

```powershell
$env:ELECTRON_SKIP_BINARY_DOWNLOAD=1
corepack pnpm@10.33.2 install --frozen-lockfile
```

如需自选镜像可加 `--registry=<可信镜像地址>`；安装耗时依网络与平台而异。原生模块可能需要 C++ 构建工具，是否使用预编译包应以当前平台安装结果为准。

检查原生依赖：

```bash
node -e "require('esbuild'); require('koffi'); require('node:sqlite'); console.log('ok')"
```

## 3. 只构建 CLI

以下命令从 `engine` 目录执行：

```bash
cd engine
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
cd engine
corepack pnpm@10.33.2 --dir apps/zcode-cli dev
```

## 5. 数据目录、Provider 与网络边界

ComeCode CLI 默认把用户数据写入 `~/.comecode`，项目级 `.zcode` 配置目录保持兼容。环境变量按新前缀优先、旧前缀回退读取：

| 用途                               | 首选变量                                 | 兼容变量                              |
| ---------------------------------- | ---------------------------------------- | ------------------------------------- |
| 数据父目录（最终追加 `.comecode`） | `COMECODE_DATA_BASE_DIR`                 | `ZCODE_DATA_BASE_DIR`                 |
| CLI 存储目录                       | `COMECODE_STORAGE_DIR`                   | `ZCODE_STORAGE_DIR`                   |
| Provider Personal JSON             | `COMECODE_PERSONAL_PROVIDER_CONFIG_FILE` | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` |

例如，下面的配置会使用 `D:\ComeCodeData\.comecode`，而不会写入默认用户目录：

```powershell
$env:COMECODE_DATA_BASE_DIR="D:\ComeCodeData"
node dist/zcode.cjs --help
```

如果检测到旧的 `~/.zcode` 而新的 `~/.comecode` 尚不存在，首次启动会询问是否复制旧数据；复制不会删除旧目录。非交互模式只提示迁移，不会自动复制。内部配置和历史路径仍接受 `ZCODE_*`，以便逐步迁移脚本。

ComeCode CLI 不要求厂商登录。首选直接运行 `comecode` 完成首次模型引导，或执行 `comecode config setup`；公开配置使用 `~/.comecode/config.json` / JSONC，兼容 TOML 与旧 Provider JSON，详见 [README](../README.md)。也可仅设置 `OPENAI_API_KEY` 或 Anthropic 凭据零配置启动；使用兼容网关时显式指定地址和模型。T2.2 已实现，不再要求先手写旧版配置。

`config check` 只做本地检查；连接测试或实际对话会调用供应商，费用由用户承担。`/login` 等仅保留兼容引导，不启动 OAuth。

默认启动不会刷新远程 Provider 目录、调用官方 Coding Plan 网关或注册官方远程插件市场。Provider 目录使用随包的 `engine/config/provider/zcode-builtin.json`；插件市场需在配置中显式声明，例如：

```json
{
  "plugins": {
    "extraKnownMarketplaces": {
      "zcode-plugins-official": {
        "source": {
          "source": "url",
          "url": "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json"
        }
      }
    }
  }
}
```

未设置 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 traces/metrics 专用 endpoint）时不会创建遥测上报 Owner；设置这些标准 OTEL 变量表示用户主动启用。模型请求访问 Provider 配置的 `baseURL`；用户显式配置的 MCP、插件、模型工具也可访问其指定地址。

## 6. 改完源码，本地 comecode 为什么"不生效"（打包/重启要点）

改 TUI/CLI 源码后运行 comecode 没反应，几乎都是同一个原因：**只改了源码、没重建对应包的 dist 产物，而运行中的进程还在用旧代码**。先看本机 comecode 到底跑的是什么：

```bash
# 查询命令位置，再检查该脚本内容或实际进程参数
command -v comecode
```

Windows PowerShell 可用 `Get-Command comecode` 定位；检查结果应以自己的安装环境为准。如果它是开发 shim，通常会启动仓库中的 `engine/apps/zcode-cli/packages/cli/dist/zcode.cjs`，而不是源码。正式发布后的安装路径可能不同。

### 构建链与包间关系

- CLI bundle 把 `@zcode/tui`、`playwright-core`、`koffi` 设成 **external**（`cli/scripts/build.mjs` 的 `resolveBuildExternal`），所以 TUI 没有打进 `zcode.cjs`。
- `zcode.cjs` 运行时通过 `import("@zcode/tui")` 动态加载 TUI；该包在 `packages/cli/node_modules/@zcode/tui` 是指向 `packages/tui` 的**软链**，实际读取的是 `packages/tui/dist/index.js`。
- TUI-only 快速调试可单独重建该包，但正常验证和交付统一使用依赖优先的 CLI 聚合构建，避免其它依赖或 bundle 留在旧版本。

### 重建命令

```bash
cd engine
corepack pnpm@10.33.2 --filter "@zcode/cli..." build
```

该命令只构建 CLI 及其依赖，不构建整个桌面。

### 内置 Provider 目录（模型档位、目录规则）

模型档位（`optionSpecs.reasoningLevel.values`）、模型匹配规则这类数据都在 `engine/config/provider/zcode-builtin.json`，它是唯一的源。构建会先按运行时的 Release schema 完整校验，再复制一份到 `packages/cli/dist/provider/zcode-builtin.json`；运行中的 CLI 靠 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 定位的正是这份副本。

所以改了目录规则要重建 **CLI**（不是 TUI）：

```bash
cd engine
corepack pnpm@10.33.2 --filter "@zcode/cli..." build
cmp -s config/provider/zcode-builtin.json \
  apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json && echo "产物与源一致"
```

历史坑已修：从正在运行的 comecode 派生的终端会继承 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（指向 dist 副本），而构建脚本过去把它当配置源，于是源与目标成了同一个文件——构建正常输出 `Done`，仓库里的改动却进不了产物。现在构建会忽略指向**仓库内 dist 产物**的取值（CLI 随包副本、`dist/zcode/.work` 里的 agent 包副本等），回退到仓库配置并在 stderr 打一行告警；**看到那行告警属于正常回退，不需要再手动 `env -u`**。指向仓库外部的备用源仍然生效。

### 验证产物确实包含改动

```bash
# 用源码里的独有字符串反查 dist，0 表示旧产物没打进去
grep -c "usePaste" packages/tui/dist/index.js        # 例：TUI 改动
grep -c "bytes.length === 0" packages/tui/dist/index.js
# 对比产物与源码 mtime，确认 dist 不早于 src
ls -la --time-style=+%H:%M:%S packages/tui/dist/index.js packages/tui/src/app.tsx
```

### 必须重启 comecode

TUI 是运行时按需加载的，已开的会话进程不会自动换新代码。**重建 dist 后要重启 comecode 才生效**；验证方法是启动后触发改动对应的行为，看状态栏是否出现新提示（例如图片粘贴会出现"图片：正在读取剪贴板…"）。

### 测试与 lint 已知坑

- 测试不能直接 `node --test`（`.tsx` 需要转译），要带专用 loader 串行跑：
  ```bash
  cd engine/apps/zcode-cli
  node --test --test-isolation=none --test-concurrency=1 \
    --import ./test/typescript-loader.mjs ./test/clipboard-image.test.mjs
  ```
  全量用 `./test/*.test.mjs`。
- `app.tsx` 等大文件受 oxlint `max-lines`（400，`skipBlankLines`/`skipComments`）约束；增行容易顶破上限，先 `git show HEAD:... | wc -l` 对比现状，别把已是"超限未提交"的文件再往上限推。
