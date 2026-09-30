import { traceContextToLogContext, type TraceContext } from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { ExploreSubagentPortOptions } from "./runner.js";

const MAX_NOTIFICATION_ATTEMPTS = 3;
const NOTIFICATION_RETRY_DELAY_MS = 250;

export async function enqueueBackgroundNotification(
  options: ExploreSubagentPortOptions,
  registry: RuntimeTaskRegistry,
  taskId: string,
  message: string,
  traceContext: TraceContext,
): Promise<boolean> {
  if (!options.enqueueParentTaskNotification) return false;
  for (let attempt = 1; attempt <= MAX_NOTIFICATION_ATTEMPTS; attempt++) {
    const task = registry.get(taskId);
    // 重试属于原 run，不能给恢复后的新 run 标记 notified。
    if (!task || task.traceContext?.spanId !== traceContext.spanId) return false;
    if (task.notified) return true;
    try {
      options.enqueueParentTaskNotification({
        originMeta: {
          backgroundSource: "subagent",
          title: task.description.trim() || taskId,
          workId: taskId,
        },
        taskId,
        text: message,
        traceContext,
      });
      registry.update(taskId, (current) =>
        current.traceContext?.spanId === traceContext.spanId
          ? { ...current, notified: true }
          : current,
      );
      return true;
    } catch (error) {
      options.logger?.warn("Failed to enqueue subagent background notification", {
        ...traceContextToLogContext(traceContext),
        attempt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.background.notification.failed",
        module: "core.subagent",
        taskId,
      });
      if (attempt < MAX_NOTIFICATION_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, NOTIFICATION_RETRY_DELAY_MS));
      }
    }
  }
  return false;
}
