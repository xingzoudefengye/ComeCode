# ComeCode

一个不绑定厂商、CLI 优先、带本地网页管理后台、拥有长期项目记忆的开源 AI Coding Agent。

基于 [ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，代码位于 [engine/](./engine)）二次开发，借鉴 [Codex](https://github.com/openai/codex)（Apache-2.0）的部分设计。许可与署名见 [LICENSE](./LICENSE)、[NOTICE](./NOTICE)。

> 原始构想见 [README.orig.md](./README.orig.md)，实施计划见 [docs/PLAN.md](./docs/PLAN.md)。

---

## 1. 用户体验目标

```bash
npm install -g comecode
cd my-project
comecode
```

- 终端：进入 TUI，正常对话式 Coding（读文件、改代码、跑测试、修 Bug）。
- 浏览器：同一进程内启动本地管理后台 `http://127.0.0.1:<port>`，默认只监听本机并带随机 token。
- 不需要额外启动 server，不需要登录任何账号，填好 API Key 就能用。

管理后台提供：Provider / 模型配置、会话列表、项目记忆查看与编辑、Agent 实时状态、日志与模型调用记录。

它不是另一个聊天界面，聊天和干活都在终端里进行。

## 2. 现状评估（基于源码核对）

ZCode 已经具备 Coding Agent 的大部分能力，ComeCode 的主要工作是：**去厂商化、补兼容、做轻量后台、做项目内记忆**。

| 能力 | ZCode 现状 | ComeCode 要做的 |
| --- | --- | --- |
| Agent 循环 / 规划 | 已有（turn-machine、TodoWrite、plan 模式、子 Agent） | 复用 |
| 工具 | Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/MCP/Skill 等 | 复用；可选增加 Codex 风格 `apply_patch` |
| 目标模式 `/goal` | 已有（设定目标后自动续跑，完成校验器判断是否达成，可暂停/恢复） | 复用；补预算上限（轮数/token/时间）与后台展示 |
| 权限 | plan / build / edit / yolo / auto + hooks | 复用 |
| Provider | Anthropic Messages、OpenAI Responses、OpenAI Chat 兼容；内置 GLM/DeepSeek/Qwen/Moonshot/OpenAI/Anthropic 等 | 去掉 z.ai 登录、网关、CDN 依赖；补 Gemini；读取标准环境变量 |
| 上下文压缩 | 已有自动 / 手动 / micro compact | 复用，调整总结写入 `.ai/` |
| 长期记忆 | 已有，但存在用户目录 `~/.zcode/cli/memories/...` | 改为项目内 `.ai/`，可提交到 git |
| Prompt Cache | 已有 stable / dynamic 分层与 cache breakpoint | 补命中率统计与展示 |
| Web | 完整的 ZCode 工作台（很重，含 OAuth、计费） | 新写轻量管理后台 |
| 一键启动 | CLI 和 server 分离，CLI 没有开浏览器的命令 | CLI 内嵌 HTTP server |

说明：Codex 的 Agent 核心是 Rust，无法直接移植到 TS。我们只借鉴其设计和文本资产（系统提示词、`apply_patch` 语法、压缩提示词、AGENTS.md 规则），并按 Apache-2.0 保留署名。

## 3. 总体架构

```
                    comecode (单进程)
          ┌─────────────┴──────────────┐
      TUI 终端                 Admin HTTP + WS (127.0.0.1)
          └─────────────┬──────────────┘
                 Session Manager
                        │
                  Agent Runtime（ZCode core）
       ┌────────────────┼────────────────┐
  Context/Cache     Provider Layer     Memory (.ai/)
       └────────────────┼────────────────┘
                        │
        OpenAI 兼容 (NewAPI 等) / Anthropic / Gemini
        / DeepSeek / GLM / Qwen / ...
```

原则：尽量不改 ZCode `core` 的内部结构，把改动集中在 `adapters`（Provider、配置、存储）、`bootstrap`（启动编排）和新增的 `admin` 包里，方便以后同步上游。

## 4. Provider 系统

目标：解除模型绑定，任何兼容接口都能接入。

配置文件 `~/.comecode/config.toml`（项目内可用 `.comecode/config.toml` 覆盖）：

```toml
model = "deepseek-v4.1"
provider = "newapi"

[providers.newapi]
type = "openai-chat"        # openai-chat | openai-responses | anthropic | gemini
base_url = "https://你的newapi地址/v1"
api_key_env = "NEWAPI_API_KEY"   # 推荐引用环境变量，也可直接写 api_key
```

配置优先级：命令行参数 > 环境变量 > 项目配置 > 用户配置 > 内置默认。

配置诊断命令：`comecode config path` 查看配置路径，`comecode config show` 查看合并后的脱敏配置，`comecode config check` 校验配置。运行时还可用 `--model <model>` 和 `--provider <id>` 临时覆盖默认选择。

## 5. 与 cc-switch / 现有生态兼容

cc-switch 通过改写各工具的配置文件来切换 Provider，而不是只设置环境变量。兼容分两层：

1. 环境变量（零配置可用）：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`GEMINI_API_KEY`，以及 `COMECODE_MODEL`（兼容 `MODEL`）。
2. 可选导入：`comecode --import codex|claude` 读取 `~/.codex/config.toml`、`~/.claude/settings.json` 中 cc-switch 写入的配置，生成 ComeCode Provider。

目标链路：

```
cc-switch ──> Codex / Claude Code 配置 ──(导入或读取)──> ComeCode ──> NewAPI ──> 各家模型
```

## 6. 长期项目记忆（核心差异化）

一个项目可以连续使用几周、几个月，不会因为上下文窗口爆掉而从头开始。记忆放在项目内，可以提交到 git 和团队共享。

```
.ai/
├── project.md     项目介绍、技术栈、目标（人工为主，AI 可建议修改）
├── decisions.md   架构决定与原因（追加式）
├── tasks.md       当前任务、TODO
├── bugs.md        已知问题
├── memory.md      历史压缩摘要（AI 维护，按日期分段）
└── .local/        不提交：会话原始记录、索引、缓存（自动加入 .gitignore）
```

同时兼容读取 `AGENTS.md`、`CLAUDE.md`，作为项目规则。

分层策略：

- 短期记忆：最近若干轮对话原文直接进入上下文。
- 中期记忆：超过阈值的旧对话自动压缩为摘要（复用 ZCode compact）。
- 长期记忆：会话结束或压缩时，把决定、任务、问题提炼写入 `.ai/`；下次启动时按固定顺序加载。

写入规则：AI 对 `.ai/` 的修改走 Edit 工具，受权限控制，终端里可见 diff；单个文件有大小上限，超出后再做一次摘要。

## 7. 目标模式与永续会话

目标模式：`/goal <目标>` 设定一个可验证的目标（如"所有测试通过"），Agent 自动迭代：执行 → 校验 → 未达成则继续。必须带预算上限（最大轮数、token、时长），触达上限或连续多轮无进展时暂停并通知用户。建议配合 build/edit 权限模式或沙箱使用，不建议无限制 yolo。

永续会话：一个终端窗口可以长期使用，不需要因为上下文满了而重开。原理像细胞更新，保留"骨架"，持续替换"细胞"：

- 固定层（不压缩）：系统提示词、项目规则、`.ai/` 记忆快照、当前目标与任务。
- 近期层（原文）：最近若干轮对话。
- 摘要层（滚动）：更早的对话压缩成摘要，摘要本身超限时再次合并。
- 归档层（落盘）：被压缩掉的原文保存到 `.ai/.local/`，需要时可按关键词检索回来。

需要说明的边界：上下文窗口是有限的，所以"无限"指的是会话能一直进行，不是模型记得全部细节。多次压缩后早期细节必然会丢失，重要信息要靠沉淀到 `.ai/` 文件和归档检索来保住。

## 8. Prompt Cache 优化

请求结构保持稳定前缀：

```
[系统提示词] + [工具定义（固定排序）] + [项目规则 AGENTS.md]
+ [.ai/ 记忆快照（会话内冻结）] ← 以上为稳定前缀，打 cache breakpoint
+ [历史消息] + [本轮动态信息：时间、git 状态等放在末尾] + [新问题]
```

原则：

- 工具列表按名称固定排序，会话中途不增减（MCP 变化延后到下次会话或压缩时生效）。
- `.ai/` 在会话内修改后，不立即刷新到前缀里，压缩或新会话时再刷新。
- 时间、cwd、git 状态等易变信息放在最后一条消息里，不放进系统提示词。
- 后台展示每次请求的 cache 命中 token 数和命中率，用数据验证效果。

## 9. Web 管理后台

轻量单页应用，由 CLI 进程直接托管静态文件，通过 WebSocket 订阅 Agent 事件。

1. 配置：Provider 增删改、测试连通性、选择默认模型。
2. 会话：列出各项目会话（运行中 / 空闲 / 已结束），查看历史，恢复会话。
3. 记忆：查看、编辑 `.ai/` 下文件。
4. 状态：当前工具调用（正在读取 xxx、正在执行测试、修改 xxx.py）、token 用量、cache 命中率。
5. 日志：运行日志、模型请求与响应记录。

安全：默认只监听 `127.0.0.1`，启动时生成随机 token 拼在打印的 URL 中；API Key 在界面上脱敏显示。

## 10. 版本路线

| 版本 | 目标 | 关键内容 |
| --- | --- | --- |
| V0.1 | 本地跑通 | 构建 ZCode CLI；对外改名为 `comecode`；数据目录改为 `~/.comecode`；去掉必须登录 |
| V0.2 | 多模型 | 标准环境变量；`config.toml`；Gemini；cc-switch 导入；去掉 z.ai 网关和 CDN 依赖 |
| V0.3 | 长期会话 | `.ai/` 目录；永续会话分层压缩；目标模式预算；压缩摘要写入记忆；兼容 CLAUDE.md；cache 命中统计 |
| V0.4 | Web 后台 | CLI 内嵌 server；配置、会话、记忆、状态、日志页面 |
| V0.5 | 开源发布 | npm 发布、安装脚本、文档、Docker、插件机制说明、上游同步流程 |

每个版本结束都要满足：能构建、能在 Windows / macOS / Linux 启动、核心流程有测试。

## 11. 许可证与署名

- ZCode 与 Codex 均为 Apache-2.0。ComeCode 同样使用 Apache-2.0。
- 保留两个上游的 LICENSE 与 NOTICE，在 NOTICE 中说明派生关系；修改过的文件注明已修改。
- 不使用 "ZCode"、"Codex"、"Claude" 作为产品名或 Logo。

## 最终定位

不是「另一个 Codex」，而是一个不绑定任何厂商、支持所有主流模型、CLI 优先、网页管理、拥有长期项目记忆的开源 AI 软件工程师。
