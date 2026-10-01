import type { AgentRuntimeConfig } from "../types.js";
import { resolveWorkspaceProjectMemoryRoot } from "../../memory/project-files.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  return resolveWorkspaceProjectMemoryRoot(workspacePath);
}

function isMainMemoryTaskType(taskType: AgentRuntimeConfig["taskType"]): boolean {
  return (
    taskType === undefined ||
    taskType === "interactive" ||
    taskType === "fork" ||
    taskType === "selection_side_chat" ||
    taskType === "workflow_parent"
  );
}
