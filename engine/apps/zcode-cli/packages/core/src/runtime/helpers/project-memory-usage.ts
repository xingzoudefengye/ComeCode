import type { Model, ModelRequest, SessionEvent, TraceContext } from "../deps.js";
import type { ModelApiOperation } from "@zcode/contracts";
import { createChildTraceContext, SessionEventType, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { withModelInvocationContext } from "../methods/runtime-model.js";
import { recordModelUsageFact } from "../methods/usage-observability.js";

export function createProjectMemoryUsageModel(
  runtime: AgentRuntimeInternal,
  baseModel: Model,
  input: { operation: ModelApiOperation; traceContext: TraceContext },
): Model {
  function invocationModel(
    request: ModelRequest,
    traceContext: TraceContext,
    events: SessionEvent[],
  ) {
    const model = baseModel.bind({ ...auxiliaryModelOptions(baseModel), ...request.options });
    return withModelInvocationContext(model, () => ({
      metadata: {
        ...traceContextToLogContext(traceContext),
        querySource: input.operation,
        skipTranscript: true,
      },
      modelRequestSessionType: "other",
      modelCall: {
        operation: input.operation,
        reasoning: { requestedLevel: model.options.reasoningLevel },
      },
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
        abortSignal: request.abortSignal,
        model,
        traceContext,
      }),
      statusSink: {
        publish: async (status) => {
          // 后台网络状态仅供本次统计，不追加主对话事件或改变主 turn 的用量。
          events.push(
            runtime.createEvent(SessionEventType.ModelNetworkStatus, status, traceContext),
          );
        },
      },
      traceContext,
    }));
  }

  return Object.freeze({
    ...baseModel,
    bind: (options) => createProjectMemoryUsageModel(runtime, baseModel.bind(options), input),
    async generateText(request) {
      const traceContext = createChildTraceContext(input.traceContext, {
        attributes: { querySource: input.operation },
      });
      const events: SessionEvent[] = [];
      const model = invocationModel(request, traceContext, events);
      const startedAt = Date.now();
      let result;
      try {
        result = await waitForModelResult(model.generateText(request), request.abortSignal);
      } catch (error) {
        await recordModelUsageFact(runtime, {
          error,
          events,
          model,
          networkEventStartIndex: 0,
          querySource: input.operation,
          startedAt,
          status: request.abortSignal?.aborted ? "cancelled" : "error",
          traceContext,
        });
        throw error;
      }
      await recordModelUsageFact(runtime, {
        events,
        model,
        networkEventStartIndex: 0,
        querySource: input.operation,
        result,
        startedAt,
        status: "completed",
        toolCallCount: result.toolCalls?.length ?? 0,
        traceContext,
      });
      return result;
    },
    streamText(request) {
      return invocationModel(request, input.traceContext, []).streamText(request);
    },
  } satisfies Model);
}

function waitForModelResult<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      cleanup();
    }
    void work.then(resolve, reject).finally(cleanup);
  });
}
