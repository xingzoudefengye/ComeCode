# 2026-09-30 CLI 优化验证

## 本轮交付

- 工具和 schema 定义稳定序列化，OpenAI 按会话补缓存键，保留既有 Anthropic 断点；十轮稳定系统和工具前缀回归测试。
- 自动压缩默认 60%，缺失窗口回退 512K（默认阈值 307.2K），保留输出预留、安全余量和失败熔断；阈值由 runtime 发送到 TUI。Provider 明确声明的模型窗口保持原值。
- 主任务阶段、耗时、最近真实活动、结束状态、子代理数量和缓存比例；窄屏固定单行。
- 前台、后台、转后台与恢复执行均受无活动监督；人工确认暂停；终态先登记；通知有限重试；旧执行与收尾未退出时阻止恢复。

## 已验证

- Node 24.19.0，corepack pnpm 10.33.2；项目声明 Node 24.14.0，存在版本警告。
- 45 项源码测试全部通过，含现有 M1 测试与新增缓存、压缩、子代理失败/恢复测试；恢复准备 metadata 写入未退出时拒绝再次恢复。
- OpenTUI 原生 headless 状态栏测试：24/40/80/120 列，完成、等待确认、90 秒无进展、缓存展示均不溢出。
- 事件到 OpenTUI 状态栏的测试通过：子会话终态、镜像、重复和迟到事件不能结束主任务；关闭自动压缩后清除旧阈值。
- 根 `pnpm typecheck` 通过；根 `pnpm lint` 70 个历史 warning、0 error。
- contracts、i18n、core、adapters、bootstrap TypeScript 构建通过，TUI 类型编译通过。
- 收尾后 TUI typecheck 和完整 lint 通过；core TypeScript 构建通过；源码 CLI `--help` 冒烟通过。

## 环境限制与待确认

- CLI 聚合 typecheck/lint 找不到 turbo；改用相关包直接检查，不将聚合失败写成通过。
- core/adapters 完整 lint 存在历史 max-lines 失败。本轮已拆出监督与通知 helper；TUI 本轮新增的文件行数问题已消除。
- 本轮 core 文件定向 oxlint 仅有 `turn-model-step.ts` 的历史 max-lines 错误；缓存 adapter 文件定向 oxlint 无 error，保留一处未改动行的历史 warning。
- TUI 和 CLI esbuild 打包遭遇 `spawn EPERM`；未替换发布产物，不应把全局 comecode 指向的旧 bundle 当作新版。
- freshness 和 changed architecture 检查的 Git 子进程同样遭遇 `spawn EPERM`；模块上下文检查通过（zcode-cli 为 unmanaged）。
- oxfmt CLI 启动外部格式化进程失败，已通过同版本 oxfmt 的进程内 `format()` API 格式化本轮源文件。
- 当前 `.git` 只读，没有创建提交、分支或推送。建议提交分成运行监督、压缩策略、缓存稳定性三个功能，中文 Conventional Commits。
- 未使用真实 Provider 费用数据验证节费比例。60% 压缩会重建历史缓存前缀，不保证该阈值本身节费。
- 子代理仍为同进程执行；可解除父等待、发出取消并回收后台命令，无法强制终止堵住事件循环的同步代码。
- 图片能力已有 `properties.inputFormat.supportsImage`；TUI 已接入 Ctrl+V 和跨平台剪贴板 reader。真实系统剪贴板、终端快捷键传递和识图模型未实测。

运行源码测试（目录 `engine/apps/zcode-cli`）：

```text
node --test --test-isolation=none --test-concurrency=1 --import ./test/typescript-loader.mjs ./test/*.test.mjs
```
