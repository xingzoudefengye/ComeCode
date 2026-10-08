import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { ThoughtTranscriptPart } from "./app-model.js";
import { palette } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { activeTuiTheme } from "./theme/index.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const COLLAPSED_MARKER = "+";
const EXPANDED_MARKER = "-";

// 一个回合的每个 step 都会产出一条 reasoning part，而完成的工具行是隐藏的，
// 逐条渲染会让对话里出现一串完全相同的 “+ Thought”。同一段连续思考只保留一行，
// 展开后按顺序显示该组内的全部思考正文。
export function ThoughtRunView({
  copy = DEFAULT_TUI_COPY,
  parts,
}: {
  copy?: TuiCopy;
  parts: ThoughtTranscriptPart[];
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  return h(ThoughtRunFrame, {
    copy,
    expanded,
    onToggle: () => setExpanded((current) => !current),
    parts,
  });
}

function ThoughtRunFrame({
  copy = DEFAULT_TUI_COPY,
  expanded,
  onToggle,
  parts,
}: {
  copy?: TuiCopy;
  expanded: boolean;
  onToggle: () => void;
  parts: ThoughtTranscriptPart[];
}): React.ReactElement {
  const thinking = parts.some((part) => part.status === "thinking");
  const label = thoughtPlaceholderLabel(thinking, copy);
  const theme = activeTuiTheme();
  const marker = expanded ? EXPANDED_MARKER : COLLAPSED_MARKER;

  return h(
    "box",
    {
      onMouseUp: onToggle,
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginBottom: 0,
        marginTop: 0,
        width: "100%",
      },
    },
    h(
      "text",
      {
        selectable: false,
        style: { fg: thinking ? palette.accent : theme.info },
      },
      `${marker} ${label}`,
    ),
    ...(expanded
      ? parts.map((part, index) =>
          h(
            "box",
            {
              key: `thought-content-${index}`,
              style: {
                backgroundColor: "transparent",
                flexDirection: "column",
                marginTop: index > 0 ? 1 : 0,
                width: "100%",
              },
            },
            h(
              "text",
              {
                style: { fg: theme.textMuted, width: "100%", wrapMode: "word" },
              },
              part.text.trim(),
            ),
          ),
        )
      : []),
  );
}

function thoughtPlaceholderLabel(thinking: boolean, copy: TuiCopy): string {
  return thinking ? copy.transcript.thought.thinking : copy.transcript.thought.complete;
}
