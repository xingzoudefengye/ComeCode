项目定位：

基于 ZCode 底座，融合 Codex/Claude Code 的 Agent 能力，开发一个开源版 AI Coding Agent。核心是 CLI 工作流，同时提供浏览器管理后台。一个命令启动，终端干活，网页配置和查看状态。

项目名称：

ComeCode

⸻

一、最终用户体验目标

用户安装：

npm install -g comecode

启动：

comecode

即可：

终端：

正常 Coding：

> 分析这个项目，优化数据库查询
> AI:
> 读取文件...
> 修改代码...
> 运行测试...
> 完成...

浏览器：

自动启动：

http://localhost:xxxx

提供：

* API配置
* 模型选择
* 会话管理
* 项目记忆查看
* Agent运行状态
* 日志查看

不用额外启动 server。

⸻

二、总体架构

目标：

                 comecode
                   |
          -------------------
          |                 |
        CLI终端           Web UI
          |                 |
          -------------------
                   |
             Session Manager
                   |
             Agent Runtime
                   |
     --------------------------------
     |              |               |
 Context       Provider        Memory
 Manager       Manager         System
     |              |               |
     --------------------------------
                   |
                NewAPI
                   |
 GPT / Claude / DeepSeek / GLM / Qwen

⸻

三、底座选择

使用 ZCode 作为基础

原因：

* Provider设计更适合多模型
* 上下文管理更适合长期会话
* 缓存友好
* 更容易扩展Web
* 更适合开源生态

吸收 Codex 的部分

重点移植：

Agent执行能力

包括：

* 任务规划
* 文件分析
* 代码修改
* 测试执行
* Bug修复循环

工具系统

支持：

read file
write file
edit file
terminal
git
test
search
MCP

⸻

四、第一核心：Provider系统

目标：

解除模型绑定。

支持：

OpenAI
Anthropic
Gemini
DeepSeek
GLM
Qwen
OpenAI-compatible

例如：

配置：

provider: openai-compatible
base_url:
https://你的newapi地址/v1
api_key:
xxxx
model:
deepseek-v4.1

⸻

五、保持 cc-switch 兼容

不要破坏现有生态。

保留：

OPENAI_API_KEY
OPENAI_BASE_URL
MODEL

这样：

现在：

cc-switch
 ↓
Codex

未来：

cc-switch
 ↓
MyCode
 ↓
NewAPI

继续可用。

⸻

六、第二核心：Context / Memory系统

你的重点差异化。

目标：

一个项目可以使用：

* 几天
* 几周
* 几个月

不会因为窗口爆炸重新开始。

建立：

.ai/
├── project.md
│   项目介绍、技术栈、目标
│
├── decisions.md
│   架构决定、重要选择
│
├── tasks.md
│   当前任务、TODO
│
├── bugs.md
│   已知问题
│
└── memory.md
    历史压缩摘要

⸻

七、上下文管理策略

不要无限塞聊天记录。

设计：

最近消息
    ↓
直接进入上下文
旧消息
    ↓
自动总结
长期信息
    ↓
保存Memory文件

类似：

人的记忆：

短期记忆
+
长期记忆

⸻

八、缓存优化方向

你的重点：

提高 Prompt Cache 命中率。

设计原则：

保持固定前缀：

System Prompt
+
工具定义
+
项目规则
+
Memory
+
最近任务

尽量不要：

每轮动态改变：

* 工具顺序
* 系统提示
* 无关环境信息

目标：

让：

AAAAAAA + 新问题
AAAAAAA + 新问题
AAAAAAA + 新问题

提高缓存命中。

⸻

九、Web后台功能

不是重新做一个聊天工具。

主要做管理：

1. 配置

网页：

Provider:
OpenAI-compatible
API:
xxx
Model:
GPT-5.6

⸻

2. Session管理

查看：

项目A
运行中
项目B
暂停
项目C
完成

⸻

3. Memory查看

查看：

项目总结
架构决定
当前任务

⸻

4. Agent状态

查看：

正在读取文件
正在执行测试
修改xxx.py

⸻

十、开发顺序

不要一次做完。

V0.1 基础版

目标：

跑起来。

完成：

✅ Fork ZCode
✅ 改名字
✅ CLI启动

⸻

V0.2 多模型

完成：

✅ Provider抽象
✅ NewAPI支持
✅ cc-switch兼容

⸻

V0.3 长期会话

完成：

✅ Memory目录
✅ 自动总结
✅ Context压缩

⸻

V0.4 Web

完成：

✅ 一个命令启动
✅ 自动启动Web
✅ 配置页面
✅ Session页面

⸻

V0.5 开源版

完成：

✅ 安装脚本
✅ 文档
✅ Docker部署
✅ Plugin机制

⸻

最终项目定位

不是：

「另一个 Codex」

而是：

一个不绑定任何厂商、支持所有模型、CLI优先、网页管理、拥有长期项目记忆的开源 AI 软件工程师。

你的最终组合：

ZCode:
Provider + Context + Web思路
Codex:
Agent执行能力
Claude Code:
Memory理念
Harness:
网页管理
NewAPI:
模型生态

第一步：

Fork ZCode → 本地跑通 → 找 Agent/Provider/Context 三个核心目录开始改。