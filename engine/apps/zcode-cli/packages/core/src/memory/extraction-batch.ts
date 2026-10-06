import type { MessageId, MessageWithParts } from "@zcode/contracts";
import {
  buildMemoryExtractionInput,
  buildMemoryExtractionUserInput,
  measureMemoryExtractionInputChars,
} from "./extraction-policy.js";
import { buildMemoryExtractionEvidence } from "./extraction-evidence.js";

export const MEMORY_EXTRACTION_BATCH_MESSAGES = 3;
export const MEMORY_EXTRACTION_BATCH_CHARS = 1500;
export const MEMORY_EXTRACTION_BATCH_MAX_CHARS = 6000;

export function selectMemoryExtractionBatch(
  messages: readonly MessageWithParts[],
  cursor?: MessageId,
): {
  messages: readonly MessageWithParts[];
  userCount: number;
  evidenceCount: number;
  chars: number;
} {
  const cursorIndex = cursor ? messages.findIndex((message) => message.info.id === cursor) : -1;
  const pending = messages.slice(cursorIndex + 1);
  let end = pending.length;
  for (let index = 0; index < pending.length; index += 1) {
    const text = buildMemoryExtractionUserInput([pending[index]!]);
    const evidence = buildMemoryExtractionEvidence([pending[index]!]);
    if (!text && !evidence) continue;
    const projectedChars = measureMemoryExtractionInputChars(pending.slice(0, index + 1));
    if (projectedChars > MEMORY_EXTRACTION_BATCH_MAX_CHARS && index > 0) {
      end = index;
      break;
    }
  }
  const selected = pending.slice(0, end);
  const selectedInput = selected
    .map((message) => buildMemoryExtractionUserInput([message]))
    .filter(Boolean);
  const selectedEvidence = selected.flatMap((message) =>
    buildMemoryExtractionEvidence([message]) ? [message] : [],
  );
  return {
    messages: selected,
    userCount: selectedInput.length,
    evidenceCount: selectedEvidence.length,
    chars: buildMemoryExtractionInput(selected).length,
  };
}
