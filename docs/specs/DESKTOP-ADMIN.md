# Desktop 共享管理控制台

## 所有者与入口

- 桌面设置的模型页通过 `IPlatformService.executeDesktopCommand(OpenAdminConsole)` 打开管理窗口。UI 不访问 Repo、不启动 Agent、不自行构造配置路径。
- Main 只管理 sandbox 窗口和独立 CLI `admin desktop-stdio --no-browser` 管理进程；进程不创建 Agent。复用 CLI 命令解析器和现有 admin HTTP 页面/API。
- CLI 管理进程读取用户全局 `config.json`，不得以 Host 临时 provider/runtime 投影作为配置源，也不得注入当前远程 workspace。全局配置持久化归统一配置 editor。

```text
设置 → 平台命令 → Main 管理窗口/进程 → CLI admin → config editor → 全局 config.json
桌面会话 → existing window Host → TaskService → 原有恢复链路（保持不变）
```

## 安全、生命周期与限制

- ready 消息通过 stdout 单行 JSON 传递，仅接受随机端口 127.0.0.1 HTTP、根路径、32 字节 hex token fragment。凭据不写日志。stdin EOF 关闭管理服务；窗口关闭和应用退出终止管理进程；启动超时/失败向设置页面反馈。
- 窗口无 preload、禁用 Node、启用 contextIsolation/sandbox/webSecurity。禁止所有新窗口；导航仅允许同一受控 origin；不放宽 CSP、Origin、frame-ancestors。
- 本版控制台能查看共享历史，继续使用页面提供的 CLI 恢复命令，不声明 `desktopResumeAvailable`。真正桌面恢复仍走现有 Host/TaskService，不新增跨进程恢复协议。
- 配置源共享不等于运行中的 Host 即时热更新。保存后重启桌面应用以应用全局配置；已有任务不切换模型。Host snapshot 的 prepare 仅合并正在执行的投影，不永久缓存成功或失败 Promise；下一次 prepare 必须重新读取来源。运行中 Host 自动重载尚未实现。

## 验收

- 多次打开聚焦同一窗口；关闭窗口清理管理进程；管理进程失败可再次打开。
- 临时 HOME/dataRoot mock 验证全局来源保存及管理进程 EOF 退出，不读取真实密钥，不调用模型。
- 对 ready URL 的远程地址、用户信息、非根路径、非法 token 做拒绝测试。
- 定向类型、lint 与架构验证；不运行根全量、不发布、不提交。
