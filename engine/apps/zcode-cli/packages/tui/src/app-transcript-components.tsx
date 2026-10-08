import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { Message, ThoughtTranscriptPart, TranscriptPart } from "./app-model.js";
import { palette } from "./app-model.js";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { MarkdownText } from "./app-markdown.js";
import { ThoughtRunView } from "./app-thought-components.js";
import { ToolTranscriptPartView } from "./app-tool-components.js";
import { WorkflowRunCardView } from "./app-workflow-card.js";
import type { TuiWorkflowCard } from "./app-workflow-mirror.js";
import {
  messageHasVisibleContent,
  messageHasVisibleTool,
  stripInternalThinkingTags,
  toolPartHidden,
  ToolFailureSummary,
  toolTranscriptVisibility,
  WorkflowFailureSummary,
} from "./app-transcript-visibility.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function ContentPane({
  animateEmptyLogo = false,
  copy = DEFAULT_TUI_COPY,
  cwd,
  effort,
  expandedWorkflowRunIds,
  emptyText,
  id,
  focused,
  messages,
  model,
  now,
  terminalWidth = 100,
  version,
  workflowCardsByToolCallId,
}: {
  animateEmptyLogo?: boolean;
  copy?: TuiCopy;
  cwd?: string;
  effort?: string;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  emptyText?: string;
  id?: string;
  focused: boolean;
  messages: Message[];
  model?: string;
  now?: number;
  terminalWidth?: number;
  version?: string;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  const visibleMessages = coalesceThoughtOnlyMessages(
    messages.filter((message) => messageHasVisibleContent(message, workflowCardsByToolCallId)),
    workflowCardsByToolCallId,
  );
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
    ...(visibleMessages.length === 0
      ? [
          emptyText
            ? h("text", { key: "empty", style: { fg: palette.muted } }, emptyText)
            : h(EmptyTranscriptLogo, {
                animated: animateEmptyLogo,
                cwd,
                effort,
                key: "empty-transcript-logo",
                model,
                version,
              }),
        ]
      : visibleMessages.map((message, index) =>
          h(MessageRow, {
            copy,
            expandedWorkflowRunIds,
            index,
            key: `${index}-${message.role}`,
            message,
            now,
            previousRole: visibleMessages[index - 1]?.role,
            previousHadTool: messageHasVisibleTool(
              visibleMessages[index - 1],
              workflowCardsByToolCallId,
            ),
            previousHadThought: isThoughtOnlyMessage(
              visibleMessages[index - 1],
              workflowCardsByToolCallId,
            ),
            workflowCardsByToolCallId,
          }),
        )),
  );
}

// 每个 step 的 reasoning 各自成一条消息，而完成的工具行不渲染，导致一回合里
// 相邻多条只含思考的消息在版面上只剩一串 “+ Thought”。这里先按相邻关系合成
// 一条，配合 ThoughtRunView 渲染成单行；中间夹着可见内容（正文、运行中工具）时保持断开。
export function coalesceThoughtOnlyMessages(
  messages: Message[],
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): Message[] {
  const coalesced: Message[] = [];
  let run: Message[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    coalesced.push(run.length === 1 ? run[0]! : mergeThoughtOnlyMessages(run));
    run = [];
  };
  for (const message of messages) {
    if (isThoughtOnlyMessage(message, workflowCardsByToolCallId)) {
      run.push(message);
    } else {
      flushRun();
      coalesced.push(message);
    }
  }
  flushRun();
  return coalesced;
}

function mergeThoughtOnlyMessages(run: Message[]): Message {
  const first = run[0]!;
  return {
    ...(first.id ? { id: first.id } : {}),
    content: "",
    parts: run.flatMap((message) => message.parts ?? []),
    role: "agent",
    ...(run.some((message) => message.streaming) ? { streaming: true } : {}),
  };
}

// 一个 step 的 part 顺序是「思考 + 已完成工具」，隐藏的工具 part 不占用版面，
// 因此不能打断思考分组。返回以起始索引为键的连续思考分组。
function groupThoughtRuns(
  parts: TranscriptPart[],
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): Map<number, ThoughtTranscriptPart[]> {
  const runs = new Map<number, ThoughtTranscriptPart[]>();
  let headIndex = -1;
  let run: ThoughtTranscriptPart[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.type === "thought") {
      if (headIndex === -1) {
        headIndex = index;
        run = [];
      }
      run.push(part);
      continue;
    }
    if (part.type === "tool" && toolPartHidden(part, workflowCardsByToolCallId)) continue;
    if (headIndex !== -1) {
      runs.set(headIndex, run);
      headIndex = -1;
    }
  }
  if (headIndex !== -1) runs.set(headIndex, run);
  return runs;
}

function isThoughtOnlyMessage(
  message: Message | undefined,
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): boolean {
  if (!message || message.role !== "agent") return false;
  if (stripInternalThinkingTags(message.content).length > 0) return false;
  const parts = message.parts ?? [];
  if (parts.length === 0) return false;
  return parts.every((part) =>
    part.type === "thought" ? true : part.type === "tool" && toolPartHidden(part, workflowCardsByToolCallId),
  );
}

function findPreviousVisiblePart(
  parts: TranscriptPart[],
  partIndex: number,
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>,
): TranscriptPart | undefined {
  for (let index = partIndex - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.type === "tool" && toolPartHidden(part, workflowCardsByToolCallId)) continue;
    return part;
  }
  return undefined;
}

function UserMessageView({ content }: { content: string }): React.ReactElement {
  const paragraphs = content.split(/\r?\n\s*\r?\n/u);
  return h(
    "box",
    { style: { flexDirection: "column", width: "100%" } },
    ...paragraphs.map((paragraph, index) =>
      h(
        "box",
        {
          key: `user-paragraph-${index}`,
          style: { flexDirection: "row", marginTop: index > 0 ? 1 : 0, width: "100%" },
        },
        h("text", { style: { fg: palette.accent, flexShrink: 0 } }, "> "),
        h("text", { style: { fg: palette.text, flexGrow: 1 } }, paragraph),
      ),
    ),
  );
}

export function MessageRow({
  copy = DEFAULT_TUI_COPY,
  expandedWorkflowRunIds,
  index,
  message,
  now,
  previousRole,
  previousHadTool,
  previousHadThought,
  terminalWidth = 100,
  workflowCardsByToolCallId,
}: {
  copy?: TuiCopy;
  expandedWorkflowRunIds?: ReadonlySet<string>;
  index: number;
  message: Message;
  now?: number;
  previousRole?: Message["role"];
  previousHadTool?: boolean;
  previousHadThought?: boolean;
  terminalWidth?: number;
  workflowCardsByToolCallId?: ReadonlyMap<string, TuiWorkflowCard>;
}): React.ReactElement {
  const parts = message.parts ?? [];
  const thoughtRuns = groupThoughtRuns(parts, workflowCardsByToolCallId);
  if (message.role === "timeline") {
    return h(CompactTimelineRow, { copy, message, terminalWidth });
  }
  // speaker labels were visually noisy; only user prompts carry row chrome.
  const isUserMessage = message.role === "user";
  const isFinishMarker = message.role === "system" && message.content === copy.transcript.finish;
  const rowBackground = isUserMessage ? palette.userMessageBackground : palette.background;
  const assistantText = message.role === "agent";
  const displayContent = stripInternalThinkingTags(message.content);
  const plainTextColor = message.role === "system" ? palette.warning : palette.text;

  return h(
    "box",
    {
      style: {
        backgroundColor: rowBackground,
        flexDirection: "column",
        // 按消息边界留白，不能按流式碎片重复添加间隔。
        marginTop:
          isFinishMarker ||
          (index > 0 &&
            (isUserMessage ||
              previousRole === "user" ||
              previousHadTool ||
              previousHadThought ||
              parts.some((part) => part.type === "tool")))
            ? 1
            : 0,
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
            content: displayContent,
            key: "content",
            streaming: message.streaming,
          }),
        ]
      : parts.length === 0
        ? [
            isUserMessage
              ? h(UserMessageView, { content: displayContent, key: "user-content" })
              : h("text", { key: "content", style: { fg: plainTextColor } }, displayContent),
          ]
        : []),
    ...parts.map((part, partIndex) => {
      if (part.type === "tool") {
        const workflowCard = workflowCardsByToolCallId?.get(part.toolCallId);
        if (workflowCard) {
          if (workflowCard.status === "completed") return null;
          if (workflowCard.status === "errored" || workflowCard.status === "stopped") {
            return h(WorkflowFailureSummary, {
              card: workflowCard,
              copy,
              key: `workflow-failed-${part.toolCallId}`,
              terminalWidth,
            });
          }
          return h(WorkflowRunCardView, {
            card: workflowCard,
            copy,
            expanded: expandedWorkflowRunIds?.has(workflowCard.runId) ?? false,
            key: `workflow-${part.toolCallId}`,
            terminalWidth,
          });
        }
        const visibility = toolTranscriptVisibility(part);
        if (visibility === "hidden") return null;
        const toolView =
          visibility === "failed_summary"
            ? h(ToolFailureSummary, {
                copy,
                key: `tool-failed-${part.toolCallId}`,
                part,
                terminalWidth,
              })
            : h(ToolTranscriptPartView, {
                copy,
                part,
                now,
                terminalWidth,
              });
        return partIndex > 0
          ? h(
              React.Fragment,
              { key: `tool-${part.toolCallId}` },
              h("box", {
                style: {
                  backgroundColor: palette.background,
                  height: 1,
                  width: "100%",
                },
              }),
              toolView,
            )
          : toolView;
      }
      if (part.type === "thought") {
        // 一组连续思考只在起始索引渲染一次，其余 part 让位给同一行。
        const run = thoughtRuns.get(partIndex);
        if (!run) return null;
        const previousVisiblePart = findPreviousVisiblePart(
          parts,
          partIndex,
          workflowCardsByToolCallId,
        );
        const thoughtView = h(ThoughtRunView, { copy, key: `thought-${partIndex}`, parts: run });
        return previousVisiblePart?.type === "text"
          ? h(
              "box",
              {
                key: `before-thought-${partIndex}`,
                style: { marginTop: 1, flexDirection: "column" },
              },
              thoughtView,
            )
          : thoughtView;
      }
      const textView =
        assistantText && part.format !== "plain"
          ? h(MarkdownText, {
              backgroundColor: rowBackground,
              content: part.text,
              key: `text-${partIndex}`,
              streaming: message.streaming,
            })
          : h("text", { key: `text-${partIndex}`, style: { fg: plainTextColor } }, part.text);
      const previousVisiblePart = findPreviousVisiblePart(
        parts,
        partIndex,
        workflowCardsByToolCallId,
      );
      // 思考标签与正文的间隔只归消息容器，避免与 Thought 外边距叠加。
      return previousVisiblePart?.type === "tool"
        ? h(
            React.Fragment,
            { key: `after-tool-${partIndex}` },
            h("box", { style: { backgroundColor: palette.background, height: 1, width: "100%" } }),
            textView,
          )
        : previousVisiblePart?.type === "thought"
          ? h(
              "box",
              {
                key: `after-thought-${partIndex}`,
                style: { marginTop: 1, flexDirection: "column" },
              },
              textView,
            )
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
