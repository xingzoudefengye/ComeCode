# CLI CI 与预发布产物约定（T5.5）

## 范围与所有者

仓库根 `.github/workflows/comecode-cli.yml` 负责三平台干净依赖安装、CLI 依赖闭包构建、本地 mock 回归及上传 artifact；根 `scripts/package-comecode-cli.mjs` 是 Node CLI 分发目录与归档的唯一组装入口。不修改 Agent runtime、admin 或桌面，不发布 npm/GitHub Release。

## 构建与安全规则

- Node **24.14.0**、pnpm **10.33.2** 来自 `engine/mise.toml` / `engine/package.json`，升级时同步工作流。使用根 workspace 的冻结锁文件，不使用 CLI 子目录的旧锁文件。
- 只安装 CLI 与内置插件的依赖闭包，保留必要的 install scripts 与原生 optional dependencies；先拓扑构建 CLI 依赖，再构建内置插件。
- 回归使用明确列出的本地传输 mock／临时目录测试，不读取用户配置、不调用付费模型。工作流无 secret、无发布权限，checkout 不持久化凭据。
- PR、main push 和手动触发都只上传 artifact；手动触发可用于预发布候选构建，不等于正式发布。
- 打包入口只复制现有资源收集器列出的资源及 CLI/provider/许可证文件，不复制工作区、用户配置、`.env`、日志或 sourcemap。provider JSON 如出现非空凭据字段则失败，不输出凭据内容。预发布前仍需人工审查模型目录、第三方许可及依赖供应链，静态检查不等于完整密钥审计。

## 分发契约

- `comecode-<version>-<platform>-<arch>.tar.gz` 含 `comecode.cjs`、`node_modules/`、`provider/`、内置 `packages/` 资源、许可证及 `package.json`（bin 为 `comecode`）。归档旁有 SHA-256 文件。
- 使用外部 Node 24.14.0（不内嵌 Node），解包后运行 `node /path/to/comecode.cjs --help`，或将解包目录作为本地 CLI 包安装。**不是单 bundle、SEA、自包含 exe 或 npm 发布物**。
- 只面向产物标记的 OS/CPU；Linux 为 glibc runner 基线，不承诺 musl 或旧发行版兼容。矩阵覆盖 Windows x64、Linux x64、macOS arm64；其他架构以后加原生 runner，不交叉假装验证。
- 使用 tar 保留可执行权限，不直接上传含符号链接的散目录。缺资源、依赖解析失败、原生库加载失败、help 失败或凭据检查失败均阻止上传；不回退到不完整 bundle。
- 从归档重新解包到系统临时目录，在无仓库父级 node_modules 的条件下加载 TUI、OpenTUI 原生库、Koffi 和 Playwright，并执行 `--help` 与 `--licenses`。临时数据目录隔离，不启动真实模型或浏览器。完整交互式 TUI、浏览器安装、签名、公证及其他平台仍须后续验收。

## 验收

1. `pnpm --filter "@zcode/cli..." --filter "@zcode/browser-use-plugin..." --filter "@zcode/node-repl-host..." install --frozen-lockfile`（cwd: engine）。
2. `pnpm --filter "@zcode/cli..." build`，随后 `pnpm --filter @zcode/browser-use-plugin --filter @zcode/node-repl-host build`。
3. 工作流中的本地 mock 回归及 CLI help 成功。
4. 根目录运行 `node scripts/package-comecode-cli.mjs`；隔离解包冒烟成功，检查 `artifacts/comecode/` 的归档及校验和。
5. 三个平台必须分别在 CI 真正运行后才能认定通过；本地 Windows 的结果不替代 Linux/macOS。
