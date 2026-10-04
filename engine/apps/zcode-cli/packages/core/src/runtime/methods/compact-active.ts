import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  DEFAULT_COMPACT_CONTEXT_WINDOW,
  SessionEventType,
  createMessageId,
  createPartId,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
} from "../deps.js";
import type { SessionEvent, TraceContext, Model } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  buildPostCompactRuntimeEntries,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  throwIfTurnAborted,
  isTurnCancellationError,
} from "../helpers/index.js";
import { buildLocalCompactHandoff, MAX_LOCAL_HANDOFF_CHARS } from "../../compact/local-handoff.js";
import type { CompactTimelineContext } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  countContextPrefixMessages,
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { persistCompactTimelineEvent } from "./compact-active-helpers.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

const LOCAL_COMPACT_MAX_ATTEMPTS = 1;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: LOCAL_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const entriesToSummarize = getRuntimeEntriesToSummarize(activeEntries);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(activeEntries)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  try {
    throwIfTurnAborted(options.abortSignal);
    const modelTraceContext = turnTraceContext;
    const lastSummarizedMessageId = this.latestConversationMessageId;
    const prefixTokens = estimateRuntimeEntryTokens(
      activeEntries.slice(0, countContextPrefixMessages(activeEntries)),
      { useMidConversationSystem },
    );
    const configuredWindow = this.config.compact?.contextWindow;
    const window =
      configuredWindow && Number.isSafeInteger(configuredWindow) && configuredWindow > 0
        ? configuredWindow
        : (compactModel.properties.contextWindow ?? DEFAULT_COMPACT_CONTEXT_WINDOW);
    const maxChars = Math.max(
      256,
      Math.min(
        MAX_LOCAL_HANDOFF_CHARS,
        (options.autoCompactThreshold ?? Math.floor(window * 0.5)) - prefixTokens - 1_000,
      ),
    );
    const compactResult = buildLocalCompactHandoff({
      entries: activeEntries,
      customInstructions,
      sessionId: this.sessionId,
      maxChars,
    });
    const persistedSummary = compactResult.summary;
    const summaryMessageId = createMessageId();
    const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
      suppressFollowup: true,
      workGuide: compactResult.guide,
    });
    const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, {
      message: {
        role: "user",
        content: summaryMessageContent,
      },
      metadata: legacySyntheticRuntimeMetadata(),
    });
    const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
      useMidConversationSystem,
    });
    const providerPostCompactTokenCount = truePostCompactTokenCount;
    const compactBoundary = buildManualCompactBoundary({
      boundaryId: createCompactBoundaryId(),
      autoCompactThreshold: options.autoCompactThreshold,
      compactReason,
      customInstructions,
      lastSummarizedMessageId,
      phase,
      postCompactTokenCount: providerPostCompactTokenCount,
      preCompactTokenCount,
      summarizedMessageCount: entriesToSummarize.length,
      summaryMessageId,
      summarySource: "session_memory",
      traceContext: turnTraceContext,
      trigger,
      truePostCompactTokenCount,
      willRetriggerNextTurn:
        options.autoCompactThreshold !== undefined
          ? truePostCompactTokenCount >= options.autoCompactThreshold
          : undefined,
    });

    await this.persistCompactSummary(
      summaryMessageId,
      summaryMessageContent,
      persistedSummary,
      compactBoundary,
      modelTraceContext,
      {
        model: compactModel,
        operationId: compactTimeline.operationId,
      },
    );

    const compactBoundaryEvent = this.createEvent(
      SessionEventType.CompactBoundary,
      compactBoundary,
      turnTraceContext,
    );
    await this.appendEvent(compactBoundaryEvent, turnTraceContext);
    events.push(compactBoundaryEvent);

    const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      boundaryId: compactBoundary.boundaryId,
      endedAt: Date.now(),
      postCompactTokenCount: providerPostCompactTokenCount,
      replace: true,
      status: CompactTimelineStatus.Completed,
      summaryMessageId,
      tailStartMessageId: lastSummarizedMessageId,
      truePostCompactTokenCount,
    });
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      compactCompletedPayload,
      turnTraceContext,
      events,
    );

    this.latestConversationMessageId = summaryMessageId;
    const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
    this.messageHistory.replaceMessages(
      options.activeEntries
        ? preserveCanonicalContextPrefix(
            this.messageHistory.borrowReadOnlyRuntimeEntries(),
            recordablePostCompactEntries,
          )
        : recordablePostCompactEntries,
    );
    this.readFileState.clear();
    return {
      displayText: "Compacted",
      entries: postCompactEntries,
      outcome: "compacted",
      tokenCount: providerPostCompactTokenCount,
    };
  } catch (error) {
    await this.finishCompactTimelineFailure({
      abortSignal: options.abortSignal,
      error,
      events,
      timeline: compactTimeline,
      traceContext: turnTraceContext,
    });
    throw error;
  }
}
