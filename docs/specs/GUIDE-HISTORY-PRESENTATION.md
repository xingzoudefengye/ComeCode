# 运行中输入的历史呈现（2026-10-02）

## 问题与范围

运行中 guide 在 steering 中出队一次，并把原文及 inputPresentation 进入 canonical history。每次模型请求的 provider projection 再次格式化所有历史 guide。旧模板使用“new message”并持续要求“Address the message above”，把历史事件写成当前待处理命令，可能反复诱发相同回应。

本次只修改呈现合同，不修改 queue/guide 投递、权限、模型选择、目标完成判定或消息持久化。重复出队、助手文本丢失不是本次已证实原因。

## 设计

- steering 是输入消费的唯一所有者；provider projection 是无状态纯转换，不增加另一份已回应队列。
- canonical history 保存用户原文与来源，不在工具请求后原地修改或删除历史。
- user/coordinator guide 的包装采用固定的过去事件描述，不再称它是本次请求的新输入，不再要求每次回应。
- 处理指引明确：吸收有效约束；已回应或已落实的输入属于历史，后续仅有新结果或阻塞才说明，不重复确认。
- 相同历史 entry 在第一次请求、工具后请求与冷恢复中都生成相同字节。不要通过首次 fresh 包装、后续中性包装的切换破坏缓存前缀。
- 背景通知保持“不是用户输入”的安全合同；peer 消息继续保留权限防越权说明，不在本次调整。

```text
用户输入 -> steering 单次消费 -> canonical 原文 + 来源
                               -> provider 纯投影（固定历史事件包装） -> 模型
模型回复及工具调用 -> 追加历史 -> 下一请求使用相同旧消息字节
```

## 验收

- user/coordinator guide 模板无持续的新消息/强制回应措辞。
- guide 原文保留，canonical entry 未被投影修改。
- 追加助手回应及多个工具步骤后，旧 guide 完整呈现字节不变。
- task notification 与 peer 的非用户输入/权限安全说明保留。
- 此回归只能证明呈现合同，不保证任何模型绝不重复；是否存在重复出队或助手文本遗失仍需真实请求轨迹判断。

## 后续设计边界

目标暂停应独立于完成验证：未完成不等于用户仍授权继续。后续需要明确暂停/更新命令，以及验证前后对目标版本和用户输入版本的检查。不能只靠检测“停止”等关键词，也不能靠隐藏重复输出掩盖仍在付费执行的请求。本次不声称目标续跑问题已修复。

## 代码管理流程的设计方向（尚未实现）

用户提供的建议以状态、决策冻结和分层验收为优先，落地时遵守以下边界：

- runtime 管理 `intake / plan / execute / verify / done / blocked / paused`，LLM 提供有限结构化提议，只有 runtime 能校验并提交转换。用户中断优先于完成检查；新目标版本使旧 verifier 结果失效。
- 决策由用户输入及已确认选项形成，按目标版本冻结；模型不得重复请求确认或单方面改变。只有显式更新才能产生新版本，不能保存一份与 canonical history 竞争的自由文本真相。
- 本地 DoD 与线上观测分别记录。代码、测试和本地构建齐备可判本地完成；需要付费授权、凭据或服务端行为的观测缺少条件时标为 blocked，不用其阻塞已经满足的本地交付，也不能假报线上成功。
- 内部 step result 结构化为状态、动作、产物、证据、阻塞；用户输出仍保留可读文本。不能把所有交互强制静默到终态，权限确认、取消、危险操作及必要进度应正常可见。
- “无新证据、无新动作”的重复 step 可触发停滞保护；工具正在等待、重试退避和背景任务必须有各自状态，不能简单连续两次空输出就取消有效长任务。
- 去重基于动作参数、输入内容版本、工作区状态及副作用合同。同一路径在文件变化后可以重读，同一测试在代码变化后必须重跑；不能只按命令字符串去重。

参考实际源码：

- [OpenAI Codex agent control](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/control.rs)：`interrupt_agent` 使用代码控制中断；监听路径检查 shutdown cancellation。参考其生命周期边界，不推断它使用上述六阶段状态机。
- [SWE-agent agent loop](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/agents.py)：retry loop 根据剩余 `cost_limit` 调整每次尝试预算，结果携带 `done / exit_status`。参考预算与终态管理，不照搬其提交/自动提交语义。

上述源码于2026-10-02读取远程 main，链接可能随上游变化。本次没有复制第三方实现，也没有宣称流程状态机、预算或目标暂停已实现。
