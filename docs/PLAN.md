# ComeCode 实施计划与任务拆分

本文用于把工作委派给其他 Agent。每个任务都是独立可交付的单元，包含：目标、依赖、涉及位置、做法要点、验收标准。

路径约定：`engine/` 指 ComeCode 仓库中通过 git subtree 导入的 ZCode 代码，`CLI/` 指 `engine/apps/zcode-cli/packages/`，`codex/` 指仓库外的 Codex 参考克隆（`E:\Projects\ComeCode\codex`，已被 .gitignore 忽略）。

---

## 0. 全局约定（每个任务都要遵守，委派时附上本节）

1. 开发仓库：ComeCode 仓库（`origin` = github.com/xingzoudefengye/ComeCode），`main` 为主分支，功能在 `feat/<任务号>` 分支开发后合并。ZCode 代码在 `engine/`，同步上游时另开 `upstream-sync` 分支执行 `git subtree pull --prefix=engine upstream-zcode main`，解决冲突后再合回 `main`。`codex/` 只作参考，不改、不入库。
2. 改名分层，控制和上游的差异：
   - 必须改：npm 包名、`bin` 命令名、数据目录（`~/.comecode`）、用户可见文案、系统提示词中的产品身份。
   - 不改：内部 `@zcode/*` 包 scope、源码标识符、目录名。避免上万处无意义 diff，导致无法合并上游。
   - 环境变量：新增 `COMECODE_*`，读取时回退到对应的 `ZCODE_*`，旧变量不删。
3. 改动集中在 `CLI/adapters`、`CLI/bootstrap`、`CLI/cli` 和新增包；`CLI/core` 尽量只加扩展点，不改内部逻辑。
4. 不动 `packages/desktop`、`packages/web`、`packages/ui`，也不让 ComeCode 的构建依赖它们。
5. 环境：Node 24.14.0，pnpm 10.33.2（见 `engine/mise.toml`）。每个任务完成后至少运行：相关包的 `typecheck`、`lint`、单测，以及 `comecode --help` 冒烟测试。
6. 从 `codex/` 复制的文本或移植的代码：文件头注明来源和 "Modified by ComeCode"，并在 `NOTICE` 中登记。
7. 每个任务单独提交一个 PR，PR 描述写清：改了什么、如何验证、已知风险。

---

## 1. 依赖关系总览

```
M0 基线
 └─ T0.1 构建跑通 ─ T0.2 上游同步说明
      └─ M1 品牌与去耦
          T1.1 对外改名 ─ T1.2 数据目录 ─ T1.3 去掉强制登录 ─ T1.4 关闭默认外连
               └─ M2 Provider
                   T2.1 统一配置 ─┬─ T2.2 标准环境变量
                                 ├─ T2.3 Gemini
                                 ├─ T2.4 cc-switch 导入
                                 └─ T2.5 内置 Provider 本地化
                        └─ M3 记忆与缓存（与 M4 可并行）
                            T3.1 .ai/ 加载 ─ T3.2 记忆写入 ─ T3.3 CLAUDE.md 兼容
                            T3.4 缓存稳定性 ─ T3.5 缓存统计
                            T3.7 目标模式加固 ─ T3.8 永续会话（依赖 T3.1）
                        └─ M4 Web 后台（与 M3 可并行）
                            T4.1 内嵌 server ─ T4.2 事件总线 ─ T4.3 前端骨架
                            ─ T4.4~T4.8 各页面
                                 └─ M5 发布
                                     T5.1 npm 包 ─ T5.2 安装脚本 ─ T5.3 文档 ─ T5.4 Docker ─ T5.5 CI
```

可并行的组合：T2.2/T2.3/T2.4/T2.5 互不依赖；M3 与 M4 互不依赖；T4.4~T4.8 互不依赖。

---

## M0 基线

### T0.1 本地构建并跑通 ZCode CLI
- 依赖：无
- 位置：`engine/`、`engine/apps/zcode-cli`
- 做法：
  - 用 mise 或 nvm 安装指定的 Node/pnpm 版本；运行 `pnpm install`，然后 `pnpm --dir apps/zcode-cli build`。
  - 如果构建依赖了 desktop 资源准备步骤，找出最小构建路径（只需要 CLI 和它依赖的 `packages/provider`、`provider-node`、`shared`、`model-option-map`）。
  - 配置一个 OpenAI 兼容的个人 Provider（写入 `~/.zcode/v2/provider_config.json`），跑一次 `--prompt` 无头模式和一次 TUI 对话。
- 交付：`docs/dev-setup.md`，记录 Windows 下的构建步骤、踩到的坑（原生模块 koffi、node:sqlite、ripgrep、OpenTUI）和解决方法。
- 验收：在 Windows 上按文档从零构建成功；`node .../dist/zcode.cjs --prompt "列出当前目录文件"` 能返回结果。

### T0.2 上游同步流程
- 依赖：T0.1
- 做法：添加 `upstream` remote；写 `docs/upstream-sync.md`，说明合并步骤和容易冲突的文件清单；可选写一个脚本，统计与上游的 diff 规模。
- 验收：演示一次从 upstream 合并（可以用当前 HEAD 做空合并）。

---

## M1 品牌与去耦（V0.1）

2026-09-30：T1.2 → T1.3 → T1.4 已在工作区实现，18 项源码测试与相关类型检查通过。CLI 单文件打包和 Git 提交受当前沙箱限制，标准 lint 存在历史超长文件错误，完整构建验收仍待复跑。配置与验证记录见 [M1 规则](specs/M1.md) 和 [开发环境](dev-setup.md)。

### T1.1 对外命令与包名改为 comecode
- 依赖：T0.1
- 位置：`CLI/cli/package.json`（bin `zcode` → `comecode`）、`CLI/cli/scripts/build.mjs`（产物名）、`--help`/版本输出、TUI 标题与欢迎语、系统提示词中的产品身份（在 `CLI/core` 的 prompt 相关文件中搜索 "ZCode"）。
- 做法：用户可见字符串集中到一个常量（如 `PRODUCT_NAME`），不做全局替换。
- 验收：`comecode --help`、TUI 界面、问 AI "你是谁" 均显示 ComeCode；`git diff --stat` 控制在几十个文件以内。

### T1.2 数据目录与环境变量前缀
- 依赖：T1.1
- 位置：`CLI/cli/src/provider-runtime-env.ts`、`CLI/adapters/src/config/env-config.adapter.ts`、`packages/services/src/paths.ts`（如果 CLI 用到了）、`~/.zcode/cli` 相关路径。
- 做法：
  - 默认数据目录改为 `~/.comecode`；`COMECODE_DATA_BASE_DIR` 优先，回退 `ZCODE_DATA_BASE_DIR`。
  - 环境变量读取加一层映射：读 `COMECODE_X`，没有则读 `ZCODE_X`。
  - 首次启动时如发现 `~/.zcode` 存在而 `~/.comecode` 不存在，提示是否导入（不自动迁移）。
- 验收：单测覆盖变量回退逻辑；新环境下启动只创建 `~/.comecode`。

### T1.3 去掉强制登录
- 依赖：T1.1
- 位置：`CLI/adapters/src/auth/cli-oauth.ts`、`login`/`logout` 子命令、启动时的鉴权检查。
- 做法：只要配置了任意 API Key Provider，就不要求登录；没有配置时引导用户配置 Provider（提示写配置文件，V0.4 后提示打开 Web 后台）。`login` 命令暂时隐藏。
- 验收：在没有 `~/.zcode` 的全新环境，只设置环境变量或配置文件即可完成一次对话，全程不访问 `zcode.z.ai`。

### T1.4 默认关闭所有外连
- 依赖：T1.1
- 位置：`CLI/adapters/src/model/official-coding-plan-gateway.ts`（GLM 请求改走网关）、`packages/provider-node/src/zcode-builtin-download.ts`（CDN 下载 Provider 目录）、`packages/shared/src/zcodeEndpoint.ts`、插件市场（`cdn-zcode.z.ai`）、`CLI/telemetry`。
- 做法：
  - 网关改写：默认关闭，请求直连用户配置的 `base_url`。
  - Provider 目录：只用打包进来的本地 JSON，不再远程刷新。
  - 插件市场：默认禁用，可通过配置显式开启。
  - 遥测：保持"未设置 OTLP 就不上报"，并在文档中说明。
- 验收：用抓包或 `NODE_DEBUG=http`、或在代码里 mock `fetch`，确认一次完整会话只访问用户配置的模型地址；写一个集成测试，断言只请求了白名单主机。

---

## M2 Provider 系统（V0.2）

### T2.1 统一配置文件 config.toml（已完成，2026-10-01）
- 依赖：T1.2
- 实现：`CLI/adapters/src/config/provider-config.ts`，在 CLI 边界转换为兼容的 `provider_config.json`，不改 Provider Registry 和内部协议。
- 已完成：用户级/项目级配置发现、最小 TOML 子集、标准环境变量归一化、CLI 覆盖、`config path|show|check`、API Key 脱敏、OpenAI/Anthropic type 映射，以及 Gemini 仅检查不执行。
- 验证：统一配置单测覆盖解析、合并优先级、环境变量、脱敏、兼容 materialize；未实现 Gemini 原生适配、配置导入和 Web 后台，分别留给 T2.3、T2.4、M4。

2026-10-01 首次使用体验修复：无模型首屏中文操作卡片、`comecode config setup` 向导、带注释模板、密钥隐藏与覆盖备份；规则和验收见 [首次模型配置引导](specs/PROVIDER-ONBOARDING.md)。

### T2.2 标准环境变量零配置启动（已完成，2026-10-01）
- 依赖：T2.1
- 已完成：无 TOML 时按 OpenAI → Anthropic → Gemini 探测非空凭据；固定默认模型；`COMECODE_PROVIDER` 选择；CLI 覆盖；stderr 启动说明；只读配置命令不写盘。
- OpenAI 环境 Provider 保持 openai-chat；Anthropic API Key 优先于 Auth Token；Gemini 仅检查不执行，原生支持仍属于 T2.3。
- 规则与边界见 [T2.2](specs/T2.2.md)。继续复用现有 JSON materialize 路径，不重做 Registry 或持久化机制。
- 验证：配置组合、旧 JSON/TOML 兼容测试与真实 CLI 子进程 + 本地 HTTP mock 完整对话；检查默认模型、鉴权、JSON stdout 和 stderr 脱敏。

### T2.3 Gemini 原生支持
- 依赖：T2.1
- 位置：`CLI/adapters/src/model/model-execution.ts`（281-372 行附近按 API 类型创建模型的地方）。
- 做法：引入 `@ai-sdk/google`（锁定精确版本，和现有 `@ai-sdk/*` 主版本匹配）；新增 `gemini` API 类型；检查工具调用、流式输出、图片输入、thinking 参数、token 用量字段的映射。
- 验收：用 Gemini 跑一个包含多次工具调用（读文件 + 编辑 + 运行命令）的任务；用量统计正确。

### T2.4 cc-switch / Codex / Claude Code 配置导入
- 依赖：T2.1
- 做法：
  - 先调研 cc-switch 实际写入的文件和字段（参考其仓库 `farion1231/cc-switch` 文档与源码），写到 `docs/cc-switch.md`。
  - 实现 `comecode import codex`：读取 `~/.codex/config.toml`（`model`、`model_provider`、`[model_providers.*]` 中的 `base_url`、`env_key`、`wire_api`）和 `~/.codex/auth.json`。
  - 实现 `comecode import claude`：读取 `~/.claude/settings.json` 中 `env` 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 等字段。
  - 可选：配置 `follow = "codex"` 表示每次启动都实时读取，这样 cc-switch 切换后重开终端即生效。
- 验收：用样例配置文件做单测；本机装了 cc-switch 的话实测切换生效。

### T2.5 内置 Provider 目录本地化
- 依赖：T1.4
- 位置：`engine/config/provider/zcode-builtin.json`
- 做法：复制为 `comecode-builtin.json`；删除 z.ai 专属的 Coding Plan 和网关条目（或标注为可选）；补充 Gemini、OpenAI 兼容通用模板；核对各家 base_url 与模型名是否是当前可用的。
- 验收：`comecode config providers` 能列出内置模板；每个模板都有单测校验字段合法。

---

## M3 长期记忆与缓存（V0.3）

### T3.0 调研：现有记忆与压缩机制（只读，产出文档）
- 依赖：T0.1
- 位置：`CLI/core/src/memory/`、`CLI/core/src/compact/`、`CLI/core/src/agent/compact-session.ts`、`CLI/core/src/context/builder.ts`、`CLI/adapters/src/context/index.ts`
- 交付：`docs/memory-internals.md`，说明记忆何时提取、存在哪里、如何召回、压缩的触发阈值和输出格式、系统提示词的分块与 cache breakpoint 位置。T3.1~T3.5 以它为输入。

### T3.1 加载 `.ai/` 项目记忆
- 依赖：T3.0
- 做法：
  - 启动时从 git 根目录（没有 git 则用 cwd）找 `.ai/`，按固定顺序加载 `project.md` → `decisions.md` → `tasks.md` → `bugs.md` → `memory.md`，放进系统提示词的稳定区（位于项目规则之后）。
  - 每个文件和总量都有大小上限（可配置），超出时截断并提示用户运行 `/memory compact`。
  - 新增 `/init-memory`（或扩展 `/init`）：生成 `.ai/` 模板，并把 `.ai/.local/` 加入 `.gitignore`。
  - 会话内加载一次后冻结，不随文件修改刷新（保证 cache 命中），压缩或新会话时刷新。
- 验收：单测覆盖加载顺序、截断、没有 `.ai/` 的情况；实测问 AI 项目信息时能引用 `.ai/project.md` 的内容。

### T3.2 记忆写入：压缩与会话结束时沉淀到 `.ai/`
- 依赖：T3.1
- 做法：
  - 复用现有记忆提取 Agent，把输出目标从用户目录改成 `.ai/`：决定追加到 `decisions.md`，任务更新 `tasks.md`，问题更新 `bugs.md`，摘要按日期追加到 `memory.md`。
  - 触发时机：自动压缩后、`/memory save`、会话正常退出时（可配置关闭）。
  - 写入走标准 Edit 流程，遵循权限模式；非 yolo 模式下 TUI 显示 diff 并确认。
  - `memory.md` 超过上限时，对最旧的部分再做一次摘要（滚动压缩）。
  - 保留原有的用户级记忆作为可选项（配置 `memory.scope = "project" | "user" | "both"`）。
- 验收：跑一个长会话触发压缩，检查 `.ai/` 文件内容合理且没有重复；单测覆盖追加和滚动压缩逻辑。

### T3.3 兼容 CLAUDE.md 等规则文件
- 依赖：T3.0
- 位置：`CLI/adapters/src/context/index.ts`（AGENTS.md 加载逻辑）
- 做法：在 AGENTS.md 的查找逻辑中加入 `CLAUDE.md`、`.comecode/AGENTS.md`，同一目录多个文件同时存在时按固定顺序合并并去重；用户级规则文件 `~/.comecode/AGENTS.md`。
- 验收：单测覆盖各种文件组合。

### T3.4 Prompt Cache 前缀稳定性
- 依赖：T3.0
- 位置：`CLI/core/src/context/builder.ts`、`CLI/core/src/runtime/helpers/provider-request-messages.ts`、`CLI/core/src/tool/registry.ts`
- 做法：
  - 写一个测试工具：同一会话连续发送 N 轮，对比每轮请求体中"第一个 cache breakpoint 之前"的字节是否完全一致；把它加进单测。
  - 按测试结果修复不稳定的来源：工具定义按名称排序、schema 序列化键顺序固定、时间/git 状态等动态信息移出稳定区、MCP 工具变化延后生效。
  - 对 OpenAI 兼容接口：传 `prompt_cache_key`（取会话 id，参考 `codex/codex-rs/core/src/client.rs` 的做法）。
- 验收：测试证明 10 轮对话稳定前缀字节完全相同。

### T3.5 缓存命中统计
- 依赖：T3.4
- 做法：从各 Provider 的 usage 中读取缓存 token（Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`，OpenAI `prompt_tokens_details.cached_tokens`，DeepSeek `prompt_cache_hit_tokens`，Gemini `cachedContentTokenCount`），统一成 `{input, cached, output}`；TUI 状态栏显示本会话命中率；写入会话记录，供 Web 后台展示。
- 验收：单测覆盖各家字段映射；在至少两家模型上实测数值合理。

### T3.7 目标模式（/goal）加固
- 依赖：T3.0
- 位置：`CLI/cli/src/command-center/handlers/goal.ts`、`CLI/core/src/runtime/methods/target.ts`（已有续跑、完成校验器、暂停/恢复、运行计时）
- 做法：
  - 先读懂现有实现，补文档到 `docs/memory-internals.md` 的"目标模式"一节。
  - 补预算：`/goal <目标> --max-turns 50 --max-tokens 2M --max-time 2h`，以及配置文件默认值；触达上限时暂停，而不是停止。
  - 无进展检测：连续 N 轮没有文件改动，且校验结果不变时暂停并提示。
  - 目标和当前进度写入永续会话的固定层（T3.8），压缩后不丢失。
  - 参考 `codex/codex-rs/tui/src/goal_*.rs`、`chatwidget/goal_*.rs` 的交互（状态栏显示预算、暂停原因）。
- 验收：用一个"让某个失败测试通过"的样例项目实测能自动迭代完成；预算用尽时正确暂停；单测覆盖预算和无进展判断。

### T3.8 永续会话：分层滚动压缩
- 依赖：T3.0、T3.1
- 位置：`CLI/core/src/compact/`（policy、rounds、prompt）、`CLI/core/src/agent/compact-session.ts`
- 做法：
  - 上下文分四层：固定层（系统提示词、规则、`.ai/` 快照、当前目标与 todo，永不压缩）、近期层（最近 K 轮原文）、摘要层（滚动摘要）、归档层（原文落盘到 `.ai/.local/archive/`）。
  - 压缩只处理"摘要层 + 最老的近期轮次"，固定层原样保留；摘要超过预算时，把多段摘要再合并一次（分代合并，避免每次都重写全部摘要）。
  - 压缩前先触发 T3.2 的记忆沉淀，保证决定、任务、问题不会只存在于摘要里。
  - 新增 `RecallArchive` 工具：按关键词或时间段检索归档原文（可以先用 ripgrep，后续再考虑向量检索）。
  - 压缩后 cache 前缀只在固定层之后变化，保持命中（和 T3.4 联动）。
- 验收：写一个压力测试，模拟 20 次以上的连续压缩：固定层内容逐字不变；上下文 token 始终低于阈值；早期一条关键决定能通过 `.ai/decisions.md` 或 `RecallArchive` 找回。

### T3.6（可选）Codex 风格 apply_patch 工具
- 依赖：T0.1
- 做法：参考 `codex/codex-rs/apply-patch/src/`（parser、seek_sequence 模糊匹配）和 `codex/codex-rs/core/assets/tools/apply_patch.lark` 用 TS 实现；作为 JSON 字符串参数工具提供（非 OpenAI 模型不支持 Lark freeform 工具）；通过配置按模型启用。注意 Apache-2.0 署名。
- 验收：移植 Codex 的 apply_patch 测试用例并全部通过。

---

## M4 Web 管理后台（V0.4）

技术选型建议：新建 `CLI/admin-server`（Hono，复用 ZCode server 的依赖版本）和 `CLI/admin-web`（Vite + React + Tailwind，只做管理，不依赖 `@zcode/ui`）。构建时把 admin-web 的静态文件打包进 CLI 产物。

### T4.1 CLI 内嵌 HTTP server
- 依赖：T1.1
- 做法：
  - TUI 启动时在同一进程启动 server，监听 `127.0.0.1`，端口默认 `4545`，被占用时自动 +1；启动时生成随机 token，终端打印 `http://127.0.0.1:4545/?token=...`。
  - 参数：`--web`（自动打开浏览器）、`--no-web`、`--web-port`；无头 `--prompt` 模式默认不启动。
  - 多个 comecode 实例：第一个启动的实例作为 Hub，后启动的实例向它注册（通过 `~/.comecode/hub.json` 记录端口和 token），这样一个页面能看到所有项目的会话。V0.4 可以先只支持单实例，Hub 放到 T4.9。
  - 所有 API 校验 token；拒绝非本机 Origin，防止 CSRF。
- 验收：启动后浏览器能访问；不带 token 返回 401；集成测试覆盖。

### T4.2 事件总线与状态 API
- 依赖：T4.1、T3.0
- 做法：订阅 runtime 已有的事件（turn 开始/结束、工具调用开始/结束、用量、压缩、错误），通过 WebSocket `/ws` 推送；定义事件的 zod schema，放到 `CLI/contracts`。REST 接口：`GET /api/status`、`GET /api/sessions`、`GET /api/sessions/:id`、`GET/PUT /api/config`、`GET/PUT /api/memory/:file`、`GET /api/logs`。
- 验收：接口有单测；事件 schema 有文档。

### T4.3 前端骨架
- 依赖：T4.2
- 做法：路由、布局、token 处理（从 URL 读取后存到 sessionStorage 并清理地址栏）、WebSocket 断线重连、中英文 i18n 框架；构建产物接入 CLI 的打包脚本。
- 验收：`comecode` 启动后浏览器能打开空的后台页面并显示已连接。

### T4.4 配置页
- 依赖：T4.3、T2.1
- 内容：Provider 列表与增删改（写回 `config.toml`，保留注释和格式）、"测试连接"按钮（发一个最小请求）、默认模型选择、API Key 脱敏显示。

### T4.5 会话页
- 依赖：T4.3
- 内容：按项目分组的会话列表（运行中 / 空闲 / 已结束）、会话详情（消息、工具调用时间线、用量）、复制 `comecode --resume <id>` 命令。

### T4.6 记忆页
- 依赖：T4.3、T3.1
- 内容：`.ai/` 文件列表、Markdown 预览与编辑、保存前显示 diff；编辑后提示"下个会话生效"。

### T4.7 Agent 状态页
- 依赖：T4.3
- 内容：当前目标与预算消耗（T3.7）、上下文各层 token 占比与压缩次数（T3.8）、当前正在执行的工具和参数摘要（正在读取 xxx、正在执行测试、修改 xxx.py）、本会话 token 用量和 cache 命中率曲线、权限确认请求的只读展示（确认仍在终端完成）。

### T4.8 日志页
- 依赖：T4.3
- 内容：运行日志的实时滚动与级别筛选；模型请求/响应记录（复用 ZCode 的 trajectory 记录能力），敏感字段脱敏。

### T4.9（可选）多实例 Hub
- 依赖：T4.5
- 内容：见 T4.1 的说明。

各页面验收：Playwright 冒烟测试（能打开、有数据、关键操作成功）；深色/浅色主题；键盘可操作。

---

## M5 开源发布（V0.5）

### T5.1 npm 包发布
- 依赖：M2 完成
- 做法：
  - 先确认 npm 上 `comecode` 包名是否可用，不可用时用 `@comecode/cli`。
  - 打包方案：主包是 esbuild 单文件 CJS，原生依赖（ripgrep、OpenTUI、koffi）按平台拆成 `optionalDependencies` 子包（参考 `codex/codex-cli` 和 esbuild 的做法）。
  - 设置 `engines.node`（确认最低支持版本，node:sqlite 需要 22.5 以上）。
- 验收：在干净的 Windows / macOS / Linux 上 `npm i -g` 后能运行。

### T5.2 安装脚本
- 内容：`install.sh`、`install.ps1`（检测 Node 版本，没有则提示），`comecode doctor` 检查环境。

### T5.3 文档
- 内容：快速开始、配置参考、Provider 接入示例（NewAPI / DeepSeek / GLM / Qwen / Gemini）、记忆系统说明、Web 后台说明、贡献指南；中英文。

### T5.4 Docker
- 内容：参考 `engine/harness/remote/Dockerfile`；提供镜像，挂载项目目录运行，Web 端口映射；文档说明容器内的安全边界。

### T5.5 CI 与发布流程
- 内容：GitHub Actions 三平台构建和测试、tag 触发 npm 发布、CHANGELOG。

### T5.6 许可证合规
- 内容：`LICENSE`（Apache-2.0）、`NOTICE` 中写明派生自 ZCode 与 Codex、检查 `THIRD-PARTY-NOTICES.md` 是否需要更新；确认产品名、Logo 不使用上游商标。

### T5.7 插件机制说明
- 内容：ZCode 已有 plugins/skills/MCP 机制，本任务只做梳理和文档，关闭默认的远程插件市场，支持从本地目录或 git 地址安装。

---

## 2. 委派模板

委派时复制下面的内容，把 `<>` 替换掉：

```
你在 E:\Projects\ComeCode\ZCode（ComeCode 项目，基于 ZCode fork）上工作。
先阅读：README.md、docs/PLAN.md 的「0. 全局约定」和任务 <Tx.y>。
前置任务的产出：<链接或说明>。
任务：<Tx.y 标题>
要求：只做本任务范围内的改动；按验收标准自测；最后汇报改动文件、验证方式、遗留风险。
```

## 3. 待确认事项

- npm 包名 `comecode` 是否可用（T5.1 之前确认）。
- Web 后台是否需要支持从浏览器发起对话（目前的设计是不支持，只做管理）。
- 记忆写入是否默认需要用户确认（目前的设计是跟随权限模式）。
- 是否保留 ZCode 的 desktop 应用（目前的设计是不维护）。

## 2026-10-01：统一配置易用性补充

- 支持公开 JSON/JSONC 配置，兼容 TOML 和旧 Provider JSON；单供应商下模型可覆盖协议、地址、凭据、显示名、窗口与能力。
- 首次交互启动直接填写必要信息，自动保存 JSON 后继续，不展示文件兼容细节、不要求退出编辑。
- 多模型实际默认选择及 CLI 切换验收；显式窗口保留。
- Web 多模型编辑仍属后续后台任务，本次不实现。
