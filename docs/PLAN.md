# ComeCode 实施计划与任务拆分

本文是 ComeCode 的产品路线与任务清单，也用于把工作委派给其他 Agent。每个任务包含目标、依赖、涉及位置、做法要点和验收标准；「已有源码」「本地验证」「发布验收」分别记录，不把规划或上游能力当作已交付功能。

路径约定：`engine/` 指通过 git subtree 导入的 ZCode 代码，`CLI/` 指 `engine/apps/zcode-cli/packages/`；根目录 `codex/`、`ZCode/` 是被 `.gitignore` 忽略的参考克隆，只读、不提交。

---

## 0. 全局约定（每个任务都要遵守，委派时附上本节）

**最高产品原则（2026-10-04）：用户体验第一，使用方便第一，不增加使用门槛。** 适用于配置、交互、压缩、安装、桌面、插件和所有功能。优先合理默认、配置复用、自动处理、快速响应与低成本，把复杂度留在程序内部；全局模型/Key 配置一次，所有项目直接使用，不新增逐项目信任命令或重复审批。安全和可靠性优先内部无感实现，不能以加固为由自行增加用户步骤或破坏既有工作流。下方历史任务如与此原则冲突，以此原则及最新用户决定为准。

1. 开发仓库：ComeCode 仓库（`origin` = github.com/xingzoudefengye/ComeCode），`main` 为主分支，功能在 `feat/<任务号>` 分支开发后合并。ZCode 代码在 `engine/`，同步上游时另开 `upstream-sync` 分支执行 `git subtree pull --prefix=engine upstream-zcode main`，解决冲突后再合回 `main`。`codex/` 只作参考，不改、不入库。
2. 改名分层，控制和上游的差异：
   - 必须改：npm 包名与对外 `bin`、数据目录（`~/.comecode`）、用户可见文案、系统提示词中的产品身份，以及所有「操作/打包」资产——桌面 `productName`、electron-builder 配置与产物名、安装器脚本、Docker 镜像与 CI 文件名，一律用 `comecode`，不沿用 `zcode` 命名。
   - 安装脚本：`comecode-install.sh` / `comecode-install.ps1`；桌面打包配置 `comecode-electron-builder.*`；Docker 镜像/专用配置和 CI 工作流同样使用 `comecode` 前缀。内部 `dist/zcode.cjs` 等在发布任务中有计划地改名，不为文档改动做全仓替换。
   - 不改：内部 `@zcode/*` scope、源码标识符和源码目录；避免无意义全仓替换，改名后的外部资产纳入上游合并冲突清单。
   - 环境变量：新增 `COMECODE_*`，读取时回退到对应的 `ZCODE_*`，旧变量不删。
3. 改动集中在 `CLI/adapters`、`CLI/bootstrap`、`CLI/cli` 和新增包；`CLI/core` 尽量只加扩展点，不改内部逻辑。
4. CLI 不依赖完整 `packages/web` 工作台。M6 可修改 `packages/desktop` 及其必要的 `packages/ui`、`packages/services`、`packages/client`、共享协议，限于品牌去耦、复用 CLI Agent、会话共享与桌面核心交互，不重写整个前端或另建一套 Agent。
5. 开发版本以 `engine/mise.toml`、`engine/package.json` 为准（当前 Node 24.14.0、pnpm 10.33.2）。代码任务完成后运行相关包检查、单测及 `comecode --help` 冒烟；纯文档改动验证差异、链接与任务依赖，不为文档重建整仓库。
6. 从 `codex/` 复制的文本或移植的代码：文件头注明来源和 "Modified by ComeCode"，并在 `NOTICE` 中登记。
7. 每个任务单独提交一个 PR，PR 描述写清：改了什么、如何验证、已知风险。

---

## 1. 依赖关系与交付顺序

```text
M0 基线 → M1 品牌去耦 → M2 Provider
                         ├─ M3 记忆、缓存、全调用预算
                         ├─ M4 轻量管理后台
                         └─ M5 CLI 测试与发布（先 npm + GitHub Release）
M0~M3 → M6 桌面盘点、共享会话、核心交互
M2 + T7.0 → T7.1 加载 → T7.2 自定义工具 → T5.9 安装命令
T5.5 CLI 发布基础 + M6 功能验收 → T6.4 桌面打包 → T5.8 分发扩展
```

- 桌面研发不等待 Docker、全部后台页面或插件完成；CLI 发布也不等待桌面包。T5.5 先交付 CLI 工作流，T6.4 再扩展同一发布流程，消除互相等待。
- M3 与 M4 可并行；M6 复用现有 CLI/protocol 链路，T6.3 只依赖实际需要的后台接口，不要求 M4 全部页面完成。
- T7.1 不依赖 T5.9；安装命令复用加载服务，不再出现插件安装与插件加载的循环依赖。
- **近期优先级**：先收尾快速低成本的长期会话体验，按实际复现修复无感配置隔离（不增加逐项目授权门槛），补 T0.2 → 建 CLI 三平台 CI/预发布 → 做桌面共享会话最小闭环 → 桌面核心体验与打包 → 插件示例。Docker、完整日志界面、额外包管理器暂不实施，不阻塞首个可用版本；不建设多实例 Hub。
- M0~M7 编号保持不变，便于引用；它们是能力分组，不代表必须串行完成或已经发布对应版本。

## 当前实现状态（2026-10-03，源码核对；不是发布认证）

| 里程碑          | 当前状态                          | 证据 / 说明                                                                                                                                                          |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 基线         | 部分完成                          | CLI 构建与本地回归已有记录；T0.2 上游同步文档仍缺失，三平台干净安装待 CI 验收。                                                                                      |
| M1 品牌与去耦   | CLI 已完成                        | CLI 命令、目录、登录去耦和默认厂商外连关闭已有提交；打包产物及桌面品牌仍需 T5/T6 核对，不能据此认定所有外部资产已改名。                                              |
| M2 Provider     | 三协议核心已完成                  | 配置、环境变量、导入、Chat/Responses/Messages 执行已有实现；能力及异常兼容矩阵见 T2.5，不承诺所有模型可用。Gemini 原生执行不在当前范围。                             |
| M3 记忆与缓存   | 基础已实现，关键边界未完成        | 有项目记忆与 scope 配置，固定容量史书、有界交接和本地历史查询已在工作区实现；后台预算和记忆并发可靠性仍待收尾。 |
| M4 Web 后台     | 配置页已实现                      | 本地 server、Provider/模型管理和连接测试已有实现；会话、记忆、状态、日志页面尚待交付。                                                                               |
| M5 发布         | 尚未交付 ComeCode 发布链路        | 上游构建脚本可复用，但当前跟踪文件中没有 GitHub Actions 工作流；npm、三平台产物、安装脚本和干净安装验收待完成。                                                      |
| M6 桌面版       | 上游基础存在，ComeCode 改造未验收 | 已有 Electron 与 CLI agent 通信基础；不需新造内核，但去耦、共享存储、跨端恢复、权限交互与打包仍待验证。                                                              |
| M7 插件/harness | 已有上游插件基础，工具扩展待交付  | 已有 plugins/skills/MCP 安装加载链路；先复用并去耦，再开放受控自定义工具，不重复建设市场或插件框架。                                                                 |

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
- 做法：沿用现有 `upstream-zcode` remote；写 `docs/upstream-sync.md`，说明合并步骤和容易冲突的文件清单（品牌/外部资产、配置去耦、缓存及权限边界）；可选写一个脚本，统计与上游的 diff 规模，不重复添加另一个 upstream。
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

### T2.5 模型能力与协议兼容矩阵（发布前补齐）

- 依赖：T2.1
- 做法：以 Chat Completions / Responses / Anthropic Messages 三协议为执行边界，记录模型的工具调用、图片输入、思考档位、上下文与输出上限；按有效配置决定能力，不靠名称推断或声称「支持所有模型」。不支持的能力在发送前明确提示，不静默丢附件、不覆盖显式窗口。
- 验收：本地 HTTP mock 覆盖流式/非流式网关、分片工具参数、多工具、usage 缺失、429/5xx、超时与取消；重试有限且可观察，不自动重放已经产生副作用的工具。实际模型验收单独记录供应商、协议、日期和费用，必须明确授权后才发付费请求。

### T2.6 有效配置隔离（无感修复，待复现）

- 依赖：T2.1。
- 目标：全局模型和 Key 配置一次，所有项目直接用；项目临时覆盖只影响当前项目，不污染其他项目或全局默认。
- 当前情况：运行时有效配置与用户 legacy 配置共用文件，跨项目影响需先用本地 mock 复现，再做最小内部隔离；不改用户使用方式，不新增解析器。
- 验收：虚构凭据、临时项目 A/B 的串行与并发测试，确认地址、模型和默认选择不串项目，用户配置正常共享。
- 不做：逐项目 Provider/MCP 信任、额外 trust 命令、重复审批或新的权限框架。保留现有工具权限、后台鉴权与脱敏。

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
  - 每个文件和总量自动限量，不阻断会话；`comecode memory check` 仅作可选诊断。
  - 新增 `comecode memory init`：生成 `.ai/` 模板，并把 `.ai/.local/` 加入 `.gitignore`。
  - 会话内加载一次后冻结，不随文件修改刷新（保证 cache 命中），压缩或新会话时刷新。
- 验收：单测覆盖加载顺序、截断、没有 `.ai/` 的情况；实测问 AI 项目信息时能引用 `.ai/project.md` 的内容。

> 2026-10-01 实现：ComeCode 默认从工作区 `.ai/` 按固定顺序加载五类文件，固定快照进入稳定 system section；新增 `comecode memory init/path/check`，并加入大小限制与 `.ai/.local/` 忽略规则。

### T3.2 快速交接与可选项目记忆

- 已实现：本地交接式压缩初版提交 `392fd0f`；本轮工作区已补齐每回合短小结、6,000 字符固定容量分层史书、有界交接和本地历史查询。压缩不调用摘要模型、不在压缩前强制等待 Memory，也不回带原文大尾部；实时与冷恢复使用相同交接。
- 史书近期记录较详细，旧记录合并为阶段后逐步变粗，容量不足时丢弃；普通续作不携带，用户询问历史时给大概。不建设额外档案、向量数据库或检索后台。自动记忆提取、显式 `/memory save` 和 `memory.scope` 保持独立，以下后台可靠性仍待收尾。
- 项目记忆是独立辅助功能，初始化和显式保存均可选，不能成为启动、压缩或继续工作的前置步骤；压缩不强制增加任何记忆模型调用。
- 后台提取采用合理默认预算，不阻塞前台；保存可取消、有等待上限，失败保留现有内容，不要求用户修复后才能继续。
- 保留现有写入权限、内容冲突检查及敏感信息过滤；滚动摘要以有界、低成本处理为先，不为旧历史无限调用模型。
- `both` 尚未完整双读写，当前滚动主要丢弃旧段落；先补实际使用中的可靠性问题，不扩展一套新的记忆系统。
- 已验证（本轮工作区）：CLI 全量本地回归 245/245 通过，包含真实普通回合 SQLite 史书落盘；万轮史书容量、连续压缩、无新用户消息续作、显式小窗口、冷恢复、取消/保存失败和本地历史查询通过。core/CLI 包与 engine 根类型检查通过，依赖优先 CLI 构建及 `--help` 通过，架构 0 违规，本轮定向 lint/格式检查通过。
- 检查限制：CLI 聚合 typecheck/lint 因缺少 `turbo` 无法运行；engine 根 lint 有 70 个既有 warning、0 error，根格式检查有 2,846 个文件不符合现有格式。未调用付费模型，尚无重启后真实长会话体验验收；后台记忆预算、保存等待、并发与 `both` 双读写仍未完成。

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
  - 按协议保留会话亲和信息：Responses / Chat 的 body `prompt_cache_key`、Anthropic 的 `metadata.user_id`；Codex/Plus 兼容后端还需标准 header `session-id` / `thread-id`，不能把中转层选渠道的键与上游缓存亲和混为一谈。当前标准头补发已提交为 `a489da8`，仍需重启后实机验收，不依赖服务器改名作为永久方案。
- 验收：本地测试证明 10 轮对话稳定前缀字节完全相同，并捕获最终 HTTP body/header，覆盖主/子会话、无会话及显式配置。真实命中率需同一足够长前缀连续多次取稳态，区分「请求有缓存读取的比例」与「缓存读取 token / 总输入 token」，一次或两次 A/B 不作为可靠结论。

### T3.5 缓存命中统计（已完成，2026-10-01）

- 依赖：T3.4
- 做法：从各 Provider 的 usage 中读取缓存 token（Anthropic `cache_read_input_tokens`/`cache_creation_input_tokens`，OpenAI `prompt_tokens_details.cached_tokens`，DeepSeek `prompt_cache_hit_tokens`，Gemini `cachedContentTokenCount`），统一成 `{input, cached, output}`；TUI 状态栏显示本会话命中率；写入会话记录，供 Web 后台展示。
- 验收：单测覆盖各家字段映射；在至少两家模型上实测数值合理。

### T3.6（可选）Codex 风格 apply_patch 工具

- 依赖：T0.1
- 做法：参考 `codex/codex-rs/apply-patch/src/`（parser、seek_sequence 模糊匹配）和 `codex/codex-rs/core/assets/tools/apply_patch.lark` 用 TS 实现；作为 JSON 字符串参数工具提供（非 OpenAI 模型不支持 Lark freeform 工具）；通过配置按模型启用。注意 Apache-2.0 署名。
- 验收：移植 Codex 的 apply_patch 测试用例并全部通过。

### T3.7 全调用成本、后台预算与记忆可靠性（收尾，不再追逐单一命中率）

- 依赖：T3.2、T3.5
- 成本：统一统计主对话、子代理、压缩、记忆提取、重试和目标校验；分别记录未缓存输入、缓存读取/写入、输出、调用次数。usage 缺失记为未知，不记为零；只有有来源且适用的单价才估价。
- 预算：后台提取、子代理、重试和目标续跑提供合理的内部 token/时间上限与取消路径，默认可用，不要求用户逐项配置；只有需要时开放高级覆盖。按任务链累计，避免用工具调用次数粗暴停止任务。
- 记忆：多个会话写同一 `.ai/` 文件需检测内容版本冲突并重新读取，避免旧摘要覆盖新修改；验证写入拒绝、滚动失败、进程退出和 project/user/both 隔离。摘要不得写入密钥或原始敏感日志；不新增压缩原文归档。
- 缓存：95% 只作为大量旧上下文、少量新增内容的热请求目标；首次请求、短上下文、压缩后和不同上游不承诺。已有 grok 有限样本热请求为 98.86%，gpt Responses 样本为 60.27%，不是整体达标证明；不为提高数字填充上下文、保活或修改服务器。
- 验收：以虚构凭据和本地 mock 覆盖所有调用类别、预算耗尽/取消、未知单价、并发写入与失败路径；发布说明同时展示总 token/调用次数和缓存率，不把高命中率当作低总费用。

---

## M4 Web 管理后台（V0.4）

2026-10-01：已实现本地管理 server、Provider/模型配置页、同地址供应商归类、模型编辑、连接测试和 API Key 脱敏；会话页、记忆页、状态页、日志页仍属于后续任务。

> 现有实现使用 CLI 内置轻量 server + 内嵌静态资源；原先 Hono/Vite 的技术选型只是建议，不再作为必须的新建目录约束，后续页面应优先扩展现有 admin 实现。

### T4.1 CLI 内嵌 HTTP server（已完成，2026-10-01）

- 依赖：T1.1
- 做法：
  - TUI 启动时在同一进程启动 server，监听 `127.0.0.1`，端口默认 `4545`，被占用时自动 +1；启动时生成随机 token，终端打印 `http://127.0.0.1:4545/?token=...`。
  - 参数：`--web`（自动打开浏览器）、`--no-web`、`--web-port`；无头 `--prompt` 模式默认不启动。
  - 多个实例各自使用本地端口；先满足单实例管理，不规划额外 Hub、实例注册或 token 协调系统。
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

各页面验收：Playwright 冒烟测试（能打开、有数据、关键操作成功）；深色/浅色主题；键盘可操作。

### T4.10 本地后台安全与跨端契约（发布闸门）

- 依赖：T4.1
- 做法：保留 loopback 默认监听；验证 Host/Origin 与 token，覆盖 DNS rebinding、CSRF、非法路径和 WebSocket 鉴权（若启用）。URL 中 token 消费后清除，不落日志；文件 API 只允许指定工作区和记忆白名单，拒绝路径穿越及符号链接逃逸。
- 配置/日志：凭据不回传明文，修改前备份并原子写入；原始模型请求/响应默认不全量保存，显式调试也要脱敏、限量和可清理。后台仅管理，不增加另一套对话执行入口；权限批准仍由当前会话控制端处理。
- 契约：先盘点现有 admin 接口与 ZCode protocol，复用已有 schema/事件；不要为每个前端另建状态库，也不为了页面重复建设通用 RPC 或 Hub。
- 验收：本地 mock 覆盖无 token、恶意 Origin/Host、跨路径读写、配置并发修改与敏感字段脱敏；桌面/CLI 同源状态一致。

---

## M5 开源发布（V0.5）

### T5.1 npm 包发布

- 依赖：M2 完成
- 做法：
  - 先确认 npm 上 `comecode` 包名是否可用，不可用时用 `@comecode/cli`。
  - 先验证现有 Node CLI 打包路径；只有确实需要时才拆平台 `optionalDependencies`，不要把 SEA 作为 npm 首发前提。检查 OpenTUI、koffi、SQLite、PTY、搜索工具及 Provider 目录/静态资源在包内是否齐全，不能依赖开发机 hoisted `node_modules`。
  - `engines.node` 以整个交付的实测最低版本为准，首版优先 Node 24 LTS；不能仅因 `node:sqlite` 的引入版本就宣称 Node 22 可用。
  - `npm pack --dry-run` 检查白名单与体积，再在临时环境安装 tarball 验证；不得带入配置、日志、参考克隆、开发用绝对路径。确认包名属于维护者、发布权限与 2FA/可信发布配置。
- 验收：在干净的 Windows / macOS / Linux 上 `npm i -g` 后能运行。

### T5.2 安装脚本与诊断

- 依赖：T5.1
- 内容：`comecode-install.sh`、`comecode-install.ps1` 首先走已验证 npm 路径，不偷偷安装 Node 或修改系统策略；独立包可用后再加下载分支。校验平台/架构/版本和 HTTPS 下载的 SHA-256，支持固定版本、代理/镜像说明及失败清理，不覆盖用户配置。
- 扩展已有 `comecode doctor`（`CLI/cli/src/run.ts`）而非重复新增命令：检查 Node、原生依赖、shell、工作区、配置和有效模型能力；默认只本地诊断、不发付费请求。文档提供升级、卸载与保留/删除数据的区别。
- 验收：全新环境、旧版升级、路径含空格/中文、下载失败和无管理员权限场景可复现。

### T5.3 文档

- 内容：快速开始、配置参考、Provider 接入示例（NewAPI / DeepSeek / GLM / Qwen 的已验收兼容接口；Gemini 原生明确标为仅检查、不执行）、记忆系统说明、Web 后台说明、贡献指南；中英文。

### T5.4 Docker

- 内容：参考 `engine/harness/remote/Dockerfile`；提供镜像，挂载项目目录运行，Web 端口映射；文档说明容器内的安全边界。

### T5.5 CI 与自动打包（先 CLI，再接桌面）

- 依赖：T0.1；npm 发布阶段依赖 T5.1，桌面阶段依赖 T6 核心验收，不反过来阻塞桌面开发。
- 内容：在仓库**根目录**新增 `.github/workflows/comecode-ci.yml` 与 `comecode-release.yml`（GitHub 不执行 `engine/.github/` 内的工作流）：
  - PR/push CI：锁定 Node/pnpm、`pnpm install --frozen-lockfile`、相关 typecheck/lint、CLI 全量 mock 测试；三平台构建、安装打包产物后跑 help 和本地 mock 完整对话。UI 有定向交互测试，不需要每次构建整个桌面。
  - tag release：同一版本来源生成 npm 包和已验收的独立 CLI 产物；SEA 先验证原生资源可加载再纳入支持。桌面就绪后接 electron-builder。声明 OS/架构支持矩阵（至少 win x64、mac arm64、linux x64；其他组合有 runner 和实测后才宣称支持）。
  - 产物统一 `comecode-<version>-<os>-<arch>.*`，附 SHA-256、CHANGELOG 和构建来源；先创建 draft Release，检查通过再发布。明确预发布/稳定通道、失败不更新 latest、可下载旧版回退。
  - 发布采用最小权限、受保护环境与明确授权；外部 PR 不接触发布密钥，Action 版本锁定。优先 npm trusted publishing，不能用时才用受控 token；不能让 PR 自动触发付费模型测试。
- 验收：CI 先无发布 dry-run；授权推 tag 后用户能从 Release 下载、校验、安装并跑通本地 mock。源码构建成功不等于交付产物可运行。

### T5.6 许可证、开源治理与隐私

- 内容：保留 Apache-2.0、NOTICE 与第三方许可，检查依赖/字体/图标/移植代码的归属及商标；不能把借鉴设计自动写成复制代码，也不能删除仍适用的上游声明。
- 发布前扫描当前文件、Git 历史及 npm/桌面包中的凭据、内部地址和个人数据；发现历史泄露先停发布并轮换凭据，重写历史需要单独确认。源码和运行日志的数据保留、导出/删除方法写清楚。
- 按需补根目录 `CONTRIBUTING.md`、`SECURITY.md`、CHANGELOG 和最小 Issue 模板；说明漏洞私密报告、受支持版本、更新节奏及用户自带模型凭据/承担 API 费用，不承诺付费 SLA。不为治理新增重型站点。

### T5.8 多渠道发布（分阶段，不一次维护全部渠道）

- 依赖：T5.5；桌面渠道依赖 T6.4。
- 第一阶段：npm 命令安装 + GitHub Release 下载已验收的 CLI 压缩包/独立包、桌面安装包，安装脚本复用同一产物；npm 需要 Node，独立包是否无需 Node 必须实测说明。
- 第二阶段：有稳定版本与校验值后再提交 winget/Homebrew 清单；Docker 仅作 CLI 可选渠道，不提供容器化桌面。Linux 桌面首版只维护一种可用格式，再按需求加 deb/rpm。
- 验收：每个已公布 OS/架构的安装方式有干净安装、升级、卸载及保留会话测试。CLI 至少命令安装和下载包两种；桌面提供原生安装包，不声称每个包管理器覆盖所有平台/产品。

### T5.9 插件安装 CLI

- 依赖：M7 的 T7.1
- 内容：优先复用现有 `plugins` 命令与安装服务，提供 `comecode` 品牌帮助及必要别名；对外文档只公布已验收的本地/git 来源。若清单缺少自定义工具支持，扩展清单，不另建一套插件数据库；registry 仅在显式启用后使用。
- 验收：从本地目录与 git 地址各安装一个示例插件并能加载（配合 T7.1）。

### T5.10 自愿赞助（不打扰用户）

- 依赖：M1；不阻塞核心发布，也不以 T5.5 全部渠道完成为前提。
- 原则：不开付费功能、不弹窗、不拦截操作、不在会话输出追加广告；默认不主动提示。用户点击 README/桌面帮助入口或显式调用 `comecode sponsor` 才展示；不需要提醒调度器或支付后台。
- 内容：只显示维护者已验证的 HTTPS 入口，不自动打开浏览器、不发请求、不加载跟踪脚本；`--help` 若提供入口只列命令，不在版本/JSON/协议输出追加文案。入口尚未配置时明确提示，不显示假链接。
- 渠道建议：
  - 中国大陆优先爱发电，核实当前微信/支付宝支持、提现规则、手续费和实名要求后上线；也可自愿提供个人收款码，但注意公开身份信息与平台规则。
  - 国际优先**在收款资格通过后**使用 GitHub Sponsors。GitHub 官方要求收款者位于支持地区并完成账户/税务设置；个人账号赞助无平台手续费，组织赞助最高 6%，不因此推断大陆维护者可直接收款。
  - Sponsors 无法开通时，再核实 Ko-fi/Buy Me a Coffee 所需 Stripe/PayPal 收款资格或合适的财政托管方案；不会因为换一个展示页面就自动解决地区限制。不开通未获资格的账户，不承诺 Sponsors 支持支付宝。
- 落地：核实后的国际入口 + 爱发电写 README 与 `.github/FUNDING.yml`（自定义链接即可）；到账与税务由平台和维护者处理，ComeCode 不存支付数据。若只能验证国内入口，先只上线这一项。
- 参考：[Sponsors 收款资格](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/about-github-sponsors-for-open-source-contributors)、[赞助费用](https://docs.github.com/en/sponsors/sponsoring-open-source-contributors/about-sponsorships-fees-and-taxes)；2026-10-03 核查，上线时再次确认。
- 验收：普通会话与机器可读输出没有赞助提示；主动入口仅显示有效链接，不产生网络/付款副作用；赞助与否不影响功能。

> T5.7（插件机制说明）已并入 M7，不再单列为纯文档任务，见 M7 依赖关系。

---

## M6 桌面版（V0.6）

目标：把现有 `@zcode/desktop`（Electron，已含 main/preload/renderer/scheduler、remote 远程开发、CUA 浏览器自动化、electron-builder 三平台配置）改造为 ComeCode Desktop，复用同一套 CLI Agent 能力，并与 CLI「会话共享」——做到「桌面像 Codex Desktop 一样可用，但不是一个独立 agent、也不是第二套 core」。

> 桌面研发依赖已可用的 CLI Agent，不等待全部 M4/M5 完成。现有 Host 已通过 `app-server --stdio` 调用 CLI，优先保留这条执行链路；M6 是统一品牌、存储与体验，而不是另起内核。T6.4 打包使用 T5.5 的 CLI 发布基础。对外配置与产物用 `comecode`，内部源码路径/scope 保留。

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

### T6.2 复用 CLI Agent 与共享会话（桌面首个闭环）

- 依赖：T6.1；复用 M3 已实现部分，不等待成本展示页面完成。
- 已有基础：`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` 已启动 CLI `app-server --stdio`。CLI 的会话数据库默认位于 `~/.comecode/cli/db/db.sqlite`，桌面 `packages/services/src/paths.ts` 仍有 `.zcode/v2` 根与任务索引，尚不能称作共享完成。
- 做法：
  - CLI Runtime/SessionStore 是消息、队列、模型选择、权限和用量的唯一事实来源；桌面 Host 负责宿主、连接与调度，Renderer 只存草稿和展示状态。桌面任务索引若需要保留，仅作可重建投影，不维护另一份会话事实。
  - 统一数据根与有效配置解析，复用现有协议/SQLite 迁移与 WAL；旧 `.zcode` 数据只显式导入且备份，不自动覆盖。本地路径规范化并沿用 workspace identity，不能把不同远程工作区当作同一个项目。
  - 同一会话只允许一个执行所有者，其他前端只读查看；恢复到另一个端时明确转交或拒绝，不同时启动两个 Agent 写同一会话。现有 Desktop Main lease 只覆盖其跨 Host 仲裁，补独立 CLI 进程的共享所有权、过期 run 拒绝与崩溃接管，不把内存锁误当全局锁。
  - 协议握手与存储 schema 版本有明确兼容范围；CLI/桌面版本错配给出升级提示，升级前备份；旧版不能盲写新版 schema。进程崩溃后不自动重放有副作用的工具。
- 验收：CLI 创建→桌面恢复→CLI 恢复（含工具、权限、模型、记忆、压缩后历史）；两端同时恢复时只有一个 writer；崩溃后可接管且无重复执行；不同工作区隔离、版本错配及数据库迁移有回归。

```text
CLI TUI ─────────────┐
Desktop Renderer → Host → 同一套 CLI Runtime / SessionStore → 工具与 Provider
Web 管理页 ──────────┘          ↑ 唯一执行所有者；其他端查看/显式转交
```

### T6.3 与 Web 管理后台打通

- 依赖：T6.2、T4.2 中需要的接口，不依赖所有后台页面。
- 做法：桌面复用现有 Host/protocol 事件与状态；配置、记忆和日志按需复用 admin 接口，不另起第二个服务或状态库。后台只管理和查看，桌面本身可以对话及执行任务。
- 验收：浏览器、桌面和 CLI 展示的会话/状态/用量一致；断线重连后恢复快照，不遗漏或重复事件。

### T6.4 桌面打包与更新

- 依赖：T6.1、T6.2、T6.5、T5.5 的 CLI 发布基础。
- 做法：复用 electron-builder，统一 `comecode` productName、appId、配置/安装器/更新资产命名；按已验收 OS/架构提供 Windows NSIS、macOS dmg 与一种 Linux 包。验证 Electron ABI 对应的原生依赖和随包 Agent，不依赖用户另装开发环境。
- 首版可发布未签名**预览包**，但明确 Windows SmartScreen/macOS Gatekeeper 限制，不能承诺开箱即用；稳定分发规划 Windows 签名与 macOS Developer ID/公证成本。验收签名、版本、校验与更新来源后才启用自动更新。
- 更新为用户明确操作或可关闭的检查，不在执行任务中强制重启；失败保留旧包及数据，说明 schema 迁移后是否允许回退。离线启动不被更新检查阻塞。
- 验收：发布下载的安装包可启动/退出，升级保留会话，失败可恢复；自动更新链路在授权测试 Release 验证，未签名/未公证平台限制如实记录。

### T6.5 Codex 风格桌面核心体验与安全（不是只套聊天壳）

- 依赖：T6.2
- 首版闭环：项目/会话列表与搜索恢复、流式消息与工具时间线、模型/思考强度选择、暂停/取消、权限/提问/计划确认、文件差异审阅、集成终端、用量/缓存与上下文状态；先复用已有组件、Git/PTY 服务，不另造编辑器。
- 文件与 Git：展示本次修改且不混淆用户原有改动，提供明确差异审阅；回滚只作用于确认的范围，不隐式 `reset --hard`。并行任务先采用独立工作区；需要 worktree 时作为后续增强，不能在同一目录无隔离并行改代码。
- 权限与宿主：沿用 CLI 交互契约，确认请求携带 session/run/tool 身份，旧请求不得批准新任务；窗口关闭/重连不悄悄批准。限制 preload/IPC 能力、验证 sender 与参数、保持 contextIsolation，远程网页不获取 Node 权限；任意命令仍受工具权限控制，Electron 本身不是安全沙箱。
- 验收：从创建项目到对话→工具确认→改代码→看 diff→运行测试→跨端恢复，全流程可键盘完成；取消可终止 Provider/子进程，PTY 随会话/窗口关闭回收；重连、崩溃、图片能力不支持、权限拒绝和小窗口布局有定向测试。
- 不阻塞首版：云同步、多人协作、远程 relay、手机控制、定时自动化、完整 IDE。上游 remote/CUA 保留但按需显式启用，不为这些能力恢复厂商登录或默认外连。

---

## M7 插件与 harness 自由度（V0.7，先小步开放）

目标：让 ComeCode 具备可扩展能力，但**先小步开放、不追求完整**。本里程碑只开放「插件加载 + 自定义工具」，命名/策略/Provider 等更深的 harness 自由度留到后续；默认关闭远程市场、保持简洁。ZCode 已有 plugins / skills / MCP 机制，本里程碑是把「仅文档」升级为「可落地的插件加载与自定义工具」，并以示例插件验收。

### T7.0 扩展点盘点

- 依赖：T0.1
- 做法：梳理 ZCode 现有 plugins、skills、MCP、tool registry 里哪些点已经可以被第三方覆盖、哪些需要新增开放接口；本里程碑只关注「插件发现/加载」与「工具注册」两点，其余只记录不实现。
- 交付：`docs/extensibility.md`（含插件目录约定、生命周期、权限边界，以及暂缓的能力清单）。
- 验收：文档能回答「第三方插件现在能做什么、不能做什么、安不安全」，并明确后续开放路线。

### T7.1 插件加载与安装

- 依赖：T7.0；T5.9 依赖本任务，不反向依赖。
- 做法：复用现有插件发现、安装、启停、卸载与 skills/hooks/MCP 加载；完善本地/git 清单校验和失败隔离，默认关闭远程市场。启用第三方代码前说明来源与能力，固定 git revision、记录版本，不在会话中静默更新。
- 验收：本地/git 两种来源可安装、启停、卸载；错误插件不影响其他插件或主会话；加载不自动执行未许可网络/脚本操作。

### T7.2 自定义工具（本里程碑的交付核心）

- 依赖：T7.1
- 做法：在现有清单中扩展声明式工具（输入/输出 schema、实现、展示说明、副作用与能力声明），复用 registry、日志与权限链路；内置工具与插件工具统一固定排序。会话中冻结工具表，启停后提示下次会话/压缩边界生效。
- 契约：定义版本及兼容范围、命名空间冲突、超时/取消、输出大小、异常隔离、幂等与重试规则；插件不能替换内置工具或访问未公开 Runtime 私有状态。
- 安全：插件声明不等于可信沙箱；第三方代码可能继承宿主权限，需明确安装信任风险。自定义工具优先通过受控子进程/现有 I/O adapter 执行，不能只靠作者声明「只读」跳过确认；skills 提示文本和远程 MCP 同样不具备授权能力。
- 验收：一个示例插件注册的工具在 CLI/桌面同样可用，进入统一权限与工具时间线；覆盖非法 schema、冲突、超时、取消、大输出、退出异常与拒绝权限。没有通过隔离测试前，不宣称恶意插件可安全执行。

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
你在 ComeCode 仓库根目录工作，源码在 engine/；不要修改 codex/ 或 ZCode/ 参考克隆。
先阅读：README.md、docs/PLAN.md 的「0. 全局约定」和任务 <Tx.y>。
前置任务的产出：<链接或说明>。
任务：<Tx.y 标题>
要求：只做本任务范围内的改动；按验收标准自测；最后汇报改动文件、验证方式、遗留风险。
```

## 3. 已确认事项（2026-10-03）

- 桌面版（M6）：**要做**，目标类似 Codex Desktop。边界已定：保留 `@zcode/desktop` 的 remote/CUA 等重能力并按需开关、**复用 CLI Agent 并会话共享**（CLI/桌面/后台读写同一份会话与配置，可互相恢复）。
- 插件（M7）：**先小步开放**，本里程碑只做「插件加载 + 自定义工具」，策略/循环与 Provider 适配器留到后续。
- 命名：对外与操作资产（bin、数据目录、桌面 productName、electron-builder 配置与产物名、安装器、Docker、CI 文件）一律用 `comecode`，不沿用 `zcode`；内部 `@zcode/*` scope 与源码标识符保留以便同步上游。
- 捐赠（T5.10）：自愿、不打扰；国内优先爱发电，国际优先在收款资格通过后的 GitHub Sponsors，不上线假链接、不假定支付支持。
- 仓库精简：已删除 `README.orig.md`，一次性验收 spec 已归档到 `docs/archive/`；`codex/`、`ZCode/` 参考克隆**保留**（对照阅读与移植用，不提交）。

## 4. 发布时才需要维护者确认的外部事项

- npm 包名/组织归属、发布权限；GitHub Actions 环境与发布凭据。
- 支持的 OS/架构、签名/公证预算；未验证组合不进入支持列表。
- 可实际收款的赞助账户及公开入口；占位链接不上线。

无需再等待确认的默认边界：Web 后台只管理，不发起对话；记忆写入跟随权限模式，含滚动处理；桌面必须做且共享 CLI 会话；插件首阶段只开放自定义工具。

## 5. 冗余精简（保持简洁可维护）

目标：在「基于上游改、便于同步」的前提下，减少仓库里失效或重复的资产。原则：可提交的内容才精简，参考克隆与个人文件只标记、不越权删除。

- 已完成：删除 `README.orig.md`（被 `README.md` 取代）；`docs/specs/` 里的一次性验收/状态记录（`CLI-RUNTIME-STATUS.md`、`CLI-OPTIMIZATION-VALIDATION.md`、`CACHE-LIVE-ACCEPTANCE.md`、`M1.md`、`M2.1.md`、`T2.4.md`）归档到 `docs/archive/`；行为规则 spec（`T2.2.md`、`PROVIDER-ONBOARDING.md`、`CLI-UI.md`、`ADMIN-CONFIG.md`、`CLI-CACHE-COMPACT.md`、`GUIDE-HISTORY-PRESENTATION.md`）保留原位。
- 保留：`codex/`、`ZCode/` 是被 .gitignore 忽略的参考克隆（不提交、占磁盘大），仅供对照阅读与移植引用，不删除。
- 本次核查未发现新的、可确证无用的跟踪文件，不删除上游包、许可文件、锁文件、构建脚本或个人目录。已有归档保留可追溯证据；只修正陈旧内容和错误引用。
- 持续规则：一份 PLAN 记录路线、一份 README 面向用户，行为写入已有 spec；不为每次调查新建一批状态文档。删文件前同时检查导入、构建、发布和文档引用，不能只凭名称像上游或未在本地使用就删。新抽象以至少两个实际使用场景为依据，避免双配置解析、双会话库、双权限链或双插件框架。

## 6. 最小发布闸门（按产品分别验收）

| 闸门       | CLI 首发                                                        | 桌面首发                                                |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| 干净安装   | npm tarball/Release 包在已公布平台运行，不依赖仓库 node_modules | 原生包内含匹配 Agent/原生资产，安装、退出、离线启动成功 |
| 核心任务   | 本地 mock 完整对话、工具权限、取消/恢复与三协议回归             | 对话、确认、diff、终端、取消与跨 CLI 恢复闭环           |
| 数据可靠性 | 配置派生不串项目、并发写入、退出保存、迁移/备份及版本拒绝       | 单执行所有者、崩溃接管、断线快照、升级保留 CLI 会话     |
| 安全与隐私 | 配置不串项目、默认无厂商外连、loopback 鉴权及脱敏     | 复用 CLI 配置与权限、preload/IPC 隔离、权限身份校验 |
| 成本真实   | 全调用 usage/未知值区分，后台预算有限，不做付费 CI              | 同一统计来源，不重复调用或创建第二套记忆后台            |
| 发布资料   | comecode 命名、版本、校验、变更记录、许可证、卸载说明           | 签名/公证或预览限制说明，更新策略与回退边界             |

未实现、仅源码测试通过、仅当前 Windows 验证的项分别标记；历史测试数量不是当前验收凭据。无需以所有后台页面、所有分发渠道或完整 harness 自由度换取首发。

## 2026-10-01：统一配置易用性补充（已实现的基础）

- 公开 JSON/JSONC，兼容 TOML 与旧 Provider JSON；供应商默认值可被模型的协议、地址、凭据、显示名、窗口与能力覆盖。
- 首次引导只填写必要字段，隐藏密钥并保存 JSON；保留显式窗口与已有配置。
- Web 多模型管理已有实现，发布前仍需验证打包资源与干净环境；历史计划描述不替代当前源码和测试。
