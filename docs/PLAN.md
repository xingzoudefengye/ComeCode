# ComeCode 实施计划与任务拆分

本文用于把工作委派给其他 Agent。每个任务都是独立可交付的单元，包含：目标、依赖、涉及位置、做法要点、验收标准。

路径约定：`engine/` 指 ComeCode 仓库中通过 git subtree 导入的 ZCode 代码，`CLI/` 指 `engine/apps/zcode-cli/packages/`，`codex/` 指仓库外的 Codex 参考克隆（`E:\Projects\ComeCode\codex`，已被 .gitignore 忽略）。

---

## 0. 全局约定（每个任务都要遵守，委派时附上本节）

1. 开发仓库：ComeCode 仓库（`origin` = github.com/xingzoudefengye/ComeCode），`main` 为主分支，功能在 `feat/<任务号>` 分支开发后合并。ZCode 代码在 `engine/`，同步上游时另开 `upstream-sync` 分支执行 `git subtree pull --prefix=engine upstream-zcode main`，解决冲突后再合回 `main`。`codex/` 只作参考，不改、不入库。
2. 改名分层，控制和上游的差异：
   - 必须改：npm 包名与对外 `bin`、数据目录（`~/.comecode`）、用户可见文案、系统提示词中的产品身份，以及所有「操作/打包」资产——桌面 `productName`、electron-builder 配置与产物名、安装器脚本、Docker 镜像与 CI 文件名，一律用 `comecode`，不沿用 `zcode` 命名。
   - 不改：内部 `@zcode/*` 包 scope、源码标识符、目录名。避免上万处无意义 diff，导致无法合并上游；改名后的外部资产在 `upstream-sync` 冲突清单里单独维护。
   - 环境变量：新增 `COMECODE_*`，读取时回退到对应的 `ZCODE_*`，旧变量不删。
3. 改动集中在 `CLI/adapters`、`CLI/bootstrap`、`CLI/cli` 和新增包；`CLI/core` 尽量只加扩展点，不改内部逻辑。
4. 不动 `packages/web`、`packages/ui`，也不让 ComeCode 的构建依赖它们；`packages/desktop` 只在 M6 的认可范围内改动（品牌去耦、复用 CLI Agent、会话共享、打包改名），不顺手重构整块 desktop。
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
                                 └─ T2.4 cc-switch 导入
                        └─ M3 记忆与缓存（与 M4 可并行）
                            T3.1 .ai/ 加载 ─ T3.2 记忆写入 ─ T3.3 CLAUDE.md 兼容
                            T3.4 缓存稳定性 ─ T3.5 缓存统计
                        └─ M4 Web 后台（与 M3 可并行）
                            T4.1 内嵌 server ─ T4.2 事件总线 ─ T4.3 前端骨架
                            ─ T4.4~T4.8 各页面
                                 └─ M5 发布
                                     T5.1 npm 包 ─ T5.2 安装脚本 ─ T5.3 文档 ─ T5.4 Docker
                                     ─ T5.5 CI 与自动打包 ─ T5.8 多渠道发布 ─ T5.9 插件安装 CLI
                                         └─ M6 桌面版（复用 CLI Agent，见 M5 发布依赖）
                                             T6.1 品牌与去耦 ─ T6.2 复用 CLI Agent
                                             ─ T6.3 与 Web 后台打通 ─ T6.4 打包与自动更新
                                         └─ M7 插件与 harness 自由度（可与 M6 并行）
                                             T7.1 加载与安装 ─ T7.2 自定义工具
                                             ─ T7.3 自定义策略/循环 ─ T7.4 Provider 适配器扩展
```

可并行的组合：T2.2/T2.4 互不依赖；M3 与 M4 互不依赖；T4.4~T4.8 互不依赖；M6 与 M7 互不依赖（M6 复用 CLI Agent，M7 只扩展点）。

## 当前实现状态（2026-10-01）

| 里程碑 | 当前状态 | 证据 / 说明 |
| --- | --- | --- |
| M0 基线 | 部分完成 | CLI 可构建、可运行、可执行完整测试；T0.2 上游同步文档仍未完成。 |
| M1 品牌与去耦 | 已完成 | ComeCode 命令、数据目录、登录去耦、默认外连关闭均已提交并通过回归验证。 |
| M2 Provider | 核心已完成 | 统一配置、标准环境变量、三种协议、配置导入已完成；Gemini 原生执行和内置目录本地化不纳入 ComeCode 计划。 |
| M3 记忆与缓存 | 部分完成 | 512K 上下文、缓存统计、压缩后短上下文、压缩干活指南、工作区 `.ai/` 基础加载和显式保存已完成；不新增压缩原文归档或用户检索入口；`memory.md` 滚动摘要等剩余边界见 T3.2。 |
| M4 Web 后台 | 部分完成 | 本地管理页、Provider/模型列表、编辑、归类、连接测试已完成；会话、记忆、状态、日志页面仍未完成。 |
| M5 发布 | 未开始 | npm、安装脚本、Docker、CI 和发布流程尚未进入实现；仓库尚无 `.github/`，自动打包与多渠道发布待补。 |
| M6 桌面版 | 未开始 | 现有 `@zcode/desktop` 是完整 Electron 应用，但被本规划「不维护」排除；需翻转为专用里程碑，改造为 ComeCode Desktop 并复用 CLI Agent。 |
| M7 插件/harness 自由度 | 未开始 | ZCode 已有 plugins/skills/MCP 机制；本规划只留了「写文档」的 T5.7，需升级为实际扩展能力里程碑（自定义工具、策略、Provider 适配器）。 |

---

## M0 基线

### T0.1 本地构建并跑通 ZCode CLI
- 依赖：无
- 位置：`engine/`、`engine/apps/zcode-cli`
- 做法：
  - 用 mise 或 nvm 安装指定的 Node/pnpm 版本；运行 `pnpm install`，然后 `pnpm --dir apps/zcode-cli build`。
  - 如果构建依赖了 desktop 资源准备步骤，找出最小构建路径（只需要 CLI 和它依赖的 `packages/provider`、`provider-node`、`shared`、`model-option-map`）。
  - 配置一个 OpenAI 兼容的个人 Provider（当前使用 `~/.comecode` 配置目录），跑一次 `--prompt` 无头模式和一次 TUI 对话。
- 交付：`docs/dev-setup.md`，记录 Windows 下的构建步骤、踩到的坑（原生模块 koffi、node:sqlite、ripgrep、OpenTUI）和解决方法。
- 验收：在 Windows 上按文档从零构建成功；`node .../dist/zcode.cjs --prompt "列出当前目录文件"` 能返回结果。

### T0.2 上游同步流程
- 依赖：T0.1
- 做法：添加 `upstream` remote；写 `docs/upstream-sync.md`，说明合并步骤和容易冲突的文件清单；可选写一个脚本，统计与上游的 diff 规模。
- 验收：演示一次从 upstream 合并（可以用当前 HEAD 做空合并）。

---

## M1 品牌与去耦（V0.1）

2026-10-01：M1 已完成并已提交。T1.1~T1.4 已通过 CLI 回归测试、相关 typecheck、CLI 构建和 `comecode --help` 验证。历史超长文件 lint 规则仍作为遗留项单独处理。

### T1.1 对外命令与包名改为 comecode
- 依赖：T0.1
- 位置：`CLI/cli/package.json`（bin `zcode` → `comecode`）、`CLI/cli/scripts/build.mjs`（产物名）、`--help`/版本输出、TUI 标题与欢迎语、系统提示词中的产品身份（在 `CLI/core` 的 prompt 相关文件中搜索 "ZCode"）。
- 做法：用户可见字符串集中到一个常量（如 `PRODUCT_NAME`），不做全局替换。
- 验收：`comecode --help`、TUI 界面、问 AI "你是谁" 均显示 ComeCode；`git diff --stat` 控制在几十个文件以内。

### T1.2 数据目录与环境变量前缀
- 依赖：T1.1
- 位置：`CLI/cli/src/provider-runtime-env.ts`、`CLI/adapters/src/config/env-config.adapter.ts`、`~/.comecode` 相关路径；保留 `ZCODE_*` 兼容读取。
- 做法：
  - 默认数据目录改为 `~/.comecode`；`COMECODE_DATA_BASE_DIR` 优先，回退 `ZCODE_DATA_BASE_DIR`。
  - 环境变量读取加一层映射：读 `COMECODE_X`，没有则读 `ZCODE_X`。
  - 旧 `~/.zcode` 数据只作为兼容来源，不自动覆盖或迁移；显式导入时提示用户确认。
- 验收：单测覆盖变量回退逻辑；新环境下启动只创建 `~/.comecode`。

### T1.3 去掉强制登录
- 依赖：T1.1
- 位置：`CLI/adapters/src/auth/cli-oauth.ts`、`login`/`logout` 子命令、启动时的鉴权检查。
- 做法：只要配置了任意可执行 Provider，就不要求登录；没有配置时进入中文 Provider 配置引导。`login` 命令保留内部兼容但不作为公开首选。
- 验收：在没有历史配置的全新环境，只设置标准环境变量或 ComeCode 配置即可完成一次对话，全程不访问 `zcode.z.ai`。

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

### T2.1 统一 Provider 配置系统（JSON/JSONC 主格式，兼容 TOML；已完成，2026-10-01）
- 依赖：T1.2
- 实现：`CLI/adapters/src/config/provider-config.ts`，在 CLI 边界转换为兼容的 `provider_config.json`，不改 Provider Registry 和内部协议。
- 已完成：用户级/项目级配置发现、最小 TOML 子集、标准环境变量归一化、CLI 覆盖、`config path|show|check`、API Key 脱敏、OpenAI/Anthropic type 映射，以及 Gemini 仅检查不执行。
- 验证：统一配置单测覆盖解析、合并优先级、环境变量、脱敏、兼容 materialize；Gemini 原生适配已取消，配置导入已在 T2.4 完成，Web 后台留给 M4。

2026-10-01 首次使用体验修复：无模型首屏中文操作卡片、`comecode config setup` 向导、带注释模板、密钥隐藏与覆盖备份；规则和验收见 [首次模型配置引导](specs/PROVIDER-ONBOARDING.md)。

### T2.2 标准环境变量零配置启动（已完成，2026-10-01）
- 依赖：T2.1
- 已完成：无统一配置文件时按 OpenAI → Anthropic → Gemini 探测非空凭据；固定默认模型；`COMECODE_PROVIDER` 选择；CLI 覆盖；stderr 启动说明；只读配置命令不写盘。
- OpenAI 环境 Provider 保持 openai-chat；Anthropic API Key 优先于 Auth Token；Gemini 仅检查不执行，原生执行不纳入 ComeCode 计划。
- 规则与边界见 [T2.2](specs/T2.2.md)。继续复用现有 JSON materialize 路径，不重做 Registry 或持久化机制。
- 验证：配置组合、旧 JSON/TOML 兼容测试与真实 CLI 子进程 + 本地 HTTP mock 完整对话；检查默认模型、鉴权、JSON stdout 和 stderr 脱敏。


### T2.4 cc-switch / Codex / Claude Code 配置导入（已完成，2026-10-01）
- 状态：已完成（2026-10-01）。实现 `comecode import codex|claude` 与 `comecode --import codex|claude`，支持本地配置映射、幂等追加、迁移备份和密钥脱敏；详见 [cc-switch 兼容说明](cc-switch.md)。
- 依赖：T2.1
- 做法：
  - 先调研 cc-switch 实际写入的文件和字段（参考其仓库 `farion1231/cc-switch` 文档与源码），写到 `docs/cc-switch.md`。
  - 实现 `comecode import codex`：读取 `~/.codex/config.toml`（`model`、`model_provider`、`[model_providers.*]` 中的 `base_url`、`env_key`、`wire_api`）和 `~/.codex/auth.json`。
  - 实现 `comecode import claude`：读取 `~/.claude/settings.json` 中 `env` 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 等字段。
  - 可选：配置 `follow = "codex"` 表示每次启动都实时读取，这样 cc-switch 切换后重开终端即生效。
- 验收：用样例配置文件做单测；本机装了 cc-switch 的话实测切换生效。


---

## M3 长期记忆与缓存（V0.3）

### T3.0 调研：现有记忆与压缩机制（已完成，2026-10-01）
- 依赖：T0.1
- 位置：`CLI/core/src/memory/`、`CLI/core/src/compact/`、`CLI/core/src/agent/compact-session.ts`、`CLI/core/src/context/builder.ts`、`CLI/adapters/src/context/index.ts`
- 交付：`docs/memory-internals.md`，说明当前记忆何时提取、存在哪里、压缩触发阈值和输出格式，以及内部记忆边界。T3.1~T3.5 以它为输入。

### T3.1 加载 `.ai/` 项目记忆（基础能力已完成，2026-10-01）
- 依赖：T3.0
- 做法：
  - 启动时从 git 根目录（没有 git 则用 cwd）找 `.ai/`，按固定顺序加载 `project.md` → `decisions.md` → `tasks.md` → `bugs.md` → `memory.md`，放进系统提示词的稳定区（位于项目规则之后）。
  - 每个文件和总量都有大小上限，超出时截断并提示用户运行 `comecode memory check`。
  - 新增 `comecode memory init`：生成 `.ai/` 模板，并把 `.ai/.local/` 加入 `.gitignore`。
  - 会话内加载一次后冻结，不随文件修改刷新（保证 cache 命中），压缩或新会话时刷新。
- 验收：单测覆盖加载顺序、截断、没有 `.ai/` 的情况；实测问 AI 项目信息时能引用 `.ai/project.md` 的内容。

> 2026-10-01 实现：ComeCode 默认从工作区 `.ai/` 按固定顺序加载五类文件，固定快照进入稳定 system section；新增 `comecode memory init/path/check`，并加入大小限制与 `.ai/.local/` 忽略规则。
### T3.2 记忆写入：压缩与会话结束时沉淀到 `.ai/`（部分完成）

> 当前已完成：自动提取 scheduler、显式 `/memory save`、会话关闭时 drain、固定 `.ai/` 文件写入提示、压缩前强制沉淀、`memory.md` 滚动摘要和 `memory.scope` 配置。
> 压缩后的摘要和干活指南由程序内部自动携带；用户不需要执行检索或管理压缩归档。
- 依赖：T3.1
- 做法：
  - 复用现有记忆提取 Agent，把输出目标从用户目录改成 `.ai/`：决定追加到 `decisions.md`，任务更新 `tasks.md`，问题更新 `bugs.md`，摘要按日期追加到 `memory.md`。
  - 触发时机：自动压缩后、`/memory save`、会话正常退出时（可配置关闭）。
  - 写入走标准 Edit 流程，遵循权限模式；非 yolo 模式下 TUI 显示 diff 并确认。
  - `memory.md` 超过上限时，对最旧的部分再做一次摘要（滚动压缩）。
  - 保留原有的用户级记忆作为可选项（配置 `memory.scope = "project" | "user" | "both"`）。
- 验收：跑一个长会话触发压缩，检查 `.ai/` 文件内容合理且没有重复；单测覆盖追加和滚动压缩逻辑。

### T3.3 兼容 CLAUDE.md 等规则文件（已完成，2026-10-01）
- 依赖：T3.0
- 位置：`CLI/adapters/src/context/index.ts`（AGENTS.md 加载逻辑）
- 做法：在 AGENTS.md 的查找逻辑中加入 `CLAUDE.md`、`.comecode/AGENTS.md`，同一目录多个文件同时存在时按固定顺序合并并去重；用户级规则文件 `~/.comecode/AGENTS.md`。
- 验证：规则来源适配器测试覆盖用户级、项目级、同层合并和重复路径去重。
- 验收：单测覆盖各种文件组合。

### T3.4 Prompt Cache 前缀稳定性（已完成，2026-10-01）
- 依赖：T3.0
- 位置：`CLI/core/src/context/builder.ts`、`CLI/core/src/runtime/helpers/provider-request-messages.ts`、`CLI/core/src/tool/registry.ts`
- 做法：
  - 写一个测试工具：同一会话连续发送 N 轮，对比每轮请求体中"第一个 cache breakpoint 之前"的字节是否完全一致；把它加进单测。
  - 按测试结果修复不稳定的来源：工具定义按名称排序、schema 序列化键顺序固定、时间/git 状态等动态信息移出稳定区、MCP 工具变化延后生效。
  - 对 OpenAI 兼容接口：传 `prompt_cache_key`（取会话 id，参考 `codex/codex-rs/core/src/client.rs` 的做法）。
- 验收：测试证明 10 轮对话稳定前缀字节完全相同。

### T3.5 缓存命中统计（已完成，2026-10-01）
- 依赖：T3.4
- 做法：从各 Provider 的 usage 中读取缓存 token（Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`，OpenAI `prompt_tokens_details.cached_tokens`，DeepSeek `prompt_cache_hit_tokens`，Gemini `cachedContentTokenCount`），统一成 `{input, cached, output}`；TUI 状态栏显示本会话命中率；写入会话记录，供 Web 后台展示。
- 验收：单测覆盖各家字段映射；在至少两家模型上实测数值合理。



### T3.6（可选）Codex 风格 apply_patch 工具
- 依赖：T0.1
- 做法：参考 `codex/codex-rs/apply-patch/src/`（parser、seek_sequence 模糊匹配）和 `codex/codex-rs/core/assets/tools/apply_patch.lark` 用 TS 实现；作为 JSON 字符串参数工具提供（非 OpenAI 模型不支持 Lark freeform 工具）；通过配置按模型启用。注意 Apache-2.0 署名。
- 验收：移植 Codex 的 apply_patch 测试用例并全部通过。

---

## M4 Web 管理后台（V0.4）

2026-10-01：已实现本地管理 server、Provider/模型配置页、同地址供应商归类、模型编辑、连接测试和 API Key 脱敏；会话页、记忆页、状态页、日志页仍属于后续任务。

> 现有实现使用 CLI 内置轻量 server + 内嵌静态资源；原先 Hono/Vite 的技术选型只是建议，不再作为必须的新建目录约束，后续页面应优先扩展现有 admin 实现。

### T4.1 CLI 内嵌 HTTP server（已完成，2026-10-01）
- 依赖：T1.1
- 做法：
  - TUI 启动时在同一进程启动 server，监听 `127.0.0.1`，端口默认 `4545`，被占用时自动 +1；启动时生成随机 token，终端打印 `http://127.0.0.1:4545/?token=...`。
  - 参数：`--web`（自动打开浏览器）、`--no-web`、`--web-port`；无头 `--prompt` 模式默认不启动。
  - 多个 comecode 实例：第一个启动的实例作为 Hub，后启动的实例向它注册（通过 `~/.comecode/hub.json` 记录端口和 token），这样一个页面能看到所有项目的会话。V0.4 可以先只支持单实例，Hub 放到 T4.9。
  - 所有 API 校验 token；拒绝非本机 Origin，防止 CSRF。
- 验收：启动后浏览器能访问；不带 token 返回 401；集成测试覆盖。

### T4.2 事件总线与状态 API（部分完成）
- 依赖：T4.1、T3.0
- 做法：订阅 runtime 已有的事件（turn 开始/结束、工具调用开始/结束、用量、压缩、错误），通过 WebSocket `/ws` 推送；定义事件的 zod schema，放到 `CLI/contracts`。REST 接口：`GET /api/status`、`GET /api/sessions`、`GET /api/sessions/:id`、`GET/PUT /api/config`、`GET/PUT /api/memory/:file`、`GET /api/logs`。
- 验收：接口有单测；事件 schema 有文档。

### T4.3 前端骨架（基础页面已完成）
- 依赖：T4.2
- 做法：路由、布局、token 处理（从 URL 读取后存到 sessionStorage 并清理地址栏）、WebSocket 断线重连、中英文 i18n 框架；构建产物接入 CLI 的打包脚本。
- 验收：`comecode` 启动后浏览器能打开空的后台页面并显示已连接。

### T4.4 配置页（已完成，2026-10-01）
- 依赖：T4.3、T2.1
- 内容：Provider 列表与增删改（写回 `config.json`，兼容读取 TOML/JSONC，迁移需确认并备份）、"测试连接"按钮（发一个最小请求）、默认模型选择、API Key 脱敏显示。

### T4.5 会话页
- 依赖：T4.3
- 内容：按项目分组的会话列表（运行中 / 空闲 / 已结束）、会话详情（消息、工具调用时间线、用量）、复制 `comecode --resume <id>` 命令。

### T4.6 记忆页
- 依赖：T4.3、T3.1
- 内容：`.ai/` 文件列表、Markdown 预览与编辑、保存前显示 diff；编辑后提示"下个会话生效"。

### T4.7 Agent 状态页
- 依赖：T4.3
- 内容：当前目标状态、上下文使用与压缩次数、当前正在执行的工具和参数摘要（正在读取 xxx、正在执行测试、修改 xxx.py）、本会话 token 用量和 cache 命中率曲线、权限确认请求的只读展示（确认仍在终端完成）。

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

### T5.5 CI 与自动打包
- 依赖：T0.1、T5.1
- 内容：新增 `.github/workflows/ci.yml`（push/PR 触发）与 `release.yml`（tag 触发）：
  - ci：三平台（ubuntu / macos / windows）分别安装 Node 24 + pnpm，跑 `pnpm install`、CLI typecheck/lint、CLI 全量回归测试、`comecode --help` 冒烟。
  - release：三平台构建 CLI（SEA 单文件）与桌面（electron-builder，见 T6.4），生成 Checksums，把产物与 CHANGELOG 一并上传到 GitHub Release。
- 验收：推 tag 后 Actions 自动产出三平台 CLI + 桌面安装包并挂在 Release 页，人工可下载安装。

### T5.6 许可证合规
- 内容：`LICENSE`（Apache-2.0）、`NOTICE` 中写明派生自 ZCode 与 Codex、检查 `THIRD-PARTY-NOTICES.md` 是否需要更新；确认产品名、Logo 不使用上游商标。

### T5.8 多渠道发布
- 依赖：T5.5
- 内容：在 GitHub Release 之外，补充便于分发的渠道，供不同用户安装：
  - `install.sh` / `install.ps1`：检测 Node，调用 `npm i -g` 或下载对应平台 CLI 单文件（离 Node 也可用的 SEA 或独立二进制）。
  - 包管理器：`winget`（Windows）、`brew`（macOS）清单，指向 GitHub Release；Docker 镜像（T5.4）挂项目目录运行。
  - 桌面：electron-updater 自动更新指向同一 Release。
- 验收：在干净的 Windows / macOS / Linux 上，用至少两种方式（命令安装、包安装）各跑通一次 `comecode --help` 与桌面启动。

### T5.9 插件安装 CLI
- 依赖：M7 的 T7.1
- 内容：`comecode plugin add <local|git|registry>` / `list` / `remove`；默认关闭远程市场，仅支持本地目录或 git 地址安装；安装后校验目录约定并登记进配置。
- 验收：从本地目录与 git 地址各安装一个示例插件并能加载（配合 T7.1）。

### T5.10 自愿捐赠（不打扰用户）
- 依赖：T5.5、M1
- 原则：**自愿、不打扰**——不在 TUI 会话里弹窗、不拦截任何操作，不强制、不反复。
- 内容：
  - `comecode sponsor` 子命令：展示捐赠入口与一句说明，用户主动调用才显示。
  - `--version`/`--help` 输出里可放一行极简提示（可配置关闭）。
  - 捐赠信息写进 `README` 与项目主页；TUI 不主动展示。
  - 可配置项 `donation.remind = off`（默认 off，永不提示），避免打扰。
- 支付渠道（中美双通道，建议组合）：
  - **美/国际**：GitHub Sponsors（README 徽章，面向全球、抽成低、开发者为先）；可选 Ko-fi / Buy Me a Coffee（小额、无需公司资质）；不首选 Stripe/PayPal（Stripe 需要公司或受支持国家主体、PayPal 中国个人收款受限）。
  - **中国大陆**：爱发电（afdian.net，支持微信/支付宝、适合开源个人）、或 GitHub Sponsors 走支付宝通道；可选 B 站工房/公众号赞赏作为补充。
  - 落地方式：README 与 `comecode sponsor` 列出 GitHub Sponsors + 爱发电两个主入口，其余按需补充。
- 验收：`comecode sponsor` 输出去渠道链接且不触发外呼之外的副作用；无任何付费拦截；有配置开关可彻底关闭提示。

> T5.7（插件机制说明）已并入 M7，不再单列为纯文档任务，见 M7 依赖关系。

---

## M6 桌面版（V0.6）

目标：把现有 `@zcode/desktop`（Electron，已含 main/preload/renderer/scheduler、remote 远程开发、CUA 浏览器自动化、electron-builder 三平台配置）改造为 ComeCode Desktop，复用同一套 CLI Agent 能力，并与 CLI「会话共享」——做到「桌面像 Codex Desktop 一样可用，但不是一个独立 agent、也不是第二套 core」。

> 前置约定：M6 依赖 CLI Agent（M0~M3）与发布（M5）的产物，因此放到 M6 而不是更早；它与 M7 并行开展（M6 复用 CLI Agent，M7 只动扩展点，互不干扰）。改造时仍遵循 M6.2 的「复用」原则。**命名**：桌面的 `productName`、electron-builder 配置与产物名、安装器、目录一律用 `comecode`，不沿用 `zcode`（见全局约定第 2 条）。

### T6.0 桌面现状盘点
- 依赖：T0.1
- 做法：核对 `@zcode/desktop` 的构建入口、登录、遥测、外连（z.ai/CDN）、与 CLI/agent 的边界；列出要移除/改写/保留的三张清单。
- 交付：`docs/desktop-internals.md`。
- 验收：文档说清桌面版对上游的差异范围，改动只落在 M6 认可范围内，不顺手重构无关的 desktop 子模块。

### T6.1 品牌与去耦（完整 comecode 命名）
- 依赖：T6.0
- 做法：
  - 身份与文案：`productName`、窗口标题、用户可见文案、系统提示词身份、数据目录（对齐 `~/.comecode`）。
  - 打包资产改名：electron-builder 配置、产物命名（NSIS/dmg/AppImage 安装器文件名）、应用图标资源、更新 feed 路径，一律 `comecode`，不沿用 `zcode`。
  - 去耦：去掉强制登录、默认遥测与 z.ai/CDN 外连，规则对齐 M1 的 T1.3/T1.4。
- 验收：桌面启动即用，配置任一可执行 Provider 即可对话，全程不访问 z.ai/CDN；产物与配置以 `comecode` 命名；`git diff --stat` 受控、可回合上游。

### T6.2 复用 CLI Agent 作为执行内核（会话共享）
- 依赖：T6.1、M3
- 做法：
  - 桌面进程通过本地 RPC/子进程调用同一套 CLI agent（Provider 配置、`.ai/` 记忆、工具、权限模式、压缩），桌面只承担 UI 与文件/终端宿主；`@zcode/desktop` 现有 remote/CUA 等重能力保留并按需开关。
  - **会话共享**：CLI、桌面、Web 后台读写同一份会话与配置存储；桌面可恢复 CLI 的会话、CLI 可 `comecode --resume` 桌面建的会话，不出现两套记忆/状态分叉。
- 验收：桌面发起的一次完整对话（含工具调用、记忆写入、权限确认）在 CLI 侧等价复现；同一会话可跨 CLI/桌面/后台查看与恢复。

### T6.3 与 Web 管理后台打通
- 依赖：T6.2、M4
- 做法：桌面内嵌或复用 admin server/WS，把会话、Agent 状态、cache 命中率、日志直接呈现在桌面面板，接口与 CLI 的 admin API 一致。
- 验收：浏览器里看到的会话/状态在桌面内同样可见且一致。

### T6.4 桌面打包与自动更新
- 依赖：T6.1、T5.5
- 做法：electron-builder 三平台安装包（win NSIS / mac dmg / linux AppImage.deb），接 `release.yml` 自动上传，electron-updater 从同一 Release 拉取更新；暂不签名也可先出未签名包。
- 验收：推 tag 后三平台桌面包自动生成并能安装启动。

---

## M7 插件与 harness 自由度（V0.7，先小步开放）

目标：让 ComeCode 具备可扩展能力，但**先小步开放、不追求完整**。本里程碑只开放「插件加载 + 自定义工具」，命名/策略/Provider 等更深的 harness 自由度留到后续；默认关闭远程市场、保持简洁。ZCode 已有 plugins / skills / MCP 机制，本里程碑是把「仅文档」升级为「可落地的插件加载与自定义工具」，并以示例插件验收。

### T7.0 扩展点盘点
- 依赖：T0.1
- 做法：梳理 ZCode 现有 plugins、skills、MCP、tool registry 里哪些点已经可以被第三方覆盖、哪些需要新增开放接口；本里程碑只关注「插件发现/加载」与「工具注册」两点，其余只记录不实现。
- 交付：`docs/extensibility.md`（含插件目录约定、生命周期、权限边界，以及暂缓的能力清单）。
- 验收：文档能回答「第三方插件现在能做什么、不能做什么、安不安全」，并明确后续开放路线。

### T7.1 插件加载与安装
- 依赖：T7.0、T5.9
- 做法：实现本地目录 + git 地址的插件发现/加载、插件清单校验、失败的友好报错；默认关闭远程插件市场。
- 验收：从本地目录和 git 地址各加载一个空插件，能识别、能卸载，加载失败有明确提示。

### T7.2 自定义工具（本里程碑的交付核心）
- 依赖：T7.1
- 做法：插件声明式注册工具（schema + 实现 + 展示说明），复用 tool registry 的校验与权限链路；内置工具与插件工具统一排序以稳定 prompt cache 前缀（对齐 T3.4）。
- 验收：一个示例插件注册的自定义工具能在对话中启用、受权限模式约束，并出现在后台工具记录里。

### T7.3 自定义策略/循环（暂缓，后续再开）
- 依赖：T7.2
- 状态：本里程碑**不做**。等插件加载与自定义工具稳定后，再开放 turn 策略覆盖点（规划/执行/校验、重试、压缩、目标续跑预算）。届时默认仍用内置循环，插件未覆盖时不破坏默认行为。
- 验收：作为后续任务，不列入 V0.7 验收。

### T7.4 Provider 适配器扩展（暂缓，后续再开）
- 依赖：T7.2、M2
- 状态：本里程碑**不做**。后续开放插件注册新的 wire 协议/模型映射，沿用现有 Provider Registry 校验，不要求插件动 core。
- 验收：作为后续任务，不列入 V0.7 验收。

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

## 3. 已确认事项（2026-10-03）

- 桌面版（M6）：**要做**，目标类似 Codex Desktop。边界已定：保留 `@zcode/desktop` 的 remote/CUA 等重能力并按需开关、**复用 CLI Agent 并会话共享**（CLI/桌面/后台读写同一份会话与配置，可互相恢复）。
- 插件（M7）：**先小步开放**，本里程碑只做「插件加载 + 自定义工具」，策略/循环与 Provider 适配器留到后续。
- 命名：对外与操作资产（bin、数据目录、桌面 productName、electron-builder 配置与产物名、安装器、Docker、CI 文件）一律用 `comecode`，不沿用 `zcode`；内部 `@zcode/*` scope 与源码标识符保留以便同步上游。
- 捐赠（T5.10）：做，且为自愿、不打扰；中美双通道（GitHub Sponsors + 爱发电）。
- 仓库精简：已删除 `README.orig.md`，一次性验收 spec 已归档到 `docs/archive/`；`codex/`、`ZCode/` 参考克隆**保留**（对照阅读与移植用，不提交）。

## 4. 仍待确认

- npm 包名 `comecode` 是否可用（T5.1 之前确认）。
- Web 后台是否需要支持从浏览器发起对话（目前的设计是不支持，只做管理）。
- 记忆写入是否默认需要用户确认（目前的设计是跟随权限模式）。

## 5. 冗余精简（保持简洁可维护）

目标：在「基于上游改、便于同步」的前提下，减少仓库里失效或重复的资产。原则：可提交的内容才精简，参考克隆与个人文件只标记、不越权删除。

- 已完成：删除 `README.orig.md`（被 `README.md` 取代）；`docs/specs/` 里的一次性验收/状态记录（`CLI-RUNTIME-STATUS.md`、`CLI-OPTIMIZATION-VALIDATION.md`、`CACHE-LIVE-ACCEPTANCE.md`、`M1.md`、`M2.1.md`、`T2.4.md`）归档到 `docs/archive/`；行为规则 spec（`T2.2.md`、`PROVIDER-ONBOARDING.md`、`CLI-UI.md`、`ADMIN-CONFIG.md`、`CLI-CACHE-COMPACT.md`、`GUIDE-HISTORY-PRESENTATION.md`）保留原位。
- 保留：`codex/`、`ZCode/` 是被 .gitignore 忽略的参考克隆（不提交、占磁盘大），仅供对照阅读与移植引用，不删除。

## 2026-10-01：统一配置易用性补充

- 支持公开 JSON/JSONC 配置，兼容 TOML 和旧 Provider JSON；单供应商下模型可覆盖协议、地址、凭据、显示名、窗口与能力。
- 首次交互启动直接填写必要信息，自动保存 JSON 后继续，不展示文件兼容细节、不要求退出编辑。
- 多模型实际默认选择及 CLI 切换验收；显式窗口保留。
- Web 多模型编辑仍属后续后台任务，本次不实现。
