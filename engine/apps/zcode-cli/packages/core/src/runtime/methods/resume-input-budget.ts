import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  estimateMessageTokens,
  estimateTokens,
  getAutoCompactThreshold,
  traceContextToLogContext,
} from "../deps.js";
import type { Model, ModelToolContract, SessionEvent, TraceContext } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  countContextPrefixMessages,
  systemReminderAttachmentEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import {
  buildPlanModeExitReminderBody,
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildRuntimeProviderRequestMessages,
  buildTodoReminderBody,
  hasEnoughRuntimeEntriesToCompact,
  shouldBuildTodoReminder,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { estimateCurrentModelInputTokens } from "./compact.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";

export const DEFAULT_RESUME_INPUT_TOKEN_THRESHOLD = 51_200;

export function resolveResumeInputTokenThreshold(
  config: AgentRuntimeConfig["compact"],
  model: Model,
): number {
  if (config?.enabled === false || config?.resumeInputTokenThreshold === 0) return 0;
  const requested = config?.resumeInputTokenThreshold;
  const threshold =
    requested !== undefined && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : DEFAULT_RESUME_INPUT_TOKEN_THRESHOLD;
  return Math.min(
    threshold,
    getAutoCompactThreshold({
      contextWindow: model.properties.contextWindow,
      ...config,
      maxOutputTokens: resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
      }),
    }),
  );
}

export function estimateResumedRequestInputTokens(
  runtime: Pick<AgentRuntimeInternal, "config">,
  entries: readonly RuntimeMessageEntry[],
  model: Model,
  tools: readonly ModelToolContract[],
): number {
  const projection = buildRuntimeProviderRequestMessages(runtime, {
    entries,
    model,
    applyCacheControl: false,
  });
  const toolTokens = tools.reduce(
    (total, tool) =>
      total +
      estimateTokens(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          strict: tool.strict,
          providerNative: tool.providerNative,
        }),
      ),
    0,
  );
  // 冷恢复没有旧工具定义基线；保守加算当前工具，避免旧 usage 掩盖新增 schema 开销。
  return (
    Math.max(
      estimateCurrentModelInputTokens(projection.messages, projection.sourceEntries),
      estimateMessageTokens(projection.messages),
    ) + toolTokens
  );
}

export async function compactResumedHistoryIfNeeded(
  runtime: AgentRuntimeInternal,
  input: {
    historicalEntries?: readonly RuntimeMessageEntry[];
    pendingEntries: readonly RuntimeMessageEntry[];
    model: Model;
    toolDisallowlist?: readonly string[];
    traceContext: TraceContext;
    events: SessionEvent[];
    abortSignal?: AbortSignal;
    outputStyle?: AgentRuntimeConfig["outputStyle"];
  },
): Promise<void> {
  if (!runtime.resumeInputBudgetPending) return;
  throwIfTurnAborted(input.abortSignal);
  const threshold = resolveResumeInputTokenThreshold(runtime.config.compact, input.model);
  if (
    runtime.config.compact?.enabled === false ||
    runtime.config.compact?.resumeInputTokenThreshold === 0
  ) {
    runtime.resumeInputBudgetPending = false;
    return;
  }
  await runtime.initializeMcp(input.traceContext);
  throwIfTurnAborted(input.abortSignal);
  const tools = runtime
    .getTools(input.model)
    .filter((tool) => !input.toolDisallowlist?.includes(tool.name));
  const currentEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const historicalEntries = input.historicalEntries ?? currentEntries;
  const historicalMembers = new Set(historicalEntries);
  const currentTurnEntries = currentEntries
    .slice(countContextPrefixMessages(currentEntries))
    .filter((entry) => !historicalMembers.has(entry));
  const previewEntries = [...currentEntries, ...input.pendingEntries];
  const reminders = [
    runtime.needsPlanModeExitReminder ? buildPlanModeExitReminderBody() : null,
    buildRuntimeModeReminderBody(previewEntries, runtime.getMode(), runtime.getPlanEnabled()),
    buildRuntimeOutputStyleReminderBody(input.outputStyle),
  ];
  if (tools.some((tool) => tool.name === "TodoWrite") && shouldBuildTodoReminder(previewEntries)) {
    reminders.push(
      buildTodoReminderBody(await runtime.readSessionTodosForContext(input.traceContext)),
    );
  }
  previewEntries.push(
    ...reminders
      .filter((body): body is string => Boolean(body))
      .map((body) => systemReminderAttachmentEntry("diagnostics", body)),
  );
  const tokenCount = estimateResumedRequestInputTokens(runtime, previewEntries, input.model, tools);
  const logContext = {
    ...traceContextToLogContext(input.traceContext),
    module: "core.runtime",
    inputTokens: tokenCount,
    thresholdTokens: threshold,
  };
  if (tokenCount < threshold || !hasEnoughRuntimeEntriesToCompact(historicalEntries)) {
    runtime.logger?.info("Resume input budget checked", {
      ...logContext,
      event: "session.resume.input_budget.skipped",
      reason: tokenCount < threshold ? "below_threshold" : "not_enough_history",
    });
    throwIfTurnAborted(input.abortSignal);
    runtime.resumeInputBudgetPending = false;
    return;
  }
  runtime.logger?.info("Resume input budget compact started", {
    ...logContext,
    event: "session.resume.input_budget.started",
  });
  // 新输入尚未保存，压缩边界只覆盖恢复历史；随后按原路径完整写入输入及附件。
  const result = await runtime.compactActiveConversation(
    undefined,
    input.traceContext,
    input.events,
    {
      activeEntries: historicalEntries,
      model: input.model,
      abortSignal: input.abortSignal,
      trigger: CompactTrigger.Auto,
      phase: CompactPhase.PreRequest,
      compactReason: CompactReason.ContextLimit,
      autoCompactThreshold: threshold,
    },
  );
  // 交接只替换冻结历史，本轮已注入约束按原顺序完整回接，取消检查也不能先丢掉它们。
  if (result.outcome === "compacted") runtime.messageHistory.addEntries(currentTurnEntries);
  throwIfTurnAborted(input.abortSignal);
  runtime.resumeInputBudgetPending = false;
  runtime.logger?.info("Resume input budget compact completed", {
    ...logContext,
    event: "session.resume.input_budget.completed",
  });
}
