# ComeCode 项目记忆内部说明

## 配置导入状态

Provider 配置导入已支持：

- `comecode import codex` / `comecode import claude`；
- `comecode --import codex|claude` 兼容写法；
- 只读取本机配置，不调用源工具网络接口；
- 导入结果写入 ComeCode JSON 配置，重复导入幂等，旧配置会备份，输出脱敏。

## 项目记忆位置

项目记忆位于当前工作区（优先 git 根目录，否则 cwd）的 `.ai/`：

`project.md` → `decisions.md` → `tasks.md` → `bugs.md` → `memory.md`。

这些命令均为可选管理入口，不是开始使用或压缩的前置步骤。使用 `comecode memory init` 创建模板，`comecode memory path` 查看路径，`comecode memory check` 检查文件状态。`.ai/.local/` 由程序保存内部运行状态，初始化时自动加入 `.gitignore`。用户只需在 TUI 中输入 `/memory save` 触发显式提取；它不覆盖已有文件，是否发生实际修改由当前会话内容决定。

## 加载与缓存

Runtime 首次初始化上下文时读取上述五个文件，并按固定顺序组成一个稳定的 system section。会话内快照冻结，不因文件被修改而自动刷新；新会话或显式 context refresh 时重新加载。每个文件最多加载 12,000 字符，总量最多 48,000 字符，超限会在快照中显示截断提示。

## 写入与权限

自动提取只允许修改 `.ai/` 固定文件，必须先读取再 Edit/Write，继续遵守当前权限模式。提取只使用最近会话内容，不读取代码来补事实，不保存密钥、临时聊天叙述或仓库中已经显而易见的内容。

## 规则文件兼容

上下文规则按固定顺序合并：用户级 `~/.comecode/AGENTS.md` / `CLAUDE.md`，项目级最近目录的 `AGENTS.md`、`CLAUDE.md` 和 `.comecode/AGENTS.md`。同一路径只注入一次；会话启动后规则快照保持稳定。

## 当前边界

- 旧用户级记忆代码仍保留兼容模块，但 ComeCode 项目记忆默认写入工作区 `.ai/`。
- 压缩采用本地短交接，不调用摘要模型、不等待强制记忆提取；长期记忆提取独立，等待与预算边界仍待收尾。
- 压缩只携带稳定前缀与不超过 6,000 字符的本地交接内容（固定包装另占少量字符），包含当前目标、近期进展、有限工具行动/结果和带来源的约束；不回带大原文尾部、不重放文件源码。实时运行与冷恢复读取同一份持久化交接。
- 普通回合结束后，已有用户目标和最终回复被本地摘成短小结，写入 SessionStore 单个 `runtime/session_chronicle` entry；包括 JSON 开销总计不超过 6,000 字符。近期层最多 12 条、每条 160 字符；早期层最多 6 条、每条 100 字符；最旧层最多 4 条、每条 60 字符。旧层按代表事项合并，容量不足时继续丢弃，不依赖模型做语义总结。
- 史书不注入正常请求，明确询问历史时由现有 `ReadSessionContext` 本地读取；缺失或损坏时从旧消息做有界摘录。没有新增压缩原文归档，也不提供 RecallArchive 或 `memory search` 命令。