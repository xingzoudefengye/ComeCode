import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import type { ContextUsage } from "./app-model.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { palette } from "./app-model.js";
import { modelDisplayParts } from "./app-model-ref.js";
import { spinnerFrame, useSpinnerFrame } from "./app-motion.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import { STALE_ACTIVITY_WARNING_MS, type RuntimeActivity } from "./app-runtime-activity.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const ACTIVE_STATUS_HEIGHT = 1;
const ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH = 1;
const ACTIVE_STATUS_CONTEXT_SPACER_WIDTH = 1;
const COMPOSER_STATUS_HEIGHT = 1;
const COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH = 0;
const COMPOSER_STATUS_MIN_METADATA_WIDTH = 8;
const STATUS_MIN_CONTEXT_WIDTH = 4;
const COMPOSER_STATUS_FALLBACK_WIDTH = 80;
const COMPOSER_STATUS_MIN_CONTENT_WIDTH = 8;
const TOKEN_COUNT_KILO = 1_000;
const TOKEN_COUNT_MEGA = TOKEN_COUNT_KILO * TOKEN_COUNT_KILO;
const TOKEN_COUNT_DECIMAL_PLACES = 1;

export function InputActiveStatus({
  active,
  contentWidth,
  contextUsage,
  copy = DEFAULT_TUI_COPY,
  frameMs,
  runtimeActivity,
  backgroundCount,
  cacheHitRate,
  mode,
  model,
  sessionId,
  thoughtLevel,
}: {
  active: boolean;
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy?: TuiCopy;
  frameMs?: number;
  runtimeActivity?: RuntimeActivity;
  backgroundCount?: number;
  cacheHitRate?: number;
  mode?: string;
  model?: string;
  sessionId?: string;
  thoughtLevel?: string;
}): React.ReactElement {
  const terminal =
    runtimeActivity && ["completed", "failed", "cancelled"].includes(runtimeActivity.phase);
  const running =
    !terminal &&
    (active || (runtimeActivity?.startedAt !== undefined && runtimeActivity.phase !== "idle"));
  const details = {
    runtimeActivity,
    backgroundCount,
    cacheHitRate,
    composerLabel: composerStatusLabel(mode, model, sessionId, thoughtLevel),
  };
  if (frameMs !== undefined || !running) {
    return inputActiveStatusRow(copy, running ? spinnerFrame(frameMs ?? 0) : undefined, {
      contentWidth,
      contextUsage,
      ...details,
    });
  }
  return h(InputActiveStatusContent, { contentWidth, contextUsage, copy, ...details });
}

function InputActiveStatusContent({
  contentWidth,
  contextUsage,
  copy,
  runtimeActivity,
  backgroundCount,
  cacheHitRate,
  composerLabel,
}: {
  contentWidth?: number;
  contextUsage?: ContextUsage;
  copy: TuiCopy;
  runtimeActivity?: RuntimeActivity;
  backgroundCount?: number;
  cacheHitRate?: number;
  composerLabel?: string;
}): React.ReactElement {
  return inputActiveStatusRow(copy, useSpinnerFrame(true), {
    contentWidth,
    contextUsage,
    runtimeActivity,
    backgroundCount,
    cacheHitRate,
    composerLabel,
  });
}

export function InputComposerStatus({
  contentWidth,
  mode,
  model,
  sessionId,
  thoughtLevel,
}: {
  contentWidth?: number;
  mode?: string;
  model: string;
  sessionId?: string;
  thoughtLevel: string;
}): React.ReactElement {
  const maxWidth = composerStatusMetadataWidth(contentWidth);
  const modelParts = modelDisplayParts(model);
  const modelLabel =
    modelParts.provider === "-" ? modelParts.model : `${modelParts.provider}/${modelParts.model}`;
  const modeLabel = mode ? `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}` : "-";
  const thoughtLabel = thoughtLevel.trim() || "default";
  const sessionLabel = sessionId ? shortenSessionId(sessionId) : "session";
  const status = truncateDisplay(
    `${modeLabel} | ${modelLabel} | ${thoughtLabel} | ${sessionLabel}`,
    maxWidth,
  );
  return h(
    "box",
    { style: { alignItems: "center", flexDirection: "row", height: COMPOSER_STATUS_HEIGHT, width: "100%" } },
    h("text", { style: { fg: palette.text, flexShrink: 1 } }, status),
  );
}

function composerStatusLabel(
  mode?: string,
  model?: string,
  sessionId?: string,
  thoughtLevel?: string,
): string | undefined {
  if (!model && !mode && !sessionId && !thoughtLevel) return undefined;
  const modelParts = model ? modelDisplayParts(model) : undefined;
  const modelLabel = modelParts
    ? modelParts.provider === "-"
      ? modelParts.model
      : `${modelParts.provider}/${modelParts.model}`
    : "-";
  const modeLabel = mode ? `${mode.slice(0, 1).toUpperCase()}${mode.slice(1)}` : "-";
  const thoughtLabel = thoughtLevel?.trim() || "default";
  const sessionLabel = sessionId ? shortenSessionId(sessionId) : "session";
  return `${modeLabel} | ${modelLabel} | ${thoughtLabel} | ${sessionLabel}`;
}

function inputActiveStatusRow(
  copy: TuiCopy,
  frame?: string,
  options: {
    contentWidth?: number;
    contextUsage?: ContextUsage;
    runtimeActivity?: RuntimeActivity;
    backgroundCount?: number;
    cacheHitRate?: number;
    composerLabel?: string;
  } = {},
): React.ReactElement {
  const activity = options.runtimeActivity;
  const now = Date.now();
  const idleMs =
    activity?.lastActivityAt === undefined ? 0 : Math.max(0, now - activity.lastActivityAt);
  const running = frame !== undefined;
  const phase =
    activity?.phase === "idle" && running
      ? "working"
      : (activity?.phase ?? (running ? "working" : "idle"));
  const label = [
    copy.input.runtimePhase[phase],
    ...(running && activity?.startedAt
      ? [copy.input.runtimeElapsed(Math.floor((now - activity.startedAt) / 1_000))]
      : []),
    ...(running && activity?.lastActivityAt && phase !== "waiting"
      ? [
          idleMs >= STALE_ACTIVITY_WARNING_MS
            ? copy.input.runtimeStale
            : copy.input.runtimeLastActivity(Math.floor(idleMs / 1_000)),
        ]
      : []),
    ...(options.backgroundCount ? [copy.input.runtimeBackground(options.backgroundCount)] : []),
  ].join(" | ");
  const combinedLabel = options.composerLabel
    ? `${options.composerLabel} | ${label}`
    : label;
  const contextLabel = [
    inputContextUsageBadge(options.contextUsage),
    ...(options.contextUsage?.compactThreshold !== undefined
      ? [copy.input.compactAt(formatCompactTokenCount(options.contextUsage.compactThreshold))]
      : []),
    ...(options.cacheHitRate !== undefined
      ? [copy.input.cacheHit(Math.round(options.cacheHitRate * 100))]
      : []),
  ]
    .filter(Boolean)
    .join(" | ");
  const rowWidth =
    normalizeComposerStatusContentWidth(options.contentWidth) -
    ACTIVE_STATUS_HORIZONTAL_PADDING_WIDTH;
  const metadataWidth = Math.min(displayWidth(contextLabel), Math.floor(rowWidth * 0.45));
  const contextBadge = fitStatusContextBadge(contextLabel || undefined, metadataWidth);
  const labelWidth = Math.max(
    0,
    rowWidth -
      (contextBadge ? displayWidth(contextBadge) + ACTIVE_STATUS_CONTEXT_SPACER_WIDTH : 0) -
      (frame ? displayWidth(frame) + 1 : 0),
  );
  return h(
    "box",
    {
      style: {
        flexDirection: "row",
        height: ACTIVE_STATUS_HEIGHT,
        paddingLeft: 1,
        width: "100%",
      },
    },
    h(
      "box",
      { style: { flexDirection: "row", flexShrink: 0 } },
      frame
        ? h(
            "text",
            { style: { fg: palette.accent, flexShrink: 0, width: displayWidth(frame) } },
            frame,
          )
        : null,
      frame ? h("text", { style: { fg: palette.muted } }, " ") : null,
      h(
        "text",
        {
          style: {
            fg:
              idleMs >= STALE_ACTIVITY_WARNING_MS && running && phase !== "waiting"
                ? palette.warning
                : palette.muted,
          },
        },
            truncateDisplay(combinedLabel, labelWidth),
      ),
    ),
    contextBadge ? h("box", { style: { flexGrow: 1, minWidth: 1 } }) : null,
    contextBadge ? h("text", { style: { fg: palette.muted, flexShrink: 0 } }, contextBadge) : null,
  );
}

function shortenSessionId(sessionId: string): string {
  const value = sessionId.trim();
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
}

function inputContextUsageBadge(contextUsage?: ContextUsage): string | undefined {
  const used = contextUsage?.contextUsed;
  if (!validContextTokenCount(used)) return undefined;

  const usedLabel = formatCompactTokenCount(used);
  const window = contextUsage?.contextWindow;
  if (!validContextWindow(window)) return usedLabel;

  return `${usedLabel}/${formatCompactTokenCount(window)} (${formatComposerPercent(used / window)})`;
}

function composerStatusMetadataWidth(contentWidth?: number): number {
  const rowWidth = normalizeComposerStatusContentWidth(contentWidth);
  return Math.max(
    COMPOSER_STATUS_MIN_METADATA_WIDTH,
    rowWidth - COMPOSER_STATUS_HORIZONTAL_PADDING_WIDTH,
  );
}

function fitStatusContextBadge(
  contextBadge: string | undefined,
  maxWidth?: number,
): string | undefined {
  if (contextBadge === undefined) return undefined;
  if (maxWidth === undefined || !Number.isFinite(maxWidth)) return contextBadge;
  if (maxWidth < STATUS_MIN_CONTEXT_WIDTH) return undefined;
  return truncateDisplay(contextBadge, Math.floor(maxWidth));
}

function normalizeComposerStatusContentWidth(contentWidth?: number): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return COMPOSER_STATUS_FALLBACK_WIDTH;
  }
  return Math.max(COMPOSER_STATUS_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}

function formatCompactTokenCount(value: number): string {
  if (value < TOKEN_COUNT_KILO) return String(Math.round(value));
  if (value < TOKEN_COUNT_MEGA) return `${formatCompactDecimal(value / TOKEN_COUNT_KILO)}K`;
  return `${formatCompactDecimal(value / TOKEN_COUNT_MEGA)}M`;
}

function formatCompactDecimal(value: number): string {
  return value.toFixed(TOKEN_COUNT_DECIMAL_PLACES).replace(/\.0$/u, "");
}

function formatComposerPercent(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value * 100)}%`;
}

function validContextTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function validContextWindow(value: number | undefined): value is number {
  return validContextTokenCount(value) && value > 0;
}
