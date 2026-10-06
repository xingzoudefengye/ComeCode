import { getZCodeCopy, type SupportedLocale, type UiLocale } from "@zcode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  const base = getZCodeCopy(locale, detectedLocale)
    .cli.help(version)
    .split("\n")
    .filter((line) => !/^\s+(?:login\b|\/login\b|--no-browser\b)/u.test(line))
    .join("\n");
  return `${base}\n\n本地管理：\n  comecode admin [--web-port <port>] [--no-browser]\n  comecode --web     同进程开启模型管理页\n  --no-web           禁用网页后台\n\n配置导入：\n  comecode import codex|claude\n  comecode --import codex|claude\n  从本机 Codex/Claude Code 配置导入 Provider，不会打印 API Key。\n\n记忆管理：\n  comecode memory init [--scope user|project|both]   创建记忆模板（默认 project）\n  comecode memory path [--scope user|project|both]   显示记忆目录（默认 project）\n  comecode memory check [--scope user|project|both]  检查文件与容量预算（默认 project）\n  comecode memory history                          只读用户史书，无需初始化\n  comecode memory compact [--apply]                预览项目记忆整理；--apply 显式应用\n  comecode memory recover                          恢复中断的项目记忆整理事务\n  user 模板只含 profile.md、preferences.md；史书由运行时管理。\n  TUI 中输入 /memory save  按配置作用域保存当前会话的长期信息\n`;
}
