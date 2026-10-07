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
  // 保持同一主题下的原生高亮样式身份稳定，避免无关状态刷新重新触发异步高亮。
  const syntaxStyle = React.useMemo(() => createMarkdownSyntaxStyle(theme), [theme]);
  if (!content) {
    return h("text", { style: { fg: textColor } }, "");
  }
  if (mode === "markdown") {
    if (syntaxStyle) {
      return h("markdown", {
        conceal: true,
        content: normalizeMarkdownBlankLines(content),
        streaming,
        syntaxStyle,
        // 顶层块独立渲染，保留列表、编号列表和嵌套列表的层级。
        internalBlockMode: "top-level",
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

function normalizeMarkdownBlankLines(content: string): string {
  const lines = content.split(/\r?\n/u);
  const normalized: string[] = [];
  let fenceMarker: string | undefined;
  let blankLines = 0;

  for (const line of lines) {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fenceMarker) {
      normalized.push(line);
      if (fence && fence[0] === fenceMarker[0] && fence.length >= fenceMarker.length) {
        fenceMarker = undefined;
      }
      continue;
    }
    if (fence) {
      blankLines = 0;
      normalized.push(line);
      fenceMarker = fence;
      continue;
    }

    if (line.trim().length === 0) {
      blankLines += 1;
      if (blankLines > 1) continue;
    } else {
      blankLines = 0;
    }
    normalized.push(line);
  }

  return normalized.join("\n");
}

/** 收敛普通 Markdown 的多余空行，代码围栏内部保持原样。 */
const renderCompactMarkdownNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
  const renderable = context.defaultRender();
  if (token.type === "paragraph" && renderable instanceof CodeRenderable) {
    renderable.content = token.raw.replace(/(?:\r?\n)+$/u, "");
    renderable.marginBottom = 0;
  }
  return renderable;
};
