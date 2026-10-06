import type { Model, ModelInputMessage, ModelToolContract, TraceContext } from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { sanitizeChronicleText } from "../../compact/chronicle.js";
import { withShortFileTransaction } from "../../memory/file-transaction.js";
import { join, relative } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemReadTextResult,
} from "@zcode/contracts";
import {
  resolveAllowedMemoryAgentPath,
  type MemoryAgentAllowedRoot,
} from "../../memory/memory-agent-loop.js";
import { MEMORY_EXTRACTION_MAX_INPUT_CHARS } from "../../memory/extraction.js";
import { rollMemoryMarkdown } from "../../memory/project-files.js";

import { createRuntimeModel } from "../methods/runtime-model.js";
import { createProjectMemoryUsageModel } from "./project-memory-usage.js";

export interface ProjectMemoryAgentContext {
  causation?: AgentTelemetryCausation;
  memoryRoot: string;
  allowedRoots?: readonly MemoryAgentAllowedRoot[];
  userInput?: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    allowedRoots?: readonly MemoryAgentAllowedRoot[];
    userInput?: string;
    /** Extraction 继承产生该工作的 Turn Model。 */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = createProjectMemoryUsageModel(runtime, baseModel, input);
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    memoryRoot: input.memoryRoot,
    allowedRoots: input.allowedRoots,
    providerEntries: [],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(),
    tools: runtime
      .getTools(model)
      .filter((tool) => ["Read", "Write", "Edit"].includes(tool.name))
      .map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

const MEMORY_EXTRACTION_TOOL_HEADROOM_CHARS = 5000;

export function buildProjectMemoryAgentProviderMessages(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  prompt: string,
): ModelInputMessage[] {
  return [
    {
      role: "system",
      content: prompt.slice(
        0,
        MEMORY_EXTRACTION_MAX_INPUT_CHARS - MEMORY_EXTRACTION_TOOL_HEADROOM_CHARS,
      ),
    },
    {
      role: "user",
      content: (context.userInput ?? "").slice(
        0,
        Math.max(
          0,
          MEMORY_EXTRACTION_MAX_INPUT_CHARS - prompt.length - MEMORY_EXTRACTION_TOOL_HEADROOM_CHARS,
        ),
      ),
    },
  ];
}

export function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  const guarded = createMemoryExtractionFileSystem(runtime.fileSystemPort!, context);
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: guarded,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // 提取不继承旧会话 Read；模型必须在本次有界请求看到文件版本。
    readFileState: new Map(),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}

const MAX_USER_FILE_CHARS = 2000;
const MAX_USER_TOTAL_CHARS = 4000;
const MAX_MEMORY_READ_BYTES = 64_000;

/** 工具层保留原权限流程；文件端口在短锁内比较模型见过的版本，冲突直接停止。 */
export function createMemoryExtractionFileSystem(
  port: FileSystemPort,
  context: Pick<
    ProjectMemoryAgentContext,
    "allowedRoots" | "memoryRoot" | "workingDirectory" | "workspaceRoot" | "userInput"
  >,
): FileSystemPort {
  const seen = new Map<string, FileSystemReadTextResult>();
  const roots = context.allowedRoots ?? [
    {
      rootDir: context.memoryRoot,
      kind: "project" as const,
      files: ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"],
    },
  ];
  let stopped = false;
  const allowed = async (path: string, name: string) => {
    if (stopped) throw new Error("Memory extraction stopped after unsafe or stale write");
    const resolved = await resolveAllowedMemoryAgentPath({
      ...context,
      allowedRoots: roots,
      toolCall: { id: "memory-path", name, input: { file_path: path } },
    });
    if (!resolved) throw new Error("Memory extraction path is outside approved files");
    return resolved;
  };
  return new Proxy(port, {
    get(target, key) {
      if (key === "readTextFileRange")
        return async (
          request: Parameters<FileSystemPort["readTextFileRange"]>[0],
          options?: { signal?: AbortSignal },
        ) => {
          const path = await allowed(request.path, "Read");
          const full = await port.readTextFile({ path, maxBytes: MAX_MEMORY_READ_BYTES }, options);
          const read = await port.readTextFileRange(
            { ...request, path, maxBytes: MAX_MEMORY_READ_BYTES },
            options,
          );
          if (full.revision?.id !== read.revision?.id || full.truncated)
            throw new Error("Memory changed while reading");
          const root = roots.find((item) =>
            item.files.some((file) => join(item.rootDir, file) === path),
          );
          const readLimit = root?.kind === "user" ? MAX_USER_FILE_CHARS : 3000;
          if (
            !request.offsetLine &&
            !request.limitLines &&
            full.content.length <= readLimit &&
            full.content.length + full.content.split("\n").length * 6 <= 3500
          )
            seen.set(path, full);
          return read;
        };
      if (key === "readTextFile")
        return async (
          request: Parameters<FileSystemPort["readTextFile"]>[0],
          options?: { signal?: AbortSignal },
        ) => {
          const path = await allowed(request.path, "Read");
          // Write/Edit 内部重读不能更新 seen：它不等于模型已见过该版本。
          return port.readTextFile({ ...request, path, maxBytes: MAX_MEMORY_READ_BYTES }, options);
        };
      if (key === "writeTextFile")
        return async (
          request: Parameters<FileSystemPort["writeTextFile"]>[0],
          options?: { signal?: AbortSignal },
        ) => {
          try {
            const path = await allowed(request.path, "Write");
            const root = roots.find((item) =>
              item.files.some((file) => join(item.rootDir, file) === path),
            )!;
            const lockFile = root.kind === "user" ? join(root.rootDir, ".stable-memory") : path;
            if (root.kind === "user") {
              for (const file of root.files) await allowed(join(root.rootDir, file), "Read");
            }
            return await withShortFileTransaction(lockFile, async () => {
              options?.signal?.throwIfAborted();
              await allowed(path, "Write");
              let current: FileSystemReadTextResult | undefined;
              try {
                current = await port.readTextFile(
                  { path, maxBytes: MAX_MEMORY_READ_BYTES },
                  options,
                );
              } catch (error) {
                if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
              }
              const previous = seen.get(path);
              if (
                current &&
                (!previous ||
                  previous.content !== current.content ||
                  !previous.revision ||
                  previous.revision.id !== current.revision?.id)
              )
                throw new Error(
                  "Memory revision changed or was not fully read; extraction stopped",
                );
              if (!current && previous) throw new Error("Memory file was removed after read");
              let content = request.content;
              if (root.kind === "user") {
                content = validateStableUserMemory(content, context.userInput ?? "");
                let sibling = "";
                for (const file of root.files) {
                  const siblingPath = join(root.rootDir, file);
                  await allowed(siblingPath, "Read");
                  if (siblingPath === path) continue;
                  try {
                    sibling += (
                      await port.readTextFile(
                        { path: siblingPath, maxBytes: MAX_MEMORY_READ_BYTES },
                        options,
                      )
                    ).content;
                  } catch (error) {
                    if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
                  }
                }
                if (content.length + sibling.length > MAX_USER_TOTAL_CHARS)
                  throw new Error("User memory total budget exceeded");
                const keys = stableKeys(content + "\n" + sibling);
                if (new Set(keys).size !== keys.length)
                  throw new Error("Duplicate user preference key");
              } else if (relative(root.rootDir, path) === "memory.md")
                content = rollMemoryMarkdown(content);
              options?.signal?.throwIfAborted();
              const result = await port.writeTextFile(
                { ...request, content, atomic: true, expectedRevision: current?.revision },
                options,
              );
              const updated = await port.readTextFile(
                { path, maxBytes: MAX_MEMORY_READ_BYTES },
                options,
              );
              seen.set(path, updated);
              return result;
            });
          } catch (error) {
            stopped = true;
            throw error;
          }
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function stableKeys(content: string): string[] {
  return [...content.matchAll(/^- ([^:：\n]{1,48})[:：]/gmu)].map((match) =>
    match[1]!.trim().toLocaleLowerCase(),
  );
}

export function validateStableUserMemory(content: string, userInput: string): string {
  if (content.length > MAX_USER_FILE_CHARS || !userInput.trim())
    throw new Error("User memory budget or evidence is missing");
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  for (const line of lines) {
    if (sanitizeChronicleText(line, 300) !== line.trim())
      throw new Error("User memory contains sensitive text");
    if (!line.trim() || /^# [^\n]{1,80}$/u.test(line)) continue;
    const entry = /^- ([^:：\n]{1,48})[:：]\s*(.{1,240})$/u.exec(line);
    if (!entry || sanitizeChronicleText(line, 300) !== line.trim())
      throw new Error("User memory must contain safe small keyed preferences");
  }
  if (new Set(stableKeys(content)).size !== stableKeys(content).length)
    throw new Error("Duplicate user preference key");
  return content;
}
