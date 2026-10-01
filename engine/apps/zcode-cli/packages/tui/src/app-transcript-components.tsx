import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { Message } from "./app-model.js";
import { palette } from "./app-model.js";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { MarkdownText } from "./app-markdown.js";
import { ThoughtTranscriptPartView } from "./app-thought-components.js";
import { ToolTranscriptPartView } from "./app-tool-components.js";
import { WorkflowRunCardView } from "./app-workflow-card.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function ContentPane({
  animateEmptyLogo = false,
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  emptyText,
  id,
  focused,
  messages,
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  animateEmptyLogo?: boolean;
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  emptyText?: string;
  id?: string;
  focused: boolean;
  messages: Message[];
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  return h(
    "scrollbox",
    {
      id,
      focused,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      style: {
        backgroundColor: palette.background,
        border: false,
        flexGrow: 1,
        marginBottom: 0,
        minHeight: 8,
        contentOptions: {
          backgroundColor: palette.background,
          flexDirection: "column",
          padding: 0,
        },
        rootOptions: {
          backgroundColor: palette.background,
        },
        scrollbarOptions: {
          showArrows: true,
        },
        viewportOptions: {
          backgroundColor: palette.background,
        },
        wrapperOptions: {
          backgroundColor: palette.background,
        },
      },
    },
    ...(messages.length === 0
      ? [
          emptyText
            ? h("text", { key: "empty", style: { fg: palette.muted } }, emptyText)
            : h(EmptyTranscriptLogo, { animated: animateEmptyLogo, key: "empty-transcript-logo" }),
        ]
      : messages.map((message, index) =>
          h(MessageRow, {
            copy,
            expandedWorkflowRunIds,
            index,
            key: `${index}-${message.role}`,
            message,
            previousRole: messages[index - 1]?.role,
            terminalWidth,
            workflowCardsByToolCallId,
          }),
        )),
  );
}

export function MessageRow({
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  index,
  message,
  previousRole,
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  index: number;
  message: Message;
  previousRole?: Message["role"];
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  const parts = message.parts ?? [];
  if (message.role === "timeline") {
    return h(CompactTimelineRow, { copy, message, terminalWidth });
  }
  // speaker labels were visually noisy; only user prompts carry row chrome.
  const isUserMessage = message.role === "user";
  const rowBackground = isUserMessage ? palette.userMessageBackground : palette.background;
  const assistantText = message.role === "agent";
  const plainTextColor =
    message.role === "system"
      ? palette.warning
      : palette.text;

  return h(
    "box",
    {
      style: {
        backgroundColor: rowBackground,
        flexDirection: "column",
        // 按消息边界留白，不能按流式碎片重复添加间隔。
        marginTop: index > 0 && (isUserMessage || previousRole === "user") ? 1 : 0,
        marginBottom: 0,
        minHeight: 1,
        paddingLeft: isUserMessage ? 1 : 0,
        paddingRight: isUserMessage ? 1 : 0,
        paddingBottom: 0,
        paddingTop: 0,
        width: "100%",
      },
    },
    ...(assistantText && parts.length === 0
      ? [
          h(MarkdownText, {
            backgroundColor: rowBackground,
            content: message.content,
            key: "content",
            streaming: message.streaming,
          }),
        ]
      : parts.length === 0
        ? [h("text", { key: "content", style: { fg: plainTextColor } }, message.content)]
        : []),
    ...parts.map((part, partIndex) => {
      if (part.type === "tool") {
        // 卡片 join 按 toolCallId（与 GUI buildWorkflowRunByToolCallId 同规）。命中即渲染实时卡：
        // 工具行自己的 status 在 CreateWorkflow 上会在 run 还在飞的时候就变成 completed
        // （工具一launch完 run 就返回），所以状态必须读镜像，不能读 part.status。
        const workflowCard = workflowCardsByToolCallId?.get(part.toolCallId);
        if (workflowCard) {
          return h(WorkflowRunCardView, {
            card: workflowCard,
            copy,
            expanded: expandedWorkflowRunIds?.has(workflowCard.runId) ?? false,
            key: `workflow-${part.toolCallId}`,
            terminalWidth,
          });
        }
        // 无命中就回落今日的文本投影（编过但没有 run、或镜像尚未补种）。
        return h(ToolTranscriptPartView, {
          key: `tool-${part.toolCallId}`,
          part,
          terminalWidth,
        });
      }
      if (part.type === "thought") {
        return h(ThoughtTranscriptPartView, {
          copy,
          key: `thought-${partIndex}`,
          part,
        });
      }
      const textView = assistantText && part.format !== "plain"
        ? h(MarkdownText, {
            backgroundColor: rowBackground,
            content: part.text,
            key: `text-${partIndex}`,
            streaming: message.streaming,
          })
        : h("text", { key: `text-${partIndex}`, style: { fg: plainTextColor } }, part.text);
      // 思考标签与正文的间隔只归消息容器，避免与 Thought 外边距叠加。
      return parts[partIndex - 1]?.type === "thought"
        ? h("box", { key: `after-thought-${partIndex}`, style: { marginTop: 1, flexDirection: "column" } }, textView)
        : textView;
    }),
  );
}

function CompactTimelineRow({
  copy,
  message,
  terminalWidth,
}: {
  copy: TuiCopy;
  message: Message;
  terminalWidth: number;
}): React.ReactElement {
  const timeline = message.timeline;
  if (!timeline || timeline.type !== "context_compaction") {
    return h("box", null);
  }
  const compactCopy = copy.transcript.compact;
  const label =
    timeline.status === "started"
      ? compactCopy.started
      : timeline.status === "retrying"
        ? compactCopy.retrying({
            attempt: timeline.attempt ?? 0,
            maxAttempts: timeline.maxAttempts ?? 0,
          })
        : timeline.status === "skipped"
          ? compactCopy.skipped
          : timeline.status === "failed"
            ? compactCopy.failed
            : timeline.status === "interrupted"
              ? compactCopy.interrupted
              : compactCopy.completed;
  const retry =
    timeline.status === "failed" || timeline.status === "interrupted"
      ? compactCopy.retry(timeline.command ?? "/compact")
      : undefined;
  const center = retry ? ` ${label} | ${retry} ` : ` ${label} `;
  const sideWidth = Math.max(4, Math.floor((terminalWidth - center.length - 6) / 2));
  const line = "-".repeat(sideWidth);
  const color =
    timeline.status === "failed"
      ? palette.warning
      : timeline.status === "started"
        ? palette.accent
        : timeline.status === "retrying"
          ? palette.accent
          : palette.muted;

  return h(
    "box",
    {
      style: {
        backgroundColor: palette.background,
        flexDirection: "column",
        marginBottom: 0,
        minHeight: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    h(
      "text",
      {
        key: "compact-timeline",
        style: { fg: color },
      },
      `${line}${center}${line}`,
    ),
  );
}
