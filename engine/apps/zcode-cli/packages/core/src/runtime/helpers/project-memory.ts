import type { AgentRuntimeConfig } from "../types.js";
import { resolveProjectMemoryRoot } from "../../memory/project-root.js";
import { resolveWorkspaceProjectMemoryRoot } from "../../memory/project-files.js";

export function resolveEnabledProjectMemoryRoot(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string | undefined {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false) return undefined;
  if (!isMainMemoryTaskType(config.taskType)) return undefined;

  const scope = memory.scope ?? "project";
  // both 模式：写入时用 resolveMemoryExtractionRoots() 写两边，读取时暂只读 project。
  if (scope === "user") {
    return memory.cliStorageRoot
      ? resolveProjectMemoryRoot({
          cliStorageRoot: memory.cliStorageRoot,
          workspaceIdentity: memory.workspaceIdentity,
          workspacePath,
        })
      : undefined;
  }
  return resolveWorkspaceProjectMemoryRoot(workspacePath);
}

export function resolveMemoryExtractionRoots(
  config: AgentRuntimeConfig,
  workspacePath: string,
): string[] {
  const memory = config.memory;
  if (!memory?.enabled || memory.use === false) return [];
  const scope = memory.scope ?? "project";
  const project = resolveWorkspaceProjectMemoryRoot(workspacePath);
  const user = memory.cliStorageRoot
    ? resolveProjectMemoryRoot({
        cliStorageRoot: memory.cliStorageRoot,
        workspaceIdentity: memory.workspaceIdentity,
        workspacePath,
      })
    : undefined;
  if (scope === "user") return user ? [user] : [];
  if (scope === "both") return user ? [project, user] : [project];
  return [project];
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
