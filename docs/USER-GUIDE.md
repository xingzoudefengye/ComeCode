# ComeCode 使用指南

> **当前版本**: 从源码运行（npm 包尚未发布）

## 快速开始

### 1. 环境要求

- **Node.js**: >= 24.0.0（推荐 24.14.0 或更高）
- **pnpm**: 10.33.2（通过 corepack 使用）
- **操作系统**: Windows/macOS/Linux

### 2. 从源码运行

```bash
# 克隆仓库
git clone https://github.com/xingzoudefengye/ComeCode.git
cd ComeCode/engine

# 安装依赖（可选跳过 Electron，仅 CLI）
corepack pnpm@10.33.2 install --frozen-lockfile

# 或使用镜像加速（中国大陆用户）
corepack pnpm@10.33.2 install --frozen-lockfile --registry=https://registry.npmmirror.com
```

### 3. 首次启动

```bash
# 进入任意项目目录
cd /path/to/your/project

# 启动 ComeCode（会自动打开配置引导）
comecode
```

首次启动会提示配置模型，按照终端提示完成配置即可。

---

## 模型配置

### 方式一：命令行向导（推荐新手）

```bash
comecode config setup
```

向导会逐步询问：
1. **选择协议**: OpenAI 兼容 / Anthropic / OpenAI Responses
2. **API 地址**: 如 `https://api.openai.com/v1`
3. **模型名称**: 如 `gpt-4o`、`claude-opus-5`
4. **API Key**: 输入时会自动隐藏

配置保存在 `~/.comecode/config.toml`

### 方式二：Web 管理后台

```bash
# 启动 CLI 并自动打开浏览器
comecode --web

# 或手动访问（终端会显示地址和 token）
# http://127.0.0.1:4545/?token=<随机token>
```

在浏览器中：
1. 进入「Provider 配置」页面
2. 点击「添加 Provider」
3. 填写供应商信息：
   - **名称**: 自定义（如 "OpenAI"、"Claude"）
   - **协议类型**: 选择对应协议
   - **Base URL**: API 地址
   - **API Key**: 粘贴你的密钥
   - **默认模型**: 填写模型名称
4. 点击「测试连接」验证配置
5. 保存

### 方式三：直接编辑配置文件

编辑 `~/.comecode/config.toml`:

```toml
[[providers]]
name = "OpenAI"
protocol = "openai-chat"  # 或 "anthropic" / "openai-responses"
base_url = "https://api.openai.com/v1"
api_key = "sk-your-api-key-here"
default_model = "gpt-4o"

[[providers]]
name = "Claude"
protocol = "anthropic"
base_url = "https://api.anthropic.com"
api_key = "sk-ant-your-key-here"
default_model = "claude-opus-5"
```

保存后运行 `comecode config check` 验证配置。

---

## 切换模型

### 在 CLI 中切换

```bash
# 查看可用模型
/model

# 切换到指定模型
/model gpt-4o

# 切换到其他供应商的模型
/model claude-opus-5
```

### 在 Web 后台切换

1. 打开 Web 管理后台（`comecode --web`）
2. 进入「Provider 配置」
3. 选择要使用的 Provider
4. 点击「设为默认」

### 项目级模型配置

在项目根目录创建 `.comecode/config.toml`:

```toml
# 项目优先使用这个模型
default_model = "gpt-4-turbo"
```

项目配置优先级高于全局配置。

---

## 会话管理

### 恢复上次会话

```bash
# 启动时自动恢复（默认行为）
comecode

# 或显式指定
comecode --resume
```

### 恢复指定会话

```bash
# 列出所有会话
comecode --list-sessions

# 恢复指定会话
comecode --resume <session-id>
```

### 在 Web 后台查看会话

1. 打开 Web 管理后台
2. 进入「会话」页面（开发中）
3. 查看历史会话记录
4. 复制 `comecode --resume <id>` 命令到终端执行

### 会话存储位置

- **全局会话**: `~/.comecode/sessions/`
- **项目会话**: `.comecode/sessions/`（可提交到 git）

---

## 常用命令

### 斜杠命令（在 ComeCode 对话中使用）

```bash
/help          # 查看所有命令
/model         # 查看/切换模型
/clear         # 清空当前会话上下文
/config        # 打开配置菜单
/memory        # 查看项目记忆
/exit          # 退出
```

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
- 通义千问: 按官方文档配置

### Q: 会话数据在哪里

**A**: 
- 全局: `~/.comecode/`
- 项目: `.comecode/`（在项目根目录）

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
# - yolo: 全自动（不推荐）
```

---

## 下一步

- 📖 查看 [实施计划](PLAN.md) 了解开发路线图
- 🔧 查看 [开发指南](dev-setup.md) 参与贡献
- 🐛 遇到问题？提交 [Issue](https://github.com/xingzoudefengye/ComeCode/issues)

---

**最后更新**: 2026-10-05
