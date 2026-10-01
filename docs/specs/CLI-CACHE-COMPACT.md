# 请求缓存与自动压缩

## 产品规则

- 沿用现有预算配置优先级：显式 `compact.contextWindow` 可覆盖模型窗口；未覆盖时使用模型窗口，缺失或非法时回退到 512,000 token；内置目录的通用模型兜底同样为 512,000，模型专属规则和用户显式窗口不改写。
- 默认到窗口的 60% 自动压缩；合法的 `thresholdPercentOverride`（大于 0、不超过 100）优先。
- 实际阈值取百分比阈值与「窗口减输出预留、减安全余量」的较小值。压缩失败熔断、手动压缩和 microcompact 保持现有语义。
- 60% 会较早压缩，也会导致历史前缀重建；这是用户指定的上下文策略，不能声称它本身一定省钱。
- 复用现有系统提示词稳定/动态分区和 Anthropic cache breakpoint，不新增重复断点，不重排历史消息或有因果关系的附件。
- adapter 发送工具时按名称的确定性顺序排列，JSON schema 对象键递归排序，数组顺序和校验语义不变；不修改注册表与调用方对象。
- OpenAI SDK 请求缺少显式 `openai.promptCacheKey` 时使用 `comecode:<sessionId>`；流式、非流式、重试、压缩请求共享同一会话键，子会话隔离。无会话身份则不补键，显式配置优先。
- 不默认给 OpenAI 兼容、Anthropic 或其他未知接口发送额外缓存键，避免接口拒绝或计费行为改变。
- SDK 统一 usage 为主要事实；当 raw usage 包含各厂商缓存字段时补齐缓存统计。不把未知用量当成命中，不重复计入总输入。部分 OpenAI 兼容 SDK 会剥离非标准字段，仅返回 `prompt_cache_hit_tokens` 的端点尚不能保证统计，后续需要专门的 wire 适配；本轮不声称已支持所有 DeepSeek 端点。
- TUI 展示 runtime 下发的实际压缩阈值和已有 provider 用量的缓存比例；不在 UI 复刻模型预算公式。
- 主请求 ModelComplete 的有效正整数 contextWindow 同步进入权威会话投影及 TUI；回合结果不能再用初始化/恢复的旧窗口覆盖它。title/compact/subagent/tool_internal 等辅助请求不得改写主窗口或阈值。旧主事件缺少 querySource 时兼容读取窗口，但不以缺失字段清除当前值。
- 旧事件缺少窗口或传入 0/负数/NaN/Infinity 时保留当前有效窗口，不在 TUI 强制写 512K。模型切换后由最新主请求纠正旧投影。
- CLI 单包 build 在打包前按 contracts → core 更新直接运行时构建产物，避免 src 已更新但 dist 仍保留 200K 的混合版本。复用各包 TypeScript 配置，不引入新依赖或改变包名。
- 关闭自动压缩后，主请求不下发压缩阈值，TUI 清除旧阈值；辅助请求不覆盖主请求预算。

## 所有者与顺序

```text
会话身份/消息历史（runtime） -> 请求投影（core） -> 稳定序列化（adapter） -> provider
预算配置 + 模型能力（runtime） -> compact policy -> 实际阈值事件 -> TUI
provider usage -> adapter 归一化 -> session 用量累计 -> TUI 缓存比例
```

## 验收

- 状态栏验证 16.2K/1M（2%）与 Compact 600K；默认窗口显示 512K；显式 32K/128K 保持原值。投影恢复、辅助请求、缺失和非法窗口回归覆盖。
- 编译产物与源码默认 512K/307.2K 一致；单包 CLI build 更新 contracts/core，未知模型的 Registry 兜底为 512K，deepseek-flash 的目录窗口仍为 1M。
- 缺少模型窗口时按 512K 计算，默认在 307.2K（60%）触发；边界前一 token 不触发；小窗口受输出预留保护。Provider 明确声明的模型窗口保持原值。
- 10 轮请求的稳定系统前缀、工具 wire 定义逐字一致；动态日期与新消息不改变稳定系统区。
- 工具排序、schema 键排序不改变原输入、枚举/数组次序、strict 和 provider native 的能力语义。
- 缓存键同会话稳定、子会话不同、显式选项不覆盖、不支持接口不注入。
- Anthropic/OpenAI/DeepSeek/Gemini 用量样例验证缓存字段；真实费用与服务端命中率须连接 provider 后确认。

## 窗口状态同步修复（2026-10-01）

根因：主请求事件携带当前模型窗口，但事件投影和 TUI 未更新窗口；CLI 单包构建又读取旧 contracts/core dist，造成 200K 旧分母与 600K 实际压缩阈值并存。修复仅更新主请求的有效窗口、目录通用兜底 512K 和构建依赖刷新，不覆盖模型专属/用户显式窗口，不更改模型选择协议。

验收覆盖原生状态栏 1M/512K/128K、投影回合合并、辅助请求与非法字段、Registry 未知模型 512K/deepseek-flash 1M/显式 32K、过期 dist 重编译、新 CLI bundle + 本地 HTTP mock 完整对话。测试临时项目增加空配置边界，避免向上发现用户真实配置。

contracts/core/tui/cli 与 engine 根 typecheck 通过；TUI 和 CLI bundle 构建通过；改动文件直接 oxlint 0 warning / 0 error；架构检查、--help、git diff --check 通过。根 lint 70 个既有 warning、0 error，包级 lint 仍受既有忽略规则影响。Windows/Node 24.19.0 验证，未调用付费模型或修改用户配置。

本次最终全量 CLI 测试：90/90 通过。
