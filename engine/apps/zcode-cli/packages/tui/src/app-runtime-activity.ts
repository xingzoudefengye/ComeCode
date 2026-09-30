import { SessionEventType as E, type SessionEvent } from "@zcode/contracts";
import React from "react";
import { isSubagentToolMirror } from "./app-subagent-events.js";

export type RuntimeActivity = {
  phase:
    | "idle"
    | "working"
    | "model"
    | "tool"
    | "waiting"
    | "retrying"
    | "compacting"
    | "completed"
    | "failed"
    | "cancelled";
  startedAt?: number;
  lastActivityAt?: number;
  turnId?: string;
  outputBytesByTool?: Record<string, number>;
  pendingConfirmations?: readonly string[];
};

const MAX_ACTIVITY_EVENT_IDS = 2_048;
export const STALE_ACTIVITY_WARNING_MS = 90_000;

export function projectRuntimeActivity(
  current: RuntimeActivity,
  event: SessionEvent,
  now: number,
): RuntimeActivity {
  const payload = event.payload as unknown as Record<string, unknown>;
  if (event.type === E.TurnStarted) {
    return { phase: "working", startedAt: now, lastActivityAt: now, turnId: event.turnId };
  }
  if (event.turnId && current.turnId && event.turnId !== current.turnId) return current;
  if (["completed", "failed", "cancelled"].includes(current.phase)) return current;
  let phase: RuntimeActivity["phase"] | undefined;
  switch (event.type) {
    case E.TurnComplete:
      phase =
        payload.resultType === "cancelled"
          ? "cancelled"
          : payload.resultType !== undefined && payload.resultType !== "success"
            ? "failed"
            : "completed";
      break;
    case E.TurnError:
      phase = "failed";
      break;
    case E.ModelRequest:
      phase = "model";
      break;
    case E.ModelStreaming:
      phase = "model";
      break;
    case E.ToolCallStarted:
      phase = payload.toolName === "AskUserQuestion" ? "waiting" : "tool";
      break;
    case E.ToolCallResult:
    case E.ToolCallError:
      phase = "working";
      break;
    case E.ToolCallProgress: {
      if (current.phase === "waiting") return current;
      const bytes =
        typeof payload.outputBytes === "number"
          ? payload.outputBytes
          : Number(payload.stdoutBytes ?? 0) + Number(payload.stderrBytes ?? 0);
      const id = String(payload.toolCallId);
      if (!Number.isFinite(bytes) || bytes <= (current.outputBytesByTool?.[id] ?? 0))
        return current;
      return {
        ...current,
        phase: "tool",
        lastActivityAt: now,
        outputBytesByTool: { ...current.outputBytesByTool, [id]: bytes },
      };
    }
    case E.PermissionRequested:
    case E.WorkspaceHookReviewRequested:
      phase = "waiting";
      break;
    case E.PermissionResolved:
    case E.PermissionDenied:
    case E.WorkspaceHookReviewSettled:
    case E.WorkspaceHookReviewSuperseded:
      phase = "working";
      break;
    case E.CompactStarted:
      phase = "compacting";
      break;
    case E.CompactCompleted:
    case E.CompactFailed:
      phase = "working";
      break;
    case E.ModelNetworkStatus:
      if (payload.type === "model_retry_scheduled" || payload.type === "model_request_queued")
        phase = "retrying";
      if (payload.type === "model_request_started") phase = "model";
      break;
  }
  const confirmations = new Set(current.pendingConfirmations);
  const toolId = String(payload.toolCallId ?? "permission");
  const hookRequest = payload.request as Record<string, unknown> | undefined;
  const hookId = `hook:${String(payload.interactionId ?? hookRequest?.interactionId ?? toolId)}`;
  if (event.type === E.PermissionRequested) confirmations.add(toolId);
  if (event.type === E.WorkspaceHookReviewRequested) confirmations.add(hookId);
  if (event.type === E.ToolCallStarted && payload.toolName === "AskUserQuestion")
    confirmations.add(toolId);
  if (
    event.type === E.PermissionResolved ||
    event.type === E.PermissionDenied ||
    event.type === E.ToolCallResult ||
    event.type === E.ToolCallError
  )
    confirmations.delete(toolId);
  if (event.type === E.WorkspaceHookReviewSettled || event.type === E.WorkspaceHookReviewSuperseded)
    confirmations.delete(hookId);
  if (!phase) return current;
  if (confirmations.size && !["completed", "failed", "cancelled"].includes(phase))
    phase = "waiting";
  return { ...current, phase, lastActivityAt: now, pendingConfirmations: [...confirmations] };
}

export function useRuntimeActivity(
  getMainSessionId?: () => string | undefined,
  observe?: (event: SessionEvent) => void,
) {
  const [activity, setActivity] = React.useState<RuntimeActivity>({ phase: "idle" });
  const seen = React.useRef(new Set<string>());
  const session = React.useRef<string | undefined>(undefined);
  const onEvent = React.useCallback(
    (event: SessionEvent) => {
      observe?.(event);
      const main = getMainSessionId?.();
      if (isSubagentToolMirror(event) || (main && event.sessionId !== main)) return;
      if (session.current !== main) {
        session.current = main;
        seen.current.clear();
        setActivity({ phase: "idle" });
      }
      if (seen.current.has(event.id)) return;
      seen.current.add(event.id);
      if (seen.current.size > MAX_ACTIVITY_EVENT_IDS)
        seen.current.delete(seen.current.values().next().value!);
      setActivity((current) => projectRuntimeActivity(current, event, Date.now()));
    },
    [getMainSessionId, observe],
  );
  return { activity, onEvent };
}
