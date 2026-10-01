import { getZCodeCopy, type SupportedLocale, type UiLocale } from "@zcode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getZCodeCopy(locale, detectedLocale)
    .cli.help(version)
    .split("\n")
    .filter((line) => !/^\s+(?:login\b|\/login\b|--no-browser\b)/u.test(line))
    .join("\n") + "\n\n本地管理：\n  comecode admin [--web-port <port>] [--no-browser]\n  comecode --web     同进程开启模型管理页\n  --no-web           禁用网页后台\n  保存模型配置后重启 ComeCode 生效。\n";
}
