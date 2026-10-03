import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { ToolResultDisplayLine, ToolTranscriptPart } from "./app-model.js";
import { ShikiDiffView, diffViewForWidth } from "./app-shiki-diff-view.js";
import { palette } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { formatClockTime, formatDuration } from "./state.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { activeTuiTheme } from "./theme/index.js";

const MAX_OUTPUT_LINES = 8;
const OUTPUT_LINE_INDENT_WIDTH = 4;
const TOOL_DETAIL_INDENT = "  ";
const TOOL_OUTPUT_LINE_INDENT = "    ";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function ToolTranscriptPartView({
  copy = DEFAULT_TUI_COPY,
  now,
  part,
  terminalWidth = 100,
}: {
  copy?: TuiCopy;
  now?: number;
  part: ToolTranscriptPart;
  terminalWidth?: number;
}): React.ReactElement {
  const statusColor = colorForStatus(part.status);
  const theme = activeTuiTheme();
  const title = buildToolTitleLine(part, now, copy);
  const questionAnswer = part.toolName.toLowerCase() === "askuserquestion";
  const outputLines = part.output
    ? questionAnswer ? part.output.split(/\r?\n/u) : restoredOutputLines(part.output, terminalWidth)
    : [];
  // tool rows should align with assistant text; child detail rows carry their own indent.
  return h(
    "box",
    {
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginTop: 0,
        width: "100%",
      },
    },
    h("text", { style: { fg: statusColor } }, title),
    ...part.detailLines.map((line, index) =>
      h(
        "text",
        { key: `detail-${index}`, style: { fg: theme.info } },
        `${TOOL_DETAIL_INDENT}${line}`,
      ),
    ),
    ...(part.resultDisplay
      ? [
          ...(part.resultDisplay.title
            ? [
                h(
                  "text",
                  { key: "result-title", style: { fg: theme.info } },
                  `${TOOL_DETAIL_INDENT}${part.resultDisplay.title}`,
                ),
              ]
            : []),
          ...resultDisplayNodes(part.resultDisplay, terminalWidth),
        ]
      : []),
    ...(outputLines.length > 0
      ? [
          h(
            "text",
            { key: "output-title", style: { fg: theme.info } },
            `${TOOL_DETAIL_INDENT}output:`,
          ),
          ...outputLines.map((line, index) =>
            h(
              "text",
              {
                key: `output-${index}`,
                style: { fg: theme.textMuted, ...(questionAnswer ? { wrapMode: "word" } : {}) },
              },
              `${TOOL_OUTPUT_LINE_INDENT}${line}`,
            ),
          ),
        ]
      : []),
    ...(part.error ? [h("text", { key: "error", style: { fg: palette.danger } }, part.error)] : []),
  );
}

function resultDisplayNodes(
  display: NonNullable<ToolTranscriptPart["resultDisplay"]>,
  terminalWidth: number,
): React.ReactElement[] {
  if (display.structuredPatch?.length) {
    return [
      h(ShikiDiffView, {
        filePath: display.filePath,
        key: "result-shiki-diff",
        structuredPatch: display.structuredPatch,
        terminalWidth,
        truncated: display.truncated,
        view: diffViewForWidth(terminalWidth),
      }),
    ];
  }
  return display.lines.map((line, index) =>
    h(
      "text",
      { key: `result-${index}`, style: styleForDiffLine(line) },
      `${TOOL_DETAIL_INDENT}${line.text}`,
    ),
  );
}

function colorForStatus(status: ToolTranscriptPart["status"]): string {
  if (status === "completed") return palette.success;
  if (status === "failed") return palette.danger;
  if (status === "running") return palette.accent;
  return palette.muted;
}

/** 依状态取符号（i18n 控制，便于按语言调换）。 */
function symbolForStatus(
  status: ToolTranscriptPart["status"],
  copy: TuiCopy,
): string {
  const symbols = copy.transcript.status;
  if (status === "completed") return symbols.completed;
  if (status === "failed") return symbols.failed;
  if (status === "running") return symbols.running;
  return symbols.pending;
}

/**
 * 拼装工具行标题（单行）：`符号 名称[ · 耗时[ · 完成时刻]]`。
 * 终态显示 recap 时长 + 完成时间；running 且有时钟时实时递增；无时刻的旧 part 退化为 `符号 名称`。
 */
function buildToolTitleLine(
  part: ToolTranscriptPart,
  now: number | undefined,
  copy: TuiCopy,
): string {
  const label = part.title ?? part.toolName;
  const suffix = toolStatusSuffix(part, now);
  return `${symbolForStatus(part.status, copy)} ${label}${suffix}`;
}

function toolStatusSuffix(part: ToolTranscriptPart, now: number | undefined): string {
  if (part.status === "running" && part.startedAt !== undefined && now !== undefined) {
    return ` · ${formatDuration(now - part.startedAt)}`;
  }
  if (part.status === "completed" || part.status === "failed") {
    if (part.durationMs === undefined) return "";
    const time = part.finishedAt !== undefined ? ` · ${formatClockTime(part.finishedAt)}` : "";
    return ` · ${formatDuration(part.durationMs)}${time}`;
  }
  return "";
}

function styleForDiffLine(line: ToolResultDisplayLine): Record<string, string> {
  const theme = activeTuiTheme();
  if (line.tone === "addition") {
    return { bg: theme.diffAddedBg, fg: theme.diffAdded };
  }
  if (line.tone === "deletion") {
    return { bg: theme.diffRemovedBg, fg: theme.diffRemoved };
  }
  return { fg: line.tone === "meta" ? theme.diffLineNumber : theme.diffContext };
}

function restoredOutputLines(output: string, terminalWidth: number): string[] {
  const width = Math.max(20, terminalWidth - OUTPUT_LINE_INDENT_WIDTH);
  const lines = output.split(/\r?\n/u);
  const visible = lines.slice(0, MAX_OUTPUT_LINES).map((line) => truncateDisplay(line, width));
  if (lines.length > MAX_OUTPUT_LINES) {
    visible.push(`[truncated ${lines.length - MAX_OUTPUT_LINES} lines]`);
  }
  return visible.filter((line) => line.trim().length > 0);
}
