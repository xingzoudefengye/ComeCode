# 用户跨项目记忆

## 范围与所有者

Runtime 是上下文快照的唯一所有者；本地 managed chronicle 是用户历史的唯一持久化写入路径。默认 `memory.scope=project`，只有 `both` / `user` 启用用户记忆，且 `enabled=false` 或 `use=false` 均禁止加载和历史读取。桌面 `memoryEnabled` 控制运行时 enabled，关闭不会删除文件。

项目 `.ai/` 保留五类文件及正常 Read-before-Edit、Write/Edit 权限。用户稳定背景位于同一 CLI storage root 的 `memories/user/`，仅加载 profile.md、preferences.md（各最多 2000 字符、快照含标题最多 4000 字符）；只保存明确的用户偏好，不保存项目事实、不提升指令优先级。普通工具不会自动获得用户目录写入许可。

## 时序与预算

新 turn admission → 异步 reloadMemorySnapshot → 安装稳定 user-first system 前缀 → tool steps 使用同一快照。压缩边界也刷新本地快照；配置/工具步骤的同步重建不读磁盘、不调用网络。project + user 记忆 section 总预算含 headers 为 48000 字符。

用户史书 chronicle.json 由终态回合 managed 写入，自动合并衰减，最多 6000 字符；不随每轮注入，通过 ReadSessionContext 的可选 scope=user 本地按需读取。默认 scope=session 保持旧 schema 使用方式，user 仍要求有效 sessionId（当前会话即可）；查询失败返回受控结果，无付费摘要模型调用。

自动提取仅写固定白名单，双根事务提交，输入 16000 字符/累计输出 2000 token，最多 3 turn / 30 秒。稳定偏好不做时间模糊，但受容量限制。上述预算是固定常量，暂无配置入口。

## 兼容与验收

不迁移旧 hashed 目录，不加载旧 history.md，不跨设备或远端同步。没有新增 UI 管理承诺。测试使用临时配置与本地 mock，覆盖双项目共享 storage、禁用、默认 project、旧历史忽略、含标题预算和按需史书。损坏/缺失背景不阻断主流程；事务写失败不覆盖原文件。
