import { traceContextToLogContext, type Logger, type TraceContext } from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";

const LIFECYCLE_EFFECT_TIMEOUT_MS = 5_000;

// 终态是 registry 的事实；产物或投影失败只能降级，不能让任务重新变成 running。
export async function runSubagentLifecycleEffect(
  effect: () => Promise<void>,
  context: {
    agentId: string;
    effect: string;
    traceContext: TraceContext;
    logger?: Logger;
    registry?: RuntimeTaskRegistry;
  },
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const updatePending = (delta: number) =>
    context.registry?.update(context.agentId, (task) =>
      task.traceContext?.spanId === context.traceContext.spanId
        ? {
            ...task,
            pendingLifecycleEffects: Math.max(0, (task.pendingLifecycleEffects ?? 0) + delta),
          }
        : task,
    );
  if (
    context.registry &&
    context.registry.get(context.agentId)?.traceContext?.spanId !== context.traceContext.spanId
  )
    return false;
  updatePending(1);
  const execution = Promise.resolve().then(effect);
  // 等待超时不等于 I/O 退出，实际退出之前仍阻止同一 child 恢复。
  void execution.then(
    () => updatePending(-1),
    () => updatePending(-1),
  );
  try {
    await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Subagent lifecycle effect timed out")),
          LIFECYCLE_EFFECT_TIMEOUT_MS,
        );
      }),
    ]);
    return true;
  } catch (error) {
    context.logger?.warn("Subagent lifecycle effect failed", {
      ...traceContextToLogContext(context.traceContext),
      agentId: context.agentId,
      effect: context.effect,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.lifecycle_effect.failed",
      module: "core.subagent",
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
