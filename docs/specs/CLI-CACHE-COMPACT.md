# 请求缓存与自动压缩

## 产品规则

- 沿用现有预算配置优先级：显式 `compact.contextWindow` 可覆盖模型窗口；未覆盖时使用模型窗口，缺失或非法时回退到 200,000 token。
- 默认到窗口的 60% 自动压缩；合法的 `thresholdPercentOverride`（大于 0、不超过 100）优先。
- 实际阈值取百分比阈值与「窗口减输出预留、减安全余量」的较小值。压缩失败熔断、手动压缩和 microcompact 保持现有语义。
- 60% 会较早压缩，也会导致历史前缀重建；这是用户指定的上下文策略，不能声称它本身一定省钱。
- 复用现有系统提示词稳定/动态分区和 Anthropic cache breakpoint，不新增重复断点，不重排历史消息或有因果关系的附件。
- adapter 发送工具时按名称的确定性顺序排列，JSON schema 对象键递归排序，数组顺序和校验语义不变；不修改注册表与调用方对象。
- OpenAI SDK 请求缺少显式 `openai.promptCacheKey` 时使用 `comecode:<sessionId>`；流式、非流式、重试、压缩请求共享同一会话键，子会话隔离。无会话身份则不补键，显式配置优先。
- 不默认给 OpenAI 兼容、Anthropic 或其他未知接口发送额外缓存键，避免接口拒绝或计费行为改变。
- SDK 统一 usage 为主要事实；当 raw usage 包含各厂商缓存字段时补齐缓存统计。不把未知用量当成命中，不重复计入总输入。部分 OpenAI 兼容 SDK 会剥离非标准字段，仅返回 `prompt_cache_hit_tokens` 的端点尚不能保证统计，后续需要专门的 wire 适配；本轮不声称已支持所有 DeepSeek 端点。
- TUI 展示 runtime 下发的实际压缩阈值和已有 provider 用量的缓存比例；不在 UI 复刻模型预算公式。
- 关闭自动压缩后，主请求不下发压缩阈值，TUI 清除旧阈值；辅助请求不覆盖主请求预算。

## 所有者与顺序

```text
会话身份/消息历史（runtime） -> 请求投影（core） -> 稳定序列化（adapter） -> provider
预算配置 + 模型能力（runtime） -> compact policy -> 实际阈值事件 -> TUI
provider usage -> adapter 归一化 -> session 用量累计 -> TUI 缓存比例
```

## 验收

- 缺少模型窗口时按 512K 计算，默认在 307.2K（60%）触发；边界前一 token 不触发；小窗口受输出预留保护。Provider 明确声明的模型窗口保持原值。
- 10 轮请求的稳定系统前缀、工具 wire 定义逐字一致；动态日期与新消息不改变稳定系统区。
- 工具排序、schema 键排序不改变原输入、枚举/数组次序、strict 和 provider native 的能力语义。
- 缓存键同会话稳定、子会话不同、显式选项不覆盖、不支持接口不注入。
- Anthropic/OpenAI/DeepSeek/Gemini 用量样例验证缓存字段；真实费用与服务端命中率须连接 provider 后确认。
