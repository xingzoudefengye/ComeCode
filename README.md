# ComeCode

一个不绑定厂商的开源 Coding Agent：以 CLI 为当前入口，规划提供共享会话的桌面版、本地管理后台和受控插件扩展。

**当前状态（2026-10-03）：** CLI、多模型配置、项目记忆基础与本地模型管理页已有实现；尚未正式发布 npm 包/安装器。ComeCode 桌面改造、跨端会话共享、完整后台页面和自定义工具插件仍在路线中。实现与验收范围见 [实施计划](docs/PLAN.md)，不要把上游已有能力或目标功能当作已交付版本。

基于 [ZCode](https://github.com/zai-org/ZCode)（Apache-2.0，代码位于 [engine/](./engine)）二次开发，借鉴 [Codex](https://github.com/openai/codex)（Apache-2.0）的部分设计。许可与署名见 [LICENSE](./LICENSE)、[NOTICE](./NOTICE)。

> 实施计划见 [docs/PLAN.md](./docs/PLAN.md)。

---

## 1. 用户体验目标

以下是**发布后的目标安装方式**，目前从源码运行请看 [开发指南](docs/dev-setup.md)。

```bash
npm install -g comecode
cd my-project
comecode
```

- 终端：进入 TUI，正常对话式 Coding（读文件、改代码、跑测试、修 Bug）。
- 浏览器：同一进程内启动本地管理后台 `http://127.0.0.1:<port>`，默认只监听本机并带随机 token。
- 桌面：基于上游 Electron 桌面端改造的 ComeCode Desktop，复用同一套 CLI Agent，与 CLI/Web 后台会话共享（见 [docs/PLAN.md](docs/PLAN.md) M6）。
- 不需要额外启动 server，不需要登录任何账号，填好 API Key 就能用。

管理后台目前提供 Provider / 模型配置与连接测试；会话、记忆、状态和日志页面是规划功能。

浏览器后台只做管理；对话和任务执行在 CLI 或规划中的桌面版完成。桌面将复用同一套 Agent、配置和会话存储，并支持跨端恢复及单执行所有者，不是另一套独立聊天系统。

## 2. 现状评估（基于源码核对）

ZCode 已经具备 Coding Agent 的大部分能力，ComeCode 的主要工作是：**去厂商化、补兼容、做轻量后台、做项目内记忆**。

| 能力              | ZCode 现状                                                                                                  | ComeCode 要做的                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Agent 循环 / 规划 | 已有（turn-machine、TodoWrite、plan 模式、子 Agent）                                                        | 复用                                                             |
| 工具              | Read/Write/Edit/Bash/Glob/Grep/WebFetch/WebSearch/MCP/Skill 等                                              | 复用；可选增加 Codex 风格 `apply_patch`                          |
| 目标模式 `/goal`  | 已有（设定目标后自动续跑，完成校验器判断是否达成，可暂停/恢复）                                             | 复用；补预算上限（轮数/token/时间）与后台展示                    |
| 权限              | plan / build / edit / yolo / auto + hooks                                                                   | 复用                                                             |
| Provider          | Anthropic Messages、OpenAI Responses、OpenAI Chat 兼容；内置 GLM/DeepSeek/Qwen/Moonshot/OpenAI/Anthropic 等 | 去掉 z.ai 登录、网关、CDN 依赖；仅三种执行协议；读取标准环境变量 |
| 上下文压缩        | 已有自动 / 手动 / micro compact                                                                             | 本地短交接，不额外调用摘要模型；长期记忆独立处理                                        |
| 长期记忆          | 已有，但存在用户目录 `~/.zcode/cli/memories/...`                                                            | 改为项目内 `.ai/`，可提交到 git                                  |
| Prompt Cache      | 已有 stable / dynamic 分层与 cache breakpoint                                                               | 补命中率统计与展示                                               |
| Web               | 完整的 ZCode 工作台（很重，含 OAuth、计费）                                                                 | 新写轻量管理后台                                                 |
| 一键启动          | CLI 和 server 分离，CLI 没有开浏览器的命令                                                                  | CLI 内嵌 HTTP server                                             |

说明：Codex 的 Agent 核心是 Rust，无法直接移植到 TS。我们只借鉴其设计和文本资产（系统提示词、`apply_patch` 语法、压缩提示词、AGENTS.md 规则），并按 Apache-2.0 保留署名。

## 3. 总体架构

```text
当前入口：CLI TUI + 本地 Admin（同进程）
规划入口：ComeCode Desktop Renderer → Host → CLI app-server
                         │
                同一套 Agent Runtime / SessionStore
                         │
      配置/Provider ─ 工具与权限 ─ Context/Cache ─ 项目记忆
                         │
          OpenAI Chat / OpenAI Responses / Anthropic Messages
```

原则：复用现有 CLI/protocol、存储及桌面组件，不另建 Agent、权限链或插件框架。改动优先落在 `adapters`、`bootstrap`、CLI admin 与桌面必要的适配层；桌面与 CLI 会话共享是待验收目标，不把当前上游任务索引当作共享已经完成。

## 4. Provider 系统

目标：解除模型绑定，任何兼容接口都能接入。

**第一次使用：直接运行 `comecode`。** 没有可用模型时会直接提问，填写 API 接口地址、模型名称、API Key；接口类型默认 OpenAI Chat Completions。其他参数使用默认值，密钥输入不回显，完成后自动保存 JSON 并继续启动。首次使用不需要找配置文件或退出编辑，也不会为检查配置发起付费模型请求。

已有模型不会重复提问或覆盖配置。也可使用 `comecode config setup` 单独配置；已有多模型配置不由简单向导整体替换。Web 模型管理已支持：默认进入模型列表，添加模型时填写接口地址、API Key、协议和模型名；相同地址自动归类，供应商信息可单独编辑。

### 多模型精细配置（高级使用）

推荐 `~/.comecode/config.json`；项目 `.comecode/config.json` 可覆盖用户配置。支持带注释的 `config.jsonc`，保留 `config.toml` 和旧 `v2/provider_config.json` 兼容。

```json
{
  "provider": "my-api",
  "model": "model-a",
  "providers": [
    {
      "id": "my-api",
      "name": "我的模型服务",
      "type": "openai-chat",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_MODEL_API_KEY",
      "contextWindow": 512000,
      "maxOutputTokens": 64000,
      "toolCalling": true,
      "vision": false,
      "models": [
        { "id": "model-a", "name": "模型 A" },
        { "id": "model-b", "name": "模型 B", "vision": true },
        {
          "id": "vendor/model-c",
          "type": "anthropic",
          "baseUrl": "https://example.com/anthropic",
          "contextWindow": 128000
        }
      ]
    }
  ]
}
```

供应商填写公共默认值，模型只填写不同的字段。`models` 也可以直接写模型名称字符串。`id` 是服务商实际模型名（含 `/` 原样保留），`name` 只用于界面展示；`contextWindow` 为上下文总窗口，`maxOutputTokens` 为输出上限，不代表每次请求固定输出这么多。没有显式窗口时沿用模型专属规则或通用 512000 默认，不覆盖已有明确窗口。

连接类型支持 `openai-chat`、`openai-responses`、`anthropic`；`gemini` 暂时只识别/检查，不能执行。密钥可用 `apiKeyEnv` 引用环境变量，或直接填写 `apiKey`，二者不要同时填写；`config show` 对供应商和模型凭据均脱敏。包含密钥的文件不要分享或提交到 Git。

配置优先级：命令行参数 > 标准环境变量 > 项目配置 > 用户配置 > 旧 Provider 配置/内置默认。同目录多个格式按 JSON > JSONC > TOML 选择一个，`config check` 会提示其他文件被忽略；项目向上查找最近的配置目录。用户/项目同供应商和同模型按字段合并，项目显式 `models` 数组决定该供应商成员集合。

`comecode config path` 查看实际路径；`comecode config show` 查看脱敏有效配置；`comecode config check` 做本地结构校验，不验证密钥远端是否有效。`--model <model>`、`--provider <id>` 临时覆盖默认选择。

**配置体验：** 全局模型和 Key 配置一次，所有项目直接使用，不新增逐项目信任或重复授权。项目覆盖仍沿用现有优先级；有效配置的跨项目隔离待内部修复（见 [T2.6](docs/PLAN.md)），当前不要把派生配置隔离视为已经完成。保留已有工具权限、配置备份和日志脱敏。

没有有效配置文件时可通过环境变量启动。仅设置凭据也可使用固定默认模型：OpenAI `gpt-4.1-mini`、Anthropic `claude-sonnet-4-5`；Gemini `gemini-2.5-flash` 暂时仅检查、不执行。多种凭据同时存在时按 OpenAI → Anthropic → Gemini 选择；可用 `COMECODE_PROVIDER` 指定（`--provider` 更优先）。有有效配置文件时不自动覆盖其中的 Provider 选择。

PowerShell 示例（Key 使用自己的凭据，不要提交到 Git）：

```powershell
$env:OPENAI_API_KEY = "你的 API Key"
# 自定义 OpenAI 兼容网关可选：
$env:OPENAI_BASE_URL = "https://example.test/v1"
$env:COMECODE_MODEL = "网关支持的模型名"
comecode --prompt "介绍一下当前项目"
```

`COMECODE_MODEL` 优先于 `MODEL`，`--model` 优先于两者。自定义网关不一定支持固定默认模型，建议显式指定模型。启动说明只输出到 stderr，不影响 JSON/协议 stdout。详细规则见 [零配置启动](docs/specs/T2.2.md)。

## 5. 与 cc-switch / 现有生态兼容

cc-switch 通过改写各工具的配置文件来切换 Provider，而不是只设置环境变量。兼容分两层：

1. 环境变量（零配置可用）：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`GEMINI_API_KEY`，以及 `COMECODE_MODEL`（兼容 `MODEL`）。
2. 可选导入：`comecode --import codex|claude` 读取 `~/.codex/config.toml`、`~/.claude/settings.json` 中 cc-switch 写入的配置，生成 ComeCode Provider。

目标链路：

```
cc-switch ──> Codex / Claude Code 配置 ──(导入或读取)──> ComeCode ──> 模型平台官方 API / 兼容服务（网关可选）
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
└── .local/        本地辅助文件预留目录，不提交（memory init 自动加入 .gitignore）
```

同时兼容读取 `AGENTS.md`、`CLAUDE.md`，作为项目规则。

初始化项目记忆：

```powershell
comecode memory init
comecode memory path
comecode memory check
```

在 TUI 会话中输入 `/memory save`，可以立即让当前会话的长期信息沉淀到 `.ai/`；自动提取仍会在成功回合后后台运行。

运行 `memory init` 只补齐缺失的 `.ai/` 模板文件，不覆盖已有内容，并把 `.ai/.local/` 加入项目 `.gitignore`。
分层策略：

- 短期记忆：最近若干轮对话原文直接进入上下文。
- 中期记忆：达到阈值时本地生成短交接，仅携带当前目标、近期进展与有限操作结果；大段原文不回带，不额外调用摘要模型。
- 会话史书：普通回合结束后自动留下短小结，本地存储固定在 6,000 字符以内（包含 JSON 开销）；近期细、旧记录合并为阶段再变粗，普通续作不附带，问历史时按需读取概括。
- 长期记忆：独立提炼决定、任务、问题写入 `.ai/`；下次启动时加载。初始化与显式保存均可选，不是压缩前置条件；后台预算、保存等待和并发可靠性仍待收尾。

正常提取通过工具权限链写入。当前自动滚动处理仍需补权限与冲突控制，且只是丢弃旧段落，并非语义摘要；`memory.scope` 配置已存在，但 `both` 尚未完整双读写。以上作为明确未完成项列入 [T3.2/T3.7](docs/PLAN.md)，不承诺全部历史自动保留。

## 7. 目标模式与永续会话

目标模式：`/goal <目标>` 设定一个可验证的目标（如"所有测试通过"），Agent 自动迭代：执行 → 校验 → 未达成则继续。预算收尾目标是后台采用合理的默认 token/时间上限，触达边界或持续无进展时暂停并通知；用户不需要先配置一组预算才能开始任务。相关边界仍待补齐，现有取消和权限模式保持不变。

永续会话：一个终端窗口可以长期使用，不需要因为上下文满了而重开。原理像细胞更新，保留"骨架"，持续替换"细胞"：

- 固定层（不压缩）：系统提示词、项目规则、`.ai/` 记忆快照、当前目标与任务。
- 近期层（原文）：最近若干轮对话。
- 摘要层（本地史书）：固定容量，最近记录较详细，旧记录合并成阶段后变粗或丢弃；普通续作不注入，历史问题按需读取。
- 内部记忆层：压缩后仅携带当前工作的有界交接，项目记忆从 `.ai/` 加载；不新增压缩原文归档或独立检索命令。

需要说明的边界：上下文窗口是有限的，所以"无限"指的是会话能一直进行，不是模型记得全部细节。压缩会丢失部分原文细节；程序使用摘要、干活指南和 `.ai/` 项目记忆接续任务，不保证自动保留全部历史。

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
- 后台完整用量展示仍待实现。缓存效果依赖供应商及工作负载，首次请求、短上下文、压缩后不承诺命中率。
- 95% 仅针对稳定大前缀的热请求目标，有限样本不代表所有模型达标；不填充无用上下文或付费保活。省费用还需统计主对话、子代理、压缩、记忆和重试的全部调用，未知 usage/单价必须标为未知。

## 9. Web 管理后台

当前是 CLI 内嵌 server 与静态管理页；后续按需扩展已有接口与事件，不重建完整 Web 工作台。下列只有配置页已交付，其余是目标功能。

1. 配置：Provider 增删改、测试连通性、选择默认模型。
2. 会话：列出各项目会话（运行中 / 空闲 / 已结束），查看历史，恢复会话。
3. 记忆：查看、编辑 `.ai/` 下文件。
4. 状态：当前工具调用（正在读取 xxx、正在执行测试、修改 xxx.py）、token 用量、cache 命中率。
5. 日志：运行日志、模型请求与响应记录。

安全：默认只监听 `127.0.0.1`，启动时生成随机 token 拼在打印的 URL 中；API Key 在界面上脱敏显示。

## 10. 版本路线

| 版本 | 目标                | 关键内容                                                                                       |
| ---- | ------------------- | ---------------------------------------------------------------------------------------------- |
| V0.1 | 本地跑通            | 构建 ZCode CLI；对外改名为 `comecode`；数据目录改为 `~/.comecode`；去掉必须登录                |
| V0.2 | 多模型              | 标准环境变量；JSON/JSONC（兼容 TOML）；三种执行协议；cc-switch 导入；去掉 z.ai 网关和 CDN 依赖 |
| V0.3 | 长期会话            | 固定容量交接；后台预算；可选 `.ai/` 项目记忆；兼容 CLAUDE.md；cache 命中统计  |
| V0.4 | Web 后台            | CLI 内嵌 server；配置、会话、记忆、状态、日志页面                                              |
| V0.5 | 开源发布            | 先 npm + GitHub Release + 三平台 CI/干净安装；再安装脚本、可选 Docker/包管理器                 |
| V0.6 | 桌面版              | 复用上游桌面与 CLI 执行链，共享会话、权限确认、diff/终端、三平台安装包与受控更新               |
| V0.7 | 插件/harness 自由度 | 复用加载安装基础，先开放自定义工具；策略/循环和 Provider 扩展留后，默认关闭远程市场            |

这些是能力路线，不是已发布版本。GitHub Actions 可以在 tag 后自动构建并上传 Release，但需要本项目的根目录工作流、发布授权及可运行的打包资产；目前还没有 ComeCode 工作流。CLI 先发布，不等待桌面或所有后台页面；桌面研发也不等待所有分发渠道完成。每个公布支持的平台都要用实际安装包验证，而不只验证源码能构建。

### 在终端会话中添加截图

复制截图后，在 ComeCode 输入框按 `Ctrl+V`。图片成功附上后会显示 `[image #1]`，再输入问题并回车发送。

如果终端截获了粘贴按键，也可以输入 `/paste` 后回车，直接读取剪贴板图片；无需修改终端快捷键。读取失败的原因会显示在输入框附近。发送图片需要当前模型支持图片输入。

## 11. 许可证与署名

- ZCode 与 Codex 均为 Apache-2.0。ComeCode 同样使用 Apache-2.0。
- 保留两个上游的 LICENSE 与 NOTICE，在 NOTICE 中说明派生关系；修改过的文件注明已修改。
- 不使用 "ZCode"、"Codex"、"Claude" 作为产品名或 Logo。

## 12. 支持与捐赠

ComeCode 由个人自费开发维护，项目采用 Apache-2.0 开源许可。用户自行配置模型供应商并承担 API 费用；开源免费不等于模型调用免费。计划提供自愿赞助入口，支持与否不影响功能，不在会话中弹窗、追踪或拦截操作。

- 中国大陆：优先爱发电，核实支付/提现规则后公布微信、支付宝可用入口。
- 国际：优先 GitHub Sponsors，但先核实维护者所在地区与收款资格；不假定中国大陆可直接开通，也不承诺支付宝支持。其他渠道同样要验证实际收款条件。

目前赞助账户、链接和 `comecode sponsor` 命令尚未交付，因此不展示占位支付链接。落地后只在 README/帮助页及用户主动调用的命令中提供入口，不在版本或机器可读输出里加提示。

## 最终定位

一个不绑定厂商、兼容主流模型协议、提供 CLI 和共享会话桌面版、重视长期项目记忆与可控成本的开源 Coding Agent。通过小步开放插件增强能力，而不是为自由度另造一套难以维护的内核。
