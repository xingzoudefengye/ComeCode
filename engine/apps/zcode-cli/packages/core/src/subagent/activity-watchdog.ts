import {
  AgentErrorCode,
  CoreErrorType,
  SessionEventType,
  createCoreError,
  traceContextToLogContext,
  type Logger,
  type SessionEvent,
  type SubagentRunRequest,
  type TraceContext,
} from "@zcode/contracts";

export interface SubagentActivityWatchdog {
  reportActivity(event?: SessionEvent): void;
  start(): void;
  stop(): void;
}

export function createSubagentActivityWatchdog(options: {
  abort(reason?: unknown): void;
  lifecycle: { agentId: string; runTraceContext: TraceContext };
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): SubagentActivityWatchdog {
  let running = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmations = new Set<string>();
  const outputBytes = new Map<string, number>();

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const stop = () => {
    running = false;
    clearTimer();
    options.signal.removeEventListener("abort", stop);
  };
  const schedule = () => {
    clearTimer();
    if (!running || confirmations.size || options.signal.aborted) return;
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return;
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        timeoutMs: options.timeoutMs,
      });
      options.abort(error);
    }, options.timeoutMs);
  };

  const reportActivity = (event?: SessionEvent) => {
    // 结算后到达的旧事件不能重新启动监测；等待人工确认也不属于执行停滞。
    if (!running || options.signal.aborted) return;
    const payload = (event?.payload ?? {}) as Record<string, unknown>;
    const toolId = String(payload.toolCallId ?? "permission");
    const hookRequest = payload.request as Record<string, unknown> | undefined;
    const hookId = `hook:${String(payload.interactionId ?? hookRequest?.interactionId ?? toolId)}`;
    if (event?.type === SessionEventType.PermissionRequested) confirmations.add(toolId);
    if (event?.type === SessionEventType.WorkspaceHookReviewRequested) confirmations.add(hookId);
    if (
      event?.type === SessionEventType.ToolCallStarted &&
      payload.toolName === "AskUserQuestion"
    ) {
      confirmations.add(toolId);
    }
    if (
      event?.type === SessionEventType.PermissionResolved ||
      event?.type === SessionEventType.PermissionDenied
    ) {
      confirmations.delete(toolId);
    }
    if (
      event?.type === SessionEventType.WorkspaceHookReviewSettled ||
      event?.type === SessionEventType.WorkspaceHookReviewSuperseded
    ) {
      confirmations.delete(hookId);
    }
    if (
      event?.type === SessionEventType.ToolCallResult ||
      event?.type === SessionEventType.ToolCallError
    ) {
      confirmations.delete(toolId);
      outputBytes.delete(toolId);
    }
    if (event?.type === SessionEventType.ToolCallProgress) {
      const bytes =
        typeof payload.outputBytes === "number"
          ? payload.outputBytes
          : Number(payload.stdoutBytes ?? 0) + Number(payload.stderrBytes ?? 0);
      // 仅更新时间的心跳不算新进展，否则卡住的工具会永远续期。
      if (!Number.isFinite(bytes) || bytes <= (outputBytes.get(toolId) ?? 0)) return;
      outputBytes.set(toolId, bytes);
    }
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: () => {
      running = true;
      options.signal.addEventListener("abort", stop, { once: true });
      reportActivity();
    },
    stop,
  };
}
