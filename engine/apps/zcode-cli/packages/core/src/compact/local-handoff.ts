import { modelMessageContentToText } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import { isRuntimeAttachmentEntry } from "../agent/message-history.js";

const MAX_HANDOFF_CHARS = 2_400;
const MAX_FIELD_CHARS = 700;

export interface LocalCompactHandoff {
  guide: string;
  summary: string;
}

export function buildLocalCompactHandoff(input: {
  entries: readonly RuntimeMessageEntry[];
  preservedEntries?: readonly RuntimeMessageEntry[];
  customInstructions?: string;
}): LocalCompactHandoff {
  const readable = input.entries
    .filter((entry) => !isRuntimeAttachmentEntry(entry))
    .map((entry) => {
      const role = entry.message.role;
      const text = modelMessageContentToText(entry.message.content).trim();
      if (!text && role !== "assistant") return undefined;
      return {
        role,
        toolName: entry.message.toolName,
        isError: entry.message.isError,
        text: compactText(text, MAX_FIELD_CHARS),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const latestUser = [...readable].reverse().find((item) => item.role === "user");
  const latestAssistant = [...readable].reverse().find((item) => item.role === "assistant");
  const recent = readable
    .filter((item) => item.role !== "tool" || item.isError)
    .slice(-4)
    .map((item) => {
    const label = item.toolName ? `工具 ${item.toolName}` : item.role;
    const suffix = item.isError ? "（失败）" : "";
    return `${label}${suffix}: ${item.text}`;
  });
  const preservedCount = input.preservedEntries?.length ?? 0;
  const custom = input.customInstructions?.trim();

  const summary = compactText(
    [
      "当前任务交接（本地短摘要）",
      latestUser ? `最近目标：${latestUser.text}` : undefined,
      latestAssistant ? `最近进展：${latestAssistant.text}` : undefined,
      recent.length > 0 ? `最近记录：\n${recent.join("\n")}` : undefined,
      preservedCount > 0 ? `最近一组原始消息已保留（${preservedCount} 条）。` : undefined,
      custom ? `用户压缩要求：${compactText(custom, 400)}` : undefined,
      "旧历史仍保存在本地；需要细节时按需读取会话历史，不要主动恢复全部旧对话。",
    ]
      .filter(Boolean)
      .join("\n"),
    MAX_HANDOFF_CHARS,
  );

  return {
    guide: compactText(
      [
        "继续最近一次用户目标，不重复已完成工作。",
        latestUser ? `当前目标：${latestUser.text}` : "当前目标：依据最近记录继续工作。",
        latestAssistant ? `已知进展：${latestAssistant.text}` : undefined,
        "下一步：先检查当前工作区和最近状态，再继续未完成动作。",
        "不要为了查旧历史而暂停当前任务；只有用户明确询问历史时才按需检索。",
      ]
        .filter(Boolean)
        .join("\n"),
      MAX_HANDOFF_CHARS,
    ),
    summary,
  };
}

function compactText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
