import type { ChronicleTurn } from "../../compact/chronicle.js";
import {
  appendUserMemoryChronicle,
  loadUserMemoryChronicle,
  type UserMemoryChronicle,
} from "../../memory/user-chronicle.js";
import { resolveEnabledUserMemoryRoot } from "./project-memory.js";
import type { AgentRuntimeInternal } from "../internal.js";

export {
  appendUserMemoryChronicle,
  loadUserMemoryChronicle,
  formatUserMemoryChronicle,
} from "../../memory/user-chronicle.js";
const MAX_TURN_TEXT_CHARS = 16_384;

export async function loadRuntimeUserMemoryChronicle(
  runtime: AgentRuntimeInternal,
): Promise<UserMemoryChronicle> {
  const root = resolveEnabledUserMemoryRoot(runtime.config, runtime.workingDirectory);
  if (!root || runtime.isRemoteWorkspace()) return { version: 1, entries: [] };
  return loadUserMemoryChronicle({ root });
}

/** 本地终态历史无需自动提取开关；关闭 Memory 时必须在任何 IO 前返回。 */
export async function persistUserMemoryChronicle(
  runtime: AgentRuntimeInternal,
  turn: ChronicleTurn,
): Promise<void> {
  const root = resolveEnabledUserMemoryRoot(runtime.config, runtime.workingDirectory);
  if (!root || !runtime.sessionPersisted || runtime.isRemoteWorkspace()) return;
  try {
    await appendUserMemoryChronicle({
      root,
      sessionId: runtime.sessionId,
      // Bash cd 只改变执行目录；匿名项目来源须绑定固定工作区身份。
      projectKey:
        runtime.config.memory?.workspaceIdentity?.trim() ||
        runtime.config.workspaceIdentity?.trim() ||
        runtime.workspaceRoot,
      turn: {
        ...turn,
        goal: turn.goal.slice(0, MAX_TURN_TEXT_CHARS),
        response: turn.response?.slice(0, MAX_TURN_TEXT_CHARS),
      },
    });
  } catch {
    runtime.logger?.warn("用户级跨项目史书保存失败；回合结果未改变", {
      event: "user_memory.chronicle.persistence_failed",
      module: "core.memory",
      status: "failed",
    });
  }
}
