// ============================================================
// Memory Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildMemorySection(
  memoryRoot: string | undefined,
  snapshotContent?: string,
): ContextSection | null {
  if (!memoryRoot) return null;

  const content = buildMemoryContent(memoryRoot, snapshotContent);

  return {
    name: "Project Memory",
    source: "memory",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildMemoryContent(memoryRoot: string, snapshotContent?: string): string {
  return [
    "# Project Memory",
    "",
    `Project memory lives in \`${memoryRoot}/\`. It is loaded once when this session starts and remains frozen until the next context refresh or new session.`,
    "",
    "Use these files only:",
    "- project.md: project purpose, architecture, conventions, and stable constraints.",
    "- decisions.md: confirmed decisions and their reasons, with absolute dates.",
    "- tasks.md: unfinished cross-session work; remove or archive completed items.",
    "- bugs.md: known problems, reproduction, and current workaround.",
    "- memory.md: other durable project facts that do not fit the categories above.",
    "",
    "Read an existing file before editing it. Use the normal Write/Edit tools so permission mode and visible diffs still apply. Do not store secrets, transient chat narration, or facts already obvious from the repository.",
    ...(snapshotContent
      ? ["", "## Loaded project memory snapshot", "", snapshotContent]
      : ["", "No project memory files have been created yet. Use `/init-memory` or create the files when the user asks."]),
  ].join("\n");
}
