import type { AgentRuntimeConfig } from "../types.js";
import { resolveWorkspaceProjectMemoryRoot } from "../../memory/project-files.js";
import { resolveUserMemoryRoot } from "../../memory/user-files.js";

export interface MemoryRoots {
  project?: string;
  user?: string;
}

export function resolveMemoryRoots(config: AgentRuntimeConfig, workspacePath: string): MemoryRoots {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false || !isMainMemoryTaskType(config.taskType)) {
    return {};
  }
  const project = resolveWorkspaceProjectMemoryRoot(workspacePath);
  const user = memory.cliStorageRoot ? resolveUserMemoryRoot(memory.cliStorageRoot) : undefined;
  const scope = memory.scope ?? "project";
  if (scope === "user") return user ? { user } : {};
  if (scope === "both") return { project, ...(user ? { user } : {}) };
  return { project };
}

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  return resolveMemoryRoots(config, workspacePath).project;
}

export function resolveEnabledUserMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  return resolveMemoryRoots(config, workspacePath).user;
}

export function resolveMemoryExtractionRoots(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string[] {
  const roots = resolveMemoryRoots(config, workspacePath);
  return [roots.project, roots.user].filter((root): root is string => root !== undefined);
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
