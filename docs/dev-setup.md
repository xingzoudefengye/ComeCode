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
cd engine
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

## 5. 数据目录、Provider 与网络边界

ComeCode CLI 默认把用户数据写入 `~/.comecode`，项目级 `.zcode` 配置目录保持兼容。环境变量按新前缀优先、旧前缀回退读取：

| 用途 | 首选变量 | 兼容变量 |
| --- | --- | --- |
| 数据父目录（最终追加 `.comecode`） | `COMECODE_DATA_BASE_DIR` | `ZCODE_DATA_BASE_DIR` |
| CLI 存储目录 | `COMECODE_STORAGE_DIR` | `ZCODE_STORAGE_DIR` |
| Provider Personal JSON | `COMECODE_PERSONAL_PROVIDER_CONFIG_FILE` | `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` |

例如，下面的配置会使用 `D:\ComeCodeData\.comecode`，而不会写入默认用户目录：

```powershell
$env:COMECODE_DATA_BASE_DIR="D:\ComeCodeData"
node dist/zcode.cjs --help
```

如果检测到旧的 `~/.zcode` 而新的 `~/.comecode` 尚不存在，首次启动会询问是否复制旧数据；复制不会删除旧目录。非交互模式只提示迁移，不会自动复制。内部配置和历史路径仍接受 `ZCODE_*`，以便逐步迁移脚本。

CLI 不要求厂商登录。请在 `COMECODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向的 `provider_config.json`（或兼容的旧 `~/.comecode/cli/config.json`）中配置一个 Provider；缺少可用模型时会显示配置引导。`/login` 和 `login` 子命令保留兼容入口，但只显示同一份配置引导，不会启动 OAuth。

全新数据目录可以先写入下面的 `~/.comecode/cli/config.json`，将地址、Key、模型名替换为自己的值。首次加载会把这些旧格式字段导入 `~/.comecode/v2/provider_config.json`，之后修改 Provider 请编辑 v2 文件；已存在的 v2 文件不会被重复导入覆盖。

```json
{
  "provider": {
    "example": {
      "source": "custom",
      "kind": "openai-compatible",
      "options": {
        "apiKey": "YOUR_API_KEY",
        "baseURL": "https://your-model-host.example/v1"
      },
      "models": {
        "your-model": { "contextWindow": 32000 }
      }
    }
  },
  "model": { "main": "example/your-model" }
}
```

仅凭 `OPENAI_API_KEY` 自动生成 Provider 的功能计划在 T2.2 实现，本阶段仍需上述配置文件。

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
