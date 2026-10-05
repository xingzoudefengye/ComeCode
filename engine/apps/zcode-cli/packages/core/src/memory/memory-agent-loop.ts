import { realpath, lstat } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import type { ModelInputMessage, Model, ModelToolCall, ModelToolContract } from "@zcode/contracts";
import { modelContentForToolResult, isErrorForToolResult } from "../runtime/helpers/tool-result.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../tool/types.js";
import { resolveSafeMemoryFilePath } from "./memory-file-path.js";
import { auxiliaryModelOptions } from "../model/auxiliary-model-options.js";

export interface MemoryAgentAllowedRoot {
  rootDir: string;
  files: readonly string[];
  kind?: "project" | "user";
}
const ALLOWED_TOOLS = new Set(["Read", "Write", "Edit"]);
const PROJECT_FILES = ["project.md", "decisions.md", "tasks.md", "bugs.md", "memory.md"];
export const MEMORY_AGENT_MAX_TURNS = 3;
export const MEMORY_AGENT_MAX_OUTPUT_TOKENS = 2000;
export const MEMORY_AGENT_TIMEOUT_MS = 30_000;
const TOOL_RESULT_MAX_CHARS = 4000;
const REQUEST_MAX_CHARS = 16_000;

export async function runMemoryAgentLoop(input: {
  abortSignal?: AbortSignal;
  executeTool: (
    toolCall: ExecutableToolCall,
    options: { abortSignal?: AbortSignal },
  ) => Promise<ToolExecutionResult>;
  maxTurns: number;
  messages: readonly ModelInputMessage[];
  model: Model;
  rootDir: string;
  allowedRoots?: readonly MemoryAgentAllowedRoot[];
  tools: readonly ModelToolContract[];
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<{ messages: ModelInputMessage[]; turns: number }> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.abortSignal?.reason);
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  if (input.abortSignal?.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Memory extraction timed out", "AbortError")),
    MEMORY_AGENT_TIMEOUT_MS,
  );
  timeout.unref?.();
  const signal = controller.signal;
  const messages = input.messages.map((message) => ({ ...message }));
  const tools = input.tools.filter((tool) => ALLOWED_TOOLS.has(tool.name));
  const roots = input.allowedRoots ?? [
    { rootDir: input.rootDir, files: PROJECT_FILES, kind: "project" },
  ];
  let turns = 0;
  let remainingOutputTokens = MEMORY_AGENT_MAX_OUTPUT_TOKENS;
  try {
    for (; turns < Math.min(input.maxTurns, MEMORY_AGENT_MAX_TURNS); turns += 1) {
      signal.throwIfAborted();
      const options = auxiliaryModelOptions(input.model);
      const response = await abortable(
        input.model.generateText({
          abortSignal: signal,
          messages: boundRequestMessages(messages),
          options: {
            ...options,
            maxOutputTokens: Math.min(options.maxOutputTokens, remainingOutputTokens),
          },
          tools: [...tools],
        }),
        signal,
      );
      signal.throwIfAborted();
      const calls = response.toolCalls ?? [];
      // 缺少 usage 时按字符数保守计费；有 usage 使用 provider 实际输出预算。
      const responseChars =
        response.text.length +
        JSON.stringify(calls).length +
        JSON.stringify(response.reasoning ?? []).length;
      remainingOutputTokens -= response.usage?.outputTokens ?? Math.max(1, responseChars);
      if (remainingOutputTokens < 0) throw new Error("Memory extraction output budget exceeded");
      messages.push({ role: "assistant", content: response.text, toolCalls: calls });
      if (!calls.length) {
        turns += 1;
        break;
      }
      // 同轮 Read/Write 也串行，避免尚未记录读取版本就开始覆盖。
      for (const call of calls) {
        signal.throwIfAborted();
        if (
          (call.name === "Write" || call.name === "Edit") &&
          calls.some((item) => item.name === "Read")
        ) {
          messages.push({
            role: "tool",
            toolName: call.name,
            toolCallId: call.id,
            isError: true,
            content:
              "Read the file first, then propose changes in the next model turn after observing its contents.",
          });
          continue;
        }
        const path = tools.some((tool) => tool.name === call.name)
          ? await resolveAllowedMemoryAgentPath({ ...input, allowedRoots: roots, toolCall: call })
          : undefined;
        if (!path) {
          messages.push({
            role: "tool",
            toolName: call.name,
            toolCallId: call.id,
            isError: true,
            content: `Only Read, Write and Edit of the approved memory files within ${roots.map((root) => root.rootDir).join(", ")} are allowed.`,
          });
          continue;
        }
        const result = await abortable(
          input.executeTool(
            {
              id: call.id,
              name: call.name,
              input: { ...(call.input as Record<string, unknown>), file_path: path },
            },
            { abortSignal: signal },
          ),
          signal,
        );
        signal.throwIfAborted();
        const content = modelContentForToolResult(result);
        messages.push({
          role: "tool",
          toolName: call.name,
          toolCallId: call.id,
          isError: isErrorForToolResult(result),
          content:
            typeof content === "string"
              ? content.slice(0, TOOL_RESULT_MAX_CHARS)
              : "Memory tool returned unsupported content.",
        });
        if (!result.success && (call.name === "Write" || call.name === "Edit"))
          throw new Error("Memory mutation failed; extraction stopped");
      }
      if (remainingOutputTokens === 0) {
        turns += 1;
        break;
      }
    }
    return { messages, turns };
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", abort);
  }
}

/** 词法白名单 + realpath 检查，根本身和中间目录都不能通过 symlink 扩大批准范围。 */
export async function resolveAllowedMemoryAgentPath(input: {
  allowedRoots: readonly MemoryAgentAllowedRoot[];
  toolCall: ModelToolCall;
  workingDirectory: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  if (!ALLOWED_TOOLS.has(input.toolCall.name)) return undefined;
  const value = input.toolCall.input;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const filePath = (value as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return undefined;
  for (const root of input.allowedRoots) {
    let path: string | undefined;
    try {
      path = resolveSafeMemoryFilePath({ ...input, filePath, rootDir: root.rootDir });
      if (!path || !root.files.some((file) => path === join(root.rootDir, file))) continue;
      if (await isSafeRealPath(root.rootDir, path)) return path;
    } catch {
      /* 不可验证的路径拒绝，而不回退到词法包含。 */
    }
  }
  return undefined;
}

async function isSafeRealPath(root: string, path: string): Promise<boolean> {
  let ancestor = root;
  while (true) {
    try {
      const stat = await lstat(ancestor);
      if (stat.isSymbolicLink()) return false;
      const actual = await realpath(ancestor);
      const suffix = relative(actual, path);
      if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
        return false;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      ancestor = parent;
    }
  }
  try {
    return !(await lstat(path)).isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function boundRequestMessages(messages: readonly ModelInputMessage[]): ModelInputMessage[] {
  let remaining = REQUEST_MAX_CHARS;
  return messages.map((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    if (text.length > remaining)
      throw new Error("Memory extraction input budget exceeded; no partial file overwrite allowed");
    const content = text;
    remaining -= content.length;
    const toolCalls = message.toolCalls?.map((call) => {
      const size = JSON.stringify(call.input).length;
      remaining -= size;
      if (remaining < 0) throw new Error("Memory extraction tool arguments exceed input budget");
      return call;
    });
    return { ...message, content, toolCalls };
  });
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const promise = new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      signal.removeEventListener("abort", abort);
    }
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  return promise;
}
