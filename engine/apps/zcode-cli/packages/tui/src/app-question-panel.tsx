import React from "react";
import type { TextareaRenderable } from "@mbears/opentui-core";
import type { QuestionPromptState } from "./app-model.js";
import { palette } from "./app-model.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function QuestionPanel({ state }: { state: QuestionPromptState }): React.ReactElement {
  if (state.reviewing) {
    return h(
      "box",
      {
        title: "Review answers",
        style: questionPanelStyle(),
      },
      ...state.input.questions.map((question) =>
        h(
          "text",
          { key: question.question, style: { fg: palette.text } },
          `${question.header}: ${state.answers[question.question] ?? "(not answered)"}`,
        ),
      ),
      h("text", { style: { fg: palette.muted } }, "Enter submits, Tab edits, Esc declines"),
    );
  }

  const question = state.input.questions[state.currentQuestionIndex];
  if (!question) {
    return h("box", { style: questionPanelStyle() });
  }

  if (state.editingOther) {
    return h(
      "box",
      {
        title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
        style: questionPanelStyle(),
      },
      h("text", { style: { fg: palette.text } }, question.question),
      h(OtherAnswerEditor, { value: state.otherBuffer }),
      h(
        "text",
        { style: { fg: palette.muted } },
        "Type custom answer. Enter accepts, Esc cancels.",
      ),
    );
  }

  const otherIndex = question.options.length;
  const otherValue = state.otherText[question.question];
  const selectedLabels = new Set(state.multiSelections[question.question] ?? []);
  const rows = [
    ...question.options.map((option, index) => ({
      description: option.description,
      label: option.label,
      selected: question.multiSelect
        ? selectedLabels.has(option.label)
        : state.selectedOptionIndex === index,
    })),
    {
      description: otherValue ?? "Type a custom answer",
      label: "Other",
      selected: question.multiSelect
        ? Boolean(otherValue && selectedLabels.has("Other"))
        : state.selectedOptionIndex === otherIndex,
    },
  ];

  return h(
    "box",
    {
      title: `Question ${state.currentQuestionIndex + 1}/${state.input.questions.length}: ${question.header}`,
      style: questionPanelStyle(),
    },
    h("text", { style: { fg: palette.text } }, question.question),
    ...rows.map((row, index) =>
      h(
        "text",
        {
          key: row.label,
          style: {
            fg: state.selectedOptionIndex === index ? palette.accent : palette.text,
          },
        },
        `${state.selectedOptionIndex === index ? ">" : " "} ${
          question.multiSelect ? (row.selected ? "[x]" : "[ ]") : row.selected ? "(*)" : "( )"
        } ${row.label} - ${row.description}`,
      ),
    ),
    h(
      "text",
      { style: { fg: palette.muted } },
      question.multiSelect
        ? "Space toggles, Enter reviews, s skips, o edits Other, Esc declines"
        : "Enter answers, s skips, o edits Other, Esc declines",
    ),
  );
}

function OtherAnswerEditor({ value }: { value: string }): React.ReactElement {
  const editor = React.useRef<TextareaRenderable | null>(null);
  React.useLayoutEffect(() => {
    if (!editor.current) return;
    // 提问状态机拥有回答，原生编辑器只镜像内容并提供正确位置的终端光标。
    editor.current.setText(value);
    editor.current.gotoBufferEnd();
  }, [value]);
  return h(
    "box",
    { style: { flexDirection: "row", width: "100%", height: 2 } },
    h("text", { style: { fg: palette.accent, flexShrink: 0 } }, "Other: "),
    h("textarea", {
      id: "question-other-editor",
      focused: true,
      initialValue: value,
      ref: editor,
      style: {
        height: 2,
        flexGrow: 1,
        wrapMode: "word",
        textColor: palette.accent,
        focusedTextColor: palette.accent,
        backgroundColor: palette.panel,
        focusedBackgroundColor: palette.panel,
      },
    }),
  );
}

function questionPanelStyle(): Record<string, unknown> {
  return {
    backgroundColor: palette.panel,
    border: true,
    borderColor: palette.warning,
    flexDirection: "column",
    height: 10,
    marginBottom: 1,
    padding: 1,
  };
}
