import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES } from "@zcode/shared";
export type { BuiltinZCodeSlashCommandHelpEntry as SlashCommandHelpEntry } from "@zcode/shared";
// 内部共享协议保留 login，ComeCode 的可见命令列表隐藏它。
export const SLASH_COMMAND_HELP_ENTRIES = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.filter(
  (entry) => entry.name !== "login",
);
