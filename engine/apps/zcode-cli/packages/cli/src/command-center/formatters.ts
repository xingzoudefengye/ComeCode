import type { CommandCenterApp } from "./types.js";

export function formatResumeResult(
  sessionId: string,
  result: Awaited<ReturnType<CommandCenterApp["resume"]>>,
  model?: string,
): string {
  return [
    ...(result.warnings ?? []),
    `Resumed session ${sessionId}.`,
    `Directory: ${result.directory}`,
    ...(model?.trim() ? [`Model: ${model.trim()}`] : []),
    `Messages: ${result.appliedMessageCount}/${result.messageCount}; parts: ${result.partCount}; interrupted tools: ${result.interruptedToolCount}`,
  ].join("\n");
}

export function formatNewSessionResult(sessionId: string): string {
  return `Started new session ${sessionId}.`;
}
