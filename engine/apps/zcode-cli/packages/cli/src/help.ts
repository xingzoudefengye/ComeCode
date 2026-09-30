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
    .join("\n");
}
