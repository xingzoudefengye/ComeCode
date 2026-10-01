import { CodeRenderable, type MarkdownOptions } from "@mbears/opentui-core";
import { baseComponents } from "@mbears/opentui-react";
import React from "react";
import { createMarkdownSyntaxStyle } from "./app-markdown-theme.js";
import { activeTuiTheme } from "./theme/index.js";

type MarkdownRenderMode = "markdown" | "code" | "plain";

type MarkdownTextProps = {
  backgroundColor?: string;
  content: string;
  foregroundColor?: string;
  mode?: MarkdownRenderMode;
  streaming?: boolean;
};

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

function detectMarkdownRenderMode(
  components: Record<string, unknown> = baseComponents,
): MarkdownRenderMode {
  if (typeof components.markdown === "function") return "markdown";
  if (typeof components.code === "function") return "code";
  return "plain";
}

export function MarkdownText({
  content,
  foregroundColor,
  mode = detectMarkdownRenderMode(),
  streaming = false,
}: MarkdownTextProps): React.ReactElement {
  const theme = activeTuiTheme();
  const textColor = foregroundColor ?? theme.markdownText;
  if (!content) {
    return h("text", { style: { fg: textColor } }, "");
  }

  const syntaxStyle = createMarkdownSyntaxStyle(theme);
  if (mode === "markdown") {
    if (syntaxStyle) {
      return h("markdown", {
        conceal: true,
        content,
        streaming,
        syntaxStyle,
        renderNode: renderCompactMarkdownNode,
      });
    }
    return h("text", { style: { fg: textColor } }, content);
  }

  if (mode === "code" && syntaxStyle) {
    return h("code", {
      conceal: true,
      content,
      drawUnstyledText: false,
      fg: textColor,
      filetype: "markdown",
      streaming,
      syntaxStyle,
    });
  }

  return h("text", { style: { fg: textColor } }, content);
}

/** 只压缩普通段落的布局换行，代码/列表等结构及原始回复不做字符串替换。 */
const renderCompactMarkdownNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
  const renderable = context.defaultRender();
  if (token.type === "paragraph" && renderable instanceof CodeRenderable) {
    renderable.content = token.raw.replace(/(?:\r?\n)+$/u, "");
    renderable.marginBottom = 0;
  }
  return renderable;
};
