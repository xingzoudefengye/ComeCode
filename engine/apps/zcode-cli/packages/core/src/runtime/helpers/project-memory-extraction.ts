import { selectActiveConversationBranch, type TraceContext } from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  buildMemoryExtractionUserInput,
  createMemoryExtractionScheduler,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveMemoryRoots, resolveMemoryExtractionRoots } from "./project-memory.js";
import { PROJECT_MEMORY_FILES } from "../../memory/project-files.js";
import {
  MEMORY_AGENT_TIMEOUT_MS,
  type MemoryAgentAllowedRoot,
} from "../../memory/memory-agent-loop.js";
import { createRuntimeModel } from "../methods/runtime-model.js";

const EXTRACTION_MAX_TURNS = 3;
const EXTRACTION_DRAIN_TIMEOUT_MS = MEMORY_AGENT_TIMEOUT_MS;

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveMemoryExtractionRoots(this.config, this.workspaceRoot).length > 0;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    model: ProjectMemoryAgentContext["model"];
    traceContext: TraceContext;
    force?: boolean;
  },
): boolean {
  if (runtime.shuttingDown) return false;
  // 自动提取可以关闭；显式 /memory save 仍允许用户主动保存。
  if (runtime.config.memory?.extractionEnabled === false && input.force !== true) return false;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const roots = resolveMemoryRoots(runtime.config, runtime.workspaceRoot);
  const allowedRoots: MemoryAgentAllowedRoot[] = [
    ...(roots.project
      ? [{ rootDir: roots.project, kind: "project" as const, files: PROJECT_MEMORY_FILES }]
      : []),
    ...(roots.user
      ? [{ rootDir: roots.user, kind: "user" as const, files: ["profile.md", "preferences.md"] }]
      : []),
  ];
  const memoryRoot = allowedRoots[0]?.rootDir;
  if (!memoryRoot) return false;
  if (runtime.isRemoteWorkspace()) return false;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return false;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    allowedRoots,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return false;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
  return true;
}

export async function saveProjectMemory(
  this: AgentRuntimeInternal,
  traceContext: TraceContext = this.rootTraceContext,
): Promise<"saved" | "skipped" | "disabled"> {
  if (!isProjectMemoryEnabled.call(this)) return "disabled";
  const selection = this.getSessionModelSelection();
  if (!selection) return "disabled";
  const model = createRuntimeModel(this, { selection });
  const scheduled = scheduleProjectMemoryExtraction(this, {
    force: true,
    model,
    traceContext,
  });
  if (!scheduled) return "skipped";
  await drainMemoryExtractions.call(this, null);
  return this.memoryExtractionScheduler?.getCursor() === this.latestConversationMessageId
    ? "saved"
    : "skipped";
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // 显式保存、benchmark 与关闭都遵守相同总等待上限，超时要取消实际请求。
  const waitMs = Math.min(timeoutMs ?? EXTRACTION_DRAIN_TIMEOUT_MS, EXTRACTION_DRAIN_TIMEOUT_MS);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          scheduler.shutdown();
          resolve();
        }, waitMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      // 固定白名单无需扫描历史目录；仅 Read 工具加载真正需要修改的文件。
      const userInput = buildMemoryExtractionUserInput(input.snapshot.durableMessages);
      if (!userInput) return "no-op" as const;
      const prompt = buildMemoryExtractionPrompt({
        manifest: [],
        allowedRoots: input.snapshot.allowedRoots,
        messageCount: input.messageCount,
      });
      const context = { ...input.snapshot, userInput };
      const providerMessages = buildProjectMemoryAgentProviderMessages(runtime, context, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, context);

      await runMemoryAgentLoop({
        abortSignal: input.abortSignal,
        executeTool: (toolCall, options) =>
          executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: input.snapshot.traceContext,
          }),
        maxTurns: EXTRACTION_MAX_TURNS,
        messages: providerMessages,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        allowedRoots: input.snapshot.allowedRoots,
        tools: input.snapshot.tools,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      telemetry.finishCompleted();
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
