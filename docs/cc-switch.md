# cc-switch / Codex / Claude Code 配置兼容

ComeCode 的配置导入只读取本地文件，不调用 cc-switch、Codex 或 Claude Code 的网络接口，也不会修改这些工具的源配置。

## 导入命令

```powershell
comecode import codex
comecode import claude
# 兼容 README 中的旧写法
comecode --import codex
comecode --import claude
```

导入目标是 `~/.comecode/config.json`。如果用户已有 `config.toml` 或 `config.jsonc`，ComeCode 会先把原文件移动为带随机后缀的 `.bak` 备份，再写入统一 JSON；源文件不会被删除。

## Codex

读取：

- `~/.codex/config.toml`
- `~/.codex/auth.json`（只判断是否存在认证文件，不迁移 OAuth token）

支持的字段：

```toml
model = "模型名"
model_provider = "custom"

[model_providers.custom]
base_url = "https://example.test/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses" # responses 或 chat
```

映射关系：

- `wire_api = "responses"` → `openai-responses`
- `wire_api = "chat"` → `openai-chat`
- 未识别的 `wire_api` → 按兼容 Chat Completions 导入，并在结果中提示
- `env_key` → ComeCode 的 `apiKeyEnv`

Codex 的 `[projects]`、`[mcp_servers]` 等非 Provider 配置不会被导入。

## Claude Code

读取 `~/.claude/settings.json` 的 `env`：

- `ANTHROPIC_BASE_URL` → `baseUrl`
- `ANTHROPIC_MODEL`（没有时回退到默认 Sonnet/Opus/Haiku 模型字段）→ 模型名
- `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` → Provider API Key
- 协议固定为 `anthropic`（Anthropic Messages）

## 安全边界

- 导入摘要和 `--json` 结果不包含真实 API Key、Auth Token 或 OAuth token。
- 导入不发送测试请求；导入完成后可运行 `comecode config check`。
- 已有 Provider/模型不覆盖，只追加缺少的 Provider/模型。
