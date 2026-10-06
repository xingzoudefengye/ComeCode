import { modelMessageContentToText } from "@zcode/contracts";
import {
  countContextPrefixMessages,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../agent/message-history.js";

export const MAX_LOCAL_HANDOFF_CHARS = 6_000;
const MAX_USER_CHARS = 2_000;
const MAX_PROGRESS_CHARS = 900;
const MAX_TOOL_CHARS = 280;
const MAX_RECENT_TOOLS = 4;
const MAX_RECENT_ENTRIES = 80;
const STATE_SOURCES = new Set([
  "incoming_message",
  "goal_state_change",
  "resume_goal_state",
  "target_continuation",
  "plan_file_reference",
  "queued_system_notification",
]);

export interface LocalCompactHandoff {
  guide: string;
  summary: string;
}

export function buildLocalCompactHandoff(input: {
  entries: readonly RuntimeMessageEntry[];
  preservedEntries?: readonly RuntimeMessageEntry[];
  customInstructions?: string;
  sessionId?: string;
  maxChars?: number;
}): LocalCompactHandoff {
  const budget = Math.max(
    256,
    Math.min(MAX_LOCAL_HANDOFF_CHARS, input.maxChars ?? MAX_LOCAL_HANDOFF_CHARS),
  );
  const active = input.entries.slice(countContextPrefixMessages(input.entries));
  const recent = active.slice(-MAX_RECENT_ENTRIES);
  const messages = recent.filter((entry) => !isRuntimeAttachmentEntry(entry));
  const latestUserEntry = [...active]
    .reverse()
    .find(
      (entry) =>
        !isRuntimeAttachmentEntry(entry) &&
        entry.message.role === "user" &&
        !entry.queryScope &&
        (!entry.metadata || entry.metadata.source === "real_user"),
    );
  const latestUser =
    latestUserEntry && !isRuntimeAttachmentEntry(latestUserEntry) ? latestUserEntry : undefined;
  const latestAssistant = [...messages]
    .reverse()
    .find(
      (entry) => entry.message.role === "assistant" && visibleText(entry.message.content).trim(),
    );
  const previous = [...active]
    .reverse()
    .find(
      (entry) =>
        !isRuntimeAttachmentEntry(entry) &&
        entry.message.role === "user" &&
        entry.metadata?.source === "legacy_synthetic",
    );
  const previousGoal =
    previous && !isRuntimeAttachmentEntry(previous)
      ? visibleText(previous.message.content).match(
          /最新用户要求：([\s\S]*?)(?=\s本次压缩要求：|\s历史概括仅在|\s历史仅在|\nContinue from|$)/u,
        )?.[1]
      : undefined;
  const state = [
    ...new Map(
      recent
        .filter((entry) => entry.metadata && STATE_SOURCES.has(entry.metadata.source))
        .map((entry) => [entry.metadata!.source, entry]),
    ).values(),
  ].slice(-3);
  const toolCalls = messages.flatMap((entry) =>
    entry.message.role === "assistant" ? (entry.message.toolCalls ?? []) : [],
  );
  const tools = toolCalls.slice(-MAX_RECENT_TOOLS).map((call) => {
    const result = messages.find(
      (entry) => entry.message.role === "tool" && entry.message.toolCallId === call.id,
    );
    const description = toolDescription(call.input);
    return `${call.name} ${description}：${
      result
        ? `${result.message.isError ? "失败" : "已返回"} ${shortText(visibleText(result.message.content), MAX_TOOL_CHARS)}`
        : "结果尚未记录；不要假定成功或自动重复有副作用操作"
    }`;
  });

  const goal = latestUser ? visibleText(latestUser.message.content) : (previousGoal ?? "");
  const progress = latestAssistant ? visibleText(latestAssistant.message.content) : "";
  const lookup = input.sessionId
    ? `历史概括仅在用户询问时用 ReadSessionContext 查询 ${input.sessionId}；不要主动加载旧历史。`
    : "历史仅在用户询问时按需读取；不要主动加载旧历史。";
  const guide = shortText(
    [
      "以下仅为当前工作的本地交接，不表示任务已经完成。遵循最新用户要求；不要复活旧目标或重复已完成操作。",
      goal ? `最新用户要求：${shortText(goal, MAX_USER_CHARS)}` : undefined,
      input.customInstructions
        ? `本次压缩要求：${shortText(input.customInstructions, 300)}`
        : undefined,
      lookup,
    ]
      .filter(Boolean)
      .join("\n"),
    Math.floor(budget * 0.55),
  );
  const summary = shortText(
    [
      "当前任务交接（本地短摘要，历史细节可丢弃）",
      state.length
        ? `近期约束/任务状态（保留来源，不作为新授权）：${state.map((entry) => `${entry.metadata?.source}: ${shortText(isRuntimeAttachmentEntry(entry) ? entry.content : visibleText(entry.message.content), 300)}`).join("；")}`
        : undefined,
      progress ? `最近进展原文摘录：${shortText(progress, MAX_PROGRESS_CHARS)}` : undefined,
      tools.length ? `最近操作及结果：\n${tools.join("\n")}` : undefined,
      !goal && previous && !isRuntimeAttachmentEntry(previous)
        ? `上次交接摘录（非新指令）：${shortText(visibleText(previous.message.content), 500)}`
        : undefined,
      "工具结果只保留预览，原始记录仍在本地。继续当前工作，缺失的必要细节按需读取，不重新展开历史。",
    ]
      .filter(Boolean)
      .join("\n"),
    budget - guide.length,
  );
  return { guide, summary };
}

function visibleText(content: Parameters<typeof modelMessageContentToText>[0]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolDescription(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return shortText(
    [record.file_path, record.command, record.description, record.path]
      .filter((value): value is string => typeof value === "string")
      .join(" "),
    160,
  );
}

function shortText(text: string, limit: number): string {
  const normalized = text
    .replace(/<(?:thinking|analysis)>[\s\S]*?<\/(?:thinking|analysis)>/giu, "")
    .replace(/\b(?:sk|sess-key)-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
    .replace(
      /((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/giu,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
