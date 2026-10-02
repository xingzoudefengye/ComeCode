import type { TuiSelection, TuiSubmitPromptResult } from "@zcode/tui";
import { thoughtLevelsToEffortOptions } from "../effort-options.js";
import { rememberCurrentModelSelection } from "../model-selection.js";
import type { CommandCenterDeps } from "../types.js";

const EFFORT_COMMAND_USAGE = "Use /effort <level>, /variant <level>, or /effort list.";

export async function handleEffortCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const current = app.getThoughtLevel?.();
  const levels = app.listThoughtLevels ? await app.listThoughtLevels() : undefined;
  const effortOptions = levels
    ? thoughtLevelsToEffortOptions(levels, app.getLocale?.())
    : undefined;

  if (!app.getThoughtLevel || !app.listThoughtLevels || !app.setThoughtLevel || !levels) {
    return {
      mode: deps.getMode?.(),
      response: "Reasoning effort selection is not available in this client.",
    };
  }

  if (levels.length === 0) {
    return {
      mode: deps.getMode?.(),
      response: "Reasoning effort selection is not available for the current model.",
      ...(effortOptions ? { effortOptions } : {}),
      thoughtLevel: current,
    };
  }

  const normalizedArgs = args.trim();

  if (normalizedArgs.length === 0 || normalizedArgs.toLowerCase() === "list") {
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: formatEffortList(current, levels),
      selection: buildEffortSelection(current, levels),
      thoughtLevel: current,
    };
  }

  const requested = resolveRequestedLevel(normalizedArgs, levels) ?? normalizedArgs;

  try {
    const result = await app.setThoughtLevel(requested);
    const persistenceWarning = await rememberCurrentModelSelection(app, deps);
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: `Reasoning effort switched to ${result.thoughtLevel}.${persistenceWarning}`,
      thoughtLevel: result.thoughtLevel,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      effortOptions,
      mode: deps.getMode?.(),
      response: `Unable to switch reasoning effort: ${message}. Available efforts: ${levels.join(", ")}.`,
      thoughtLevel: current,
    };
  }
}

function buildEffortSelection(
  current: string | undefined,
  levels: readonly string[],
): TuiSelection {
  const selectedIndex = Math.max(0, levels.findIndex((level) => level === current));
  return {
    emptyMessage: "No reasoning efforts available.",
    filterable: false,
    help: "Up/Down choose, Enter switches, Esc closes",
    items: levels.map((level) => ({
      command: `/effort ${level}`,
      id: level,
      meta: level === current ? "current" : undefined,
      primary: level,
    })),
    placement: "composer",
    prompt: "Select reasoning effort",
    selectedIndex,
    title: "Effort",
  };
}

function formatEffortList(current: string | undefined, levels: readonly string[]): string {
  return [
    `Current reasoning effort: ${current ?? "not selected"}.`,
    "Available reasoning efforts:",
    ...levels.map((level) => `- ${level}${level === current ? " (current)" : ""}`),
    EFFORT_COMMAND_USAGE,
  ].join("\n");
}

function resolveRequestedLevel(args: string, levels: readonly string[]): string | undefined {
  const requested = args.trim();
  return levels.find(
    (level) => level === requested || level.toLowerCase() === requested.toLowerCase(),
  );
}
