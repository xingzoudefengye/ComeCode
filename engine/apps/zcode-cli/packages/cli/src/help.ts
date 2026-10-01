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
  return `${base}\n\n本地管理：\n  comecode admin [--web-port <port>] [--no-browser]\n  comecode --web     同进程开启模型管理页\n  --no-web           禁用网页后台\n  保存模型配置后重启 ComeCode 生效。\n\n配置导入：\n  comecode import codex|claude\n  comecode --import codex|claude\n  从本机 Codex/Claude Code 配置导入 Provider，不会打印 API Key。\n\n项目记忆：\n  comecode memory init     创建项目 .ai/ 记忆模板\n  comecode memory path     显示项目记忆目录\n  comecode memory check    检查记忆文件状态\n`;
}