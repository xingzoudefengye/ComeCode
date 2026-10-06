import { join } from "node:path";
import type { MessageId, MessageWithParts, ToolPart } from "@zcode/contracts";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import type { MemoryExtractionDecision, MemoryExtractionSnapshot } from "./extraction.js";

const MINIMUM_USER_WORDS = 3;
export const MEMORY_EXTRACTION_MAX_INPUT_CHARS = 16_000;

/** 只投影 scheduler 决策后的用户增量；旧 tool/模型输出及注入指令不进入背景请求。 */
export function buildMemoryExtractionUserInput(messages: readonly MessageWithParts[]): string {
  const texts: string[] = [];
  let remaining = MEMORY_EXTRACTION_MAX_INPUT_CHARS;
  for (const message of [...messages].reverse()) {
    if (!isNonMetaUserMessage(message)) continue;
    const text = message.parts
      .flatMap((part) =>
        part.type === "text" && !part.ignored && !part.synthetic ? [part.text] : [],
      )
      .join("\n")
      .replace(/<(system-reminder|tool_result|tool_use|instructions)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
      .trim();
    if (!text) continue;
    const clipped = text.slice(0, remaining);
    texts.unshift(clipped);
    remaining -= clipped.length + 2;
    if (remaining <= 0) break;
  }
  return texts.join("\n\n").slice(0, MEMORY_EXTRACTION_MAX_INPUT_CHARS);
}

export function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor);

  const pending =
    messagesAfterFoundCursor(snapshot.durableMessages, cursor) ?? snapshot.durableMessages;
  const userCount = pending.filter(
    (message) => buildMemoryExtractionUserInput([message]).length > 0,
  ).length;
  // 批次中一次直接写入不能代表其它用户输入也已沉淀。
  if (userCount <= 1 && containsDirectMemoryWrite(snapshot, cursor)) {
    return { decision: "skip", messageCount, reason: "direct-memory-write" };
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    return { decision: "skip", messageCount, reason: "no-user-prose" };
  }

  return { decision: "run", messageCount };
}

function countMessagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

function containsDirectMemoryWrite(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): boolean {
  const messages = messagesAfterFoundCursor(snapshot.durableMessages, cursor);
  if (!messages) return false;

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isMemoryMutationToolPart(part)) continue;
      const filePath = part.state.input.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (snapshot.allowedRoots?.length) {
        if (
          snapshot.allowedRoots.some((root) => {
            const resolved = resolveContainedMemoryFilePath({
              filePath,
              rootDir: root.rootDir,
              workingDirectory: snapshot.workingDirectory,
              workspaceRoot: snapshot.workspaceRoot,
            });
            return (
              resolved &&
              root.files.some(
                (file) =>
                  resolveContainedMemoryFilePath({
                    filePath: join(root.rootDir, file),
                    rootDir: root.rootDir,
                    workingDirectory: snapshot.workingDirectory,
                    workspaceRoot: snapshot.workspaceRoot,
                  }) === resolved,
              )
            );
          })
        )
          return true;
        continue;
      }
      if (
        resolveContainedMemoryFilePath({
          filePath,
          rootDir: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function containsEligibleUserProse(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): boolean {
  const messagesAfterCursor = messagesAfterFoundCursor(messages, cursor) ?? messages;
  const text = buildMemoryExtractionUserInput(messagesAfterCursor).trim();
  if (!text) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) && text.length >= 6)
    return true;
  for (const message of messagesAfterCursor) {
    if (!isNonMetaUserMessage(message)) continue;
    for (const part of message.parts) {
      if (
        part.type === "text" &&
        part.ignored !== true &&
        part.synthetic !== true &&
        countWords(part.text) >= MINIMUM_USER_WORDS
      ) {
        return true;
      }
    }
  }
  return false;
}

function messagesAfterFoundCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

function isNonMetaUserMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only"
  );
}

function isMemoryMutationToolPart(part: MessageWithParts["parts"][number]): part is ToolPart {
  return part.type === "tool" && (part.tool === "Write" || part.tool === "Edit");
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}
