import type { MessageId, MessageWithParts } from "@zcode/contracts";
import { buildMemoryExtractionUserInput } from "./extraction-policy.js";

export const MEMORY_EXTRACTION_BATCH_MESSAGES = 3;
export const MEMORY_EXTRACTION_BATCH_CHARS = 1500;
export const MEMORY_EXTRACTION_BATCH_MAX_CHARS = 6000;

export function selectMemoryExtractionBatch(
  messages: readonly MessageWithParts[],
  cursor?: MessageId,
): { messages: readonly MessageWithParts[]; userCount: number; chars: number } {
  const cursorIndex = cursor ? messages.findIndex((message) => message.info.id === cursor) : -1;
  const pending = messages.slice(cursorIndex + 1);
  let chars = 0;
  let userCount = 0;
  let end = pending.length;
  for (let index = 0; index < pending.length; index += 1) {
    const text = buildMemoryExtractionUserInput([pending[index]!]);
    if (!text) continue;
    if (userCount && chars + text.length > MEMORY_EXTRACTION_BATCH_MAX_CHARS) {
      end = index;
      break;
    }
    userCount += 1;
    chars += Math.min(text.length, MEMORY_EXTRACTION_BATCH_MAX_CHARS);
  }
  return { messages: pending.slice(0, end), userCount, chars };
}
