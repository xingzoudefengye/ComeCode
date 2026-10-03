// Modified by ComeCode：去掉居中的大号 ZCODE 字符画，改为左上角三行欢迎区
//（品牌+版本 / 模型+思考档位 / 工作目录），品牌行用亮色突出，参考 Claude Code 的分行展示。
import { CLI_COMMAND } from "@zcode/contracts";
import React from "react";
import { palette } from "./app-model.js";
import { ShimmerText, useShimmerFrame } from "./app-motion.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const LOGO_LINES = [CLI_COMMAND] as const;

const EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT = LOGO_LINES.length;

export function EmptyTranscriptLogo({
  animated = false,
  model,
  version,
  effort,
  cwd,
}: {
  animated?: boolean;
  model?: string;
  version?: string;
  effort?: string;
  cwd?: string;
} = {}): React.ReactElement {
  if (animated) {
    return h(AnimatedEmptyTranscriptLogo, { model, version, effort, cwd });
  }
  return renderLogoContent({ animated: false, model, version, effort, cwd });
}

function AnimatedEmptyTranscriptLogo({
  model,
  version,
  effort,
  cwd,
}: {
  model?: string;
  version?: string;
  effort?: string;
  cwd?: string;
}): React.ReactElement {
  const frameMs = useShimmerFrame(true);
  return renderLogoContent({ animated: true, frameMs, model, version, effort, cwd });
}

function renderLogoContent(input: {
  animated: boolean;
  frameMs?: number;
  model?: string;
  version?: string;
  effort?: string;
  cwd?: string;
}): React.ReactElement {
  const versionText = input.version ? `v${input.version}` : "";
  const brandLine = versionText ? `${CLI_COMMAND} ${versionText}` : CLI_COMMAND;
  const modelText = input.model
    ? input.effort
      ? `${input.model} with ${input.effort} effort`
      : input.model
    : "";
  const lines: Array<{ key: string; text: string; color: string }> = [
    { key: `${CLI_COMMAND}-brand`, text: brandLine, color: palette.text },
    modelText ? { key: `${CLI_COMMAND}-model`, text: modelText, color: palette.muted } : undefined,
    input.cwd ? { key: `${CLI_COMMAND}-cwd`, text: input.cwd, color: palette.muted } : undefined,
  ].filter((line): line is { key: string; text: string; color: string } => Boolean(line));
  return h(
    "box",
    {
      style: {
        alignItems: "flex-start",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "flex-start",
        minHeight: EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT,
        width: "100%",
      },
    },
    ...lines.map((line) =>
      renderLogoText({
        animated: input.animated,
        baseColor: line.color,
        frameMs: input.frameMs,
        key: line.key,
        text: line.text,
      }),
    ),
  );
}

function renderLogoText(input: {
  animated: boolean;
  baseColor: string;
  frameMs?: number;
  key: string;
  text: string;
}): React.ReactElement {
  if (!input.animated) {
    return h("text", { key: input.key, style: { fg: input.baseColor } }, input.text);
  }
  return h(ShimmerText, {
    animated: true,
    baseColor: input.baseColor,
    frameMs: input.frameMs,
    highlightColor: palette.text,
    key: input.key,
    text: input.text,
  });
}
