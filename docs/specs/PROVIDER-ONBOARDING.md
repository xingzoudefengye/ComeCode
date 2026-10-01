# 首次模型配置引导

## 问题与规则

当前无模型 TUI 启动不显示引导，输入后才返回内部 JSON 字段，OSC 8 控制字符还会被渲染为乱码。首次使用必须在启动时就能知道下一步，不要求理解 Provider Registry 或内部 JSON。

- CLI 根据 modelOptions 是否有未禁用模型判断是否需要引导；通过现有 TuiOptions.initialResult 渲染，不在 TUI 保留第二份配置状态。
- 无模型启动立即显示简体中文配置卡片，不进入厂商登录；普通输入、/model 等返回同一引导。
- 面向公开用户：不得把 NewAPI、自建网关或开发者个人接入方式写成必备条件。首屏和向导只显示配置操作、必填项和必要错误提示，不加“不是你的问题”“不提供模型”“不需要自建网关”等旁白。模板和向导使用通用接口/模型示例，不暗示必须购买某个服务。
- 引导首选 `comecode config setup`：中文向导逐步询问协议（OpenAI 兼容/chat、Responses、Anthropic）、URL、模型、Key，验证 URL，隐藏密钥输入，不发送联网探测请求。
- 不要求用户区分内部 JSON 字段；指向 ~/.comecode/config.toml（支持现有数据根）；有项目 TOML 时说明项目覆盖优先，修改项目文件或带 --cwd 到目标项目执行检查。
- 首次无文件自动用 exclusive create 写入全注释中文 TOML 模板；不写入有效凭据或虚构可执行模型。全注释模板不阻断已有环境变量零配置规则。
- 向导只允许 TTY，非交互给步骤；取消不写盘；覆盖已有用户文件前明确确认且备份，默认不覆盖；现有文件不可覆盖或备份失败时报告，不吞掉失败。
- 模板创建失败给出失败原因和可复制模板，不假称成功；已有文件不覆盖、不在提示里读取密钥。
- 不在 Markdown/TUI 中输出 OSC 8 控制字符；Windows 提供准确的 notepad 命令，其他平台可按纯文本路径打开。
- 同时显示带中文注释、可复制的最小 config.toml 示例，解释地址、Key、模型从哪里获得；明确保存、config check、退出重启。不要声称 /model 会刷新 TOML。
- `config check` 无任何可执行 Provider 时应失败，不能把空配置报告为 ok。

## 验收

隔离数据根：启动卡片在输入前可见、现有 TUI initialResult 渲染可见、普通输入和 sendInput 路由不绕过引导；注释模板创建/不覆盖/失败反馈；模板填值后 materialize 与 Registry 可读；向导合法输入/非法 URL/取消/覆盖确认/备份/密钥隐藏；空配置 check 非零；带注释模板仍支持环境变量默认模型。

必要 gate：相关包 typecheck、直接 oxlint、CLI 全量测试、新 bundle 构建和 --help 冒烟。保留旧 JSON、M1 和 T2.2 行为；不实现 Gemini 原生执行、Web 或导入器。


## 验证记录（2026-10-01）

- 全量 CLI 测试 81/81 通过，含原生 TUI 首屏渲染、真实 readline 密钥隐藏/取消、无模型 sendInput 门控、向导生成配置的 codec/check 验收。
- adapters、cli、tui、i18n 与 engine 根 typecheck 通过；直接改动文件 oxlint 0 warning / 0 error；架构检查 0 新违规。
- adapters build、TUI bundle 与 CLI bundle 构建通过；本机 comecode 启动 shim 指向本次构建文件。
- freshness 检查因 GitHub fetch 连接重置失败。包级 lint 有既有 apps/zcode-cli 忽略规则，CLI 聚合脚本有既有 turbo 不可用限制；未更改这些配置。
- 当前仅在 Windows / Node 24.19.0 验证，仓库指定 Node 24.14.0；未使用真实密钥或付费模型。
