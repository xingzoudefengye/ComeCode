# ComeCode 使用指南

> 当前仓库已完成 npm 打包流程，但 npm 包尚未上线。发布前请从源码运行。

## 安装

npm 安装需要 Node.js 24.14.0 或更新的 Node 24：

```bash
npm install -g comecode
```

该命令在包发布后适用，npm 会按平台安装对应运行时。目前目标为 Windows x64、Linux x64、macOS Apple Silicon。发布前从源码运行：

```bash
git clone https://github.com/xingzoudefengye/ComeCode.git
cd ComeCode/engine
corepack pnpm install --frozen-lockfile
pnpm --filter "@zcode/cli..." build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

Windows 使用 PowerShell，macOS/Linux 使用终端；源码方式同样要求 Node.js 24.14.0 或更新的 Node 24。首次运行时请从项目目录执行，并把上面的 `node .../zcode.cjs` 替换为实际构建入口。

## 配置模型

最简单的方式是运行：

```bash
comecode config setup
```

也可以启动本地管理页：

```bash
comecode --web
```

`--web` 会在同一 CLI 进程中启动本地管理服务并尝试打开浏览器；地址和一次性访问 token 会打印到终端。服务默认只监听 `127.0.0.1`。无图形环境可使用 `comecode admin --no-browser`，通过终端显示的地址访问。端口可用 `--web-port <port>` 指定，`--no-web` 显式关闭后台。

在管理页的 Provider/模型页面中添加或编辑 Provider，填写协议（`openai-chat`、`openai-responses` 或 `anthropic`）、Base URL、模型 ID 和 API Key，保存后选择默认模型。页面显示的密钥会脱敏；不要把真实密钥提交到 Git。也可以使用 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等标准环境变量，或查看脱敏配置：

```bash
comecode config path
comecode config show
comecode config check
```

## 会话

直接启动 TUI 并输入任务：

```bash
comecode
```

启动新会话可在 TUI 输入 `/new`。继续当前项目最近会话使用：

```bash
comecode --continue
```

恢复指定会话使用真实的 `sess_...` ID：

```bash
comecode --resume sess_xxxxxxxxx
```

`--cwd <path>` 可指定会话项目目录。管理页的会话列表可查看会话并复制带有项目目录的恢复命令；会话由 CLI Runtime/SessionStore 管理，不要假定为固定的 `~/.comecode/sessions/` 目录。实际数据路径和配置以 `comecode config path` 及当前版本的诊断输出为准。

## 常用命令

```bash
comecode --help
comecode --version
comecode config setup
comecode config check
comecode admin --no-browser
comecode memory init
```

更多参数以 `comecode --help` 为准。当前管理页主要用于 Provider/模型配置；不要把未交付的会话、记忆或完整 Web 工作台功能当作已上线能力。
