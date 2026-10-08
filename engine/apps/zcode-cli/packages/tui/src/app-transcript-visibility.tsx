import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { Message, ToolTranscriptPart } from "./app-model.js";
import { palette } from "./app-model.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
import { formatDuration } from "./state.js";
import { truncateDisplay } from "./app-terminal-width.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function messageHasVisibleContent(
  message: Message | undefined,
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): boolean {
  if (!message) return false;
  if (message.role === "timeline") return Boolean(message.timeline);
  const parts = message.parts ?? [];
  if (parts.length === 0) return stripInternalThinkingTags(message.content).length > 0;
  return parts.some((part) => {
    if (part.type === "tool") return !toolPartHidden(part, workflowCardsByToolCallId);
    return Boolean(part.text);
  });
}

export function messageHasVisibleTool(
  message: Message | undefined,
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): boolean {
  return Boolean(
    message?.parts?.some(
      (part) => part.type === "tool" && !toolPartHidden(part, workflowCardsByToolCallId),
    ),
  );
}

// 完成的工具行不占版面；工作流卡片只有未完成时才有可见状态。
export function toolPartHidden(
  part: ToolTranscriptPart,
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): boolean {
  const workflowCard = workflowCardsByToolCallId?.get(part.toolCallId);
  if (workflowCard) return workflowCard.status === "completed";
  return toolTranscriptVisibility(part) === "hidden";
}

export function stripInternalThinkingTags(content: string): string {
  return content.replace(/<thinking>[^]*?<\/thinking>/giu, "").trim();
}

export function toolTranscriptVisibility(
  part: ToolTranscriptPart,
): "live" | "hidden" | "failed_summary" | "interactive" {
  if (part.toolName.toLowerCase() === "askuserquestion") return "interactive";
  if (part.status === "completed") return "hidden";
  if (part.status === "failed") return "failed_summary";
  return "live";
}

export function WorkflowFailureSummary({
  card,
  copy,
  terminalWidth,
}: {
  card: TuiWorkflowCard;
  copy: TuiCopy;
  terminalWidth: number;
}): React.ReactElement {
  const status =
    card.status === "errored"
      ? copy.transcript.workflow.status.errored
      : copy.transcript.workflow.status.stopped;
  const error = card.error?.replace(/\s+/gu, " ").trim();
  return h(
    "text",
    { style: { fg: palette.danger } },
    truncateDisplay(
      `${card.label ?? card.runId} · ${status}${error ? `: ${error.slice(0, 160)}` : ""}`,
      terminalWidth,
    ),
  );
}

export function ToolFailureSummary({
  copy,
  part,
  terminalWidth,
}: {
  copy: TuiCopy;
  part: ToolTranscriptPart;
  terminalWidth: number;
}): React.ReactElement {
  const error = part.error?.replace(/\s+/gu, " ").trim();
  const suffix = part.durationMs === undefined ? "" : ` · ${formatDuration(part.durationMs)}`;
  return h(
    "text",
    { style: { fg: palette.danger } },
    truncateDisplay(
      `${copy.status.toolFailed(part.title ?? part.toolName)}${suffix}${error ? `: ${error.slice(0, 160)}` : ""}`,
      terminalWidth,
    ),
  );
}
