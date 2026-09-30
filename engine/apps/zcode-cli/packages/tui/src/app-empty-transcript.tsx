// Modified by ComeCode：去掉居中的大号 ZCODE 字符画，改为左上角一行小字 "comecode"，保持低调。
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
}: {
  animated?: boolean;
} = {}): React.ReactElement {
  if (animated) {
    return h(AnimatedEmptyTranscriptLogo);
  }
  return renderLogoContent({ animated: false });
}

function AnimatedEmptyTranscriptLogo(): React.ReactElement {
  const frameMs = useShimmerFrame(true);
  return renderLogoContent({ animated: true, frameMs });
}

function renderLogoContent(input: { animated: boolean; frameMs?: number }): React.ReactElement {
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
    ...LOGO_LINES.map((line, index) =>
      renderLogoText({
        animated: input.animated,
        baseColor: palette.muted,
        frameMs: input.frameMs,
        key: `comecode-logo-${index}`,
        text: line,
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
