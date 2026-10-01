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

使用 `comecode memory init` 创建模板，`comecode memory path` 查看路径，`comecode memory check` 检查文件状态。`.ai/.local/` 用于未来归档，初始化时自动加入 `.gitignore`。

## 加载与缓存

Runtime 首次初始化上下文时读取上述五个文件，并按固定顺序组成一个稳定的 system section。会话内快照冻结，不因文件被修改而自动刷新；新会话或显式 context refresh 时重新加载。每个文件最多加载 12,000 字符，总量最多 48,000 字符，超限会在快照中显示截断提示。

## 写入与权限

自动提取只允许修改 `.ai/` 固定文件，必须先读取再 Edit/Write，继续遵守当前权限模式。提取只使用最近会话内容，不读取代码来补事实，不保存密钥、临时聊天叙述或仓库中已经显而易见的内容。

## 当前边界

- 旧用户级记忆代码仍保留兼容模块，但 ComeCode 项目记忆默认写入工作区 `.ai/`。
- `.ai/.local/archive/` 的原文归档和 RecallArchive 检索属于后续永续会话任务，当前只预留目录忽略规则。