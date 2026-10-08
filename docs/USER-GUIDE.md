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

### CLI 参数

```bash
comecode --help              # 查看完整帮助
comecode --web               # 启动并打开浏览器
comecode --no-web            # 不启动 Web 服务
comecode --web-port 8080     # 指定端口
comecode --resume            # 恢复上次会话
comecode config check        # 检查配置
comecode config setup        # 配置向导
```

---

## 环境变量（可选）

支持通过环境变量配置，无需修改配置文件：

```bash
# OpenAI
export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.openai.com/v1"

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."
export ANTHROPIC_BASE_URL="https://api.anthropic.com"

# 启动时自动使用环境变量
comecode
```

环境变量优先级：配置文件 > 环境变量

---

## 常见问题

### Q: 提示 "No model configured"

**A**: 首次使用需要配置模型，运行 `comecode config setup` 或在 Web 后台添加 Provider。

### Q: API 调用失败

**A**: 检查：
1. API Key 是否正确：`comecode config check`
2. Base URL 是否正确（注意结尾不要带 `/`）
3. 模型名称是否正确
4. 网络是否能访问 API 地址

### Q: 如何使用国内 API 服务

**A**: 配置对应的 Base URL 和 API Key 即可，如：
- DeepSeek: `https://api.deepseek.com`
- 智谱 GLM: `https://open.bigmodel.cn/api/paas/v4`
- 通义千问：按官方文档配置

### Q: 会话数据在哪里

**A**: 
- 全局：`~/.comecode/`
- 项目：`.comecode/`（在项目根目录）

### Q: 如何在多个项目间共享配置

**A**: 全局配置（`~/.comecode/config.toml`）在所有项目生效，项目配置（`.comecode/config.toml`）仅覆盖当前项目。

### Q: 配置文件格式错误怎么办

**A**: 
1. 运行 `comecode config check` 查看错误
2. 参考 `~/.comecode/config.toml.example`
3. 或删除配置文件重新运行 `comecode config setup`

---

## 进阶使用

### 项目记忆

ComeCode 会自动学习和记住项目信息，存储在 `.ai/` 目录：

- `.ai/memories/` - 项目知识和上下文
- `.ai/AGENTS.md` - 项目特定的 Agent 规则

建议将 `.ai/` 目录提交到 git，与团队共享。

### 自定义 Agent 规则

创建 `.comecode/AGENTS.md` 或 `CLAUDE.md`:

```markdown
# 项目规则

- 使用 TypeScript strict 模式
- 测试框架使用 Vitest
- UI 组件使用 Tailwind CSS
```

### 权限模式

```bash
# 查看当前权限模式
/config

# 可选模式：
# - plan: 需要审批执行计划
# - build: 自动执行，谨慎修改
# - edit: 可直接编辑文件
# - auto: 普通工具自动放行，仍遵守明确的 alwaysAsk、禁止工具和项目规则
# - yolo: 全自动（不推荐）
```

---

## 下一步

- 查看 [实施计划](PLAN.md) 了解开发路线图
- 查看 [开发指南](dev-setup.md) 参与贡献
- 遇到问题？提交 [Issue](https://github.com/xingzoudefengye/ComeCode/issues)

---

**最后更新**: 2026-10-05
