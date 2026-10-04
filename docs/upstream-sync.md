# 上游同步流程（T0.2）

`engine/` 是 ZCode 的 Git subtree，ComeCode 改动在同一仓库维护；`codex/`、`ZCode/` 是忽略的只读参考克隆，不参与同步。沿用现有 `upstream-zcode` remote，不重复添加上游。

本文仅是操作手册，本次没有 fetch、pull、合并、push 或覆盖任何源码。

## 同步前

1. 在仓库根检查 `git status --short`、近期提交和各层 `AGENTS.md`；有未提交改动先由其所有者处理，不用 reset/checkout 覆盖。
2. `git remote -v` 确认 `origin` 为 ComeCode、`upstream-zcode` 为 ZCode。远端 URL 若不符，先与维护者确认，不自行重写。
3. 本地 `git log --all --grep=git-subtree --format=full` 确认 subtree 导入方式与 split 基线。当前导入提交 `e365167` 的 split 为 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，未使用 squash；后续应以实际最新 subtree 元数据为准。
4. 记录 ComeCode HEAD、最新 subtree split、工具版本与已知测试失败。建立备份引用和独立同步分支；命令中的日期需替换，备份引用不要重复使用。

```sh
git switch main
git branch backup/upstream-sync-YYYYMMDD
git switch -c upstream-sync-YYYYMMDD
```

## 明确授权后执行同步

以下命令会访问远端、改工作树并创建合并提交，必须另行授权，不能当成只读检查运行。

```sh
git fetch upstream-zcode main
git log --oneline <上次-split>..upstream-zcode/main
git diff --stat <上次-split> upstream-zcode/main
git subtree pull --prefix=engine upstream-zcode main
```

保持当前非 squash 历史方式，不临时加入 `--squash`。如计划固定上游 commit，先确认该 commit 已在本地，再用 `git subtree merge --prefix=engine <已审查的上游-commit>`，不要用普通目录复制取代 subtree。同步来源、split、许可证变更和验证结果写入同步 PR。

冲突时 `git status` 查明文件，逐项合并并精确 `git add <files>`；不对整个 engine 使用 ours/theirs。遵循 Git 提示完成合并。无法继续时，在确认没有新增需保留的工作后使用 `git merge --abort`；若已完成提交，保留同步分支与备份供审查，不在共享分支强制 reset。验证通过后由维护者审查并合入 main；push、PR 创建或正式发布需要单独授权。

## ComeCode 外部命名冲突清单

外部资产统一 `comecode`；内部 `@zcode/*` scope、源码目录及协议标识保留，不能全局字符串替换。以下是审查清单，尚未实现的资产只在上游引入时检查，不为同步任务顺手新增。

| 领域                 | 重点路径／资产                                                                                                                      | 合并原则                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| CLI 品牌与入口       | `engine/apps/zcode-cli/packages/cli/package.json` 的 bin，CLI help／version／启动入口；根 `README.md`                               | 对外命令为 comecode，内部 dist/zcode.cjs 可保留，文档以实际命令为准                       |
| CI 与发布文件        | `.github/workflows/comecode-cli.yml`、`scripts/package-comecode-cli.mjs`、上游 SEA／上传／release 脚本                              | 产物与 workflow 外部名称用 comecode；不得恢复自动上传、npm 发布或未经授权的 Release       |
| 配置与存储去耦       | `engine/apps/zcode-cli/packages/adapters/`、`bootstrap/`、`engine/packages/provider-node/`；用户 `~/.comecode/` 和项目 `.comecode/` | 保留 ComeCode 配置发现、显式 provider/model、离线默认与迁移兼容；不恢复厂商遥测或默认外连 |
| 缓存与压缩           | CLI core/context/runtime、adapters/model，`docs/specs/CLI-CACHE-COMPACT.md` 及 cache/local-compact 测试                             | 验证完整请求前缀；压缩后不重发旧历史，不把命中率等同低总费用                              |
| 权限与子代理         | CLI adapters/tools、bootstrap、core/runtime 与相关回归                                                                              | 保留审批、取消、预算与本地历史边界，不恢复静默提权或收费测试                              |
| 桌面外部资产         | `engine/packages/desktop` 的 productName、electron-builder、安装器、图标／产物名                                                    | 外部用 comecode；仅在 M6 批准范围修改，CLI/桌面共用会话配置，不另造存储                   |
| Docker／安装器／渠道 | 上游 Dockerfile、CI、安装与分发脚本、release 配置                                                                                   | 外部文件、镜像、命令与产物用 comecode；无授权不接通发布密钥／上传端点                     |
| 归属与许可证         | `engine/LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`、随包第三方声明                                                             | 保留上游署名及适用许可，品牌改名不等于删除来源归属                                        |

## 合并后的验收与最小回滚

- 依照 `engine/mise.toml` 固定 Node/pnpm，从 engine workspace 冻结安装；运行 CLI 依赖优先 build、目标包类型／lint、本地 mock 回归和 help。
- 运行 `node scripts/package-comecode-cli.mjs`，检查分发依赖与许可；三平台结果以实际 CI 为准，参见 [CLI 分发约定](specs/CLI-DISTRIBUTION.md)。
- 比较同步前后命名、配置层级、默认网络行为、缓存与权限回归；禁止读取真实凭据或自动调用付费模型。
- 原同步合并分支保留到验收结束；回滚已共享的变更使用经过审查的 revert（明确父提交），不强推重写历史。合并记录附上回滚目标。
- T0.2 的真实同步／空合并演示尚需独立授权，本次文档交付不声称已完成实际同步验收。
