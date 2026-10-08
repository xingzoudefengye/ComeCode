import type React from "react";
import type { Message } from "./app-model.js";
import {
  appendStreamingThoughtDelta,
  markStreamingMessageComplete,
  markStreamingThoughtComplete,
} from "./app-transcript-stream.js";
import { stringField } from "./state.js";

export function applyModelStreamingEvent(
  payload: Record<string, unknown>,
  handlers: {
    assistantMessageIdsByToolCallId: Map<string, string>;
    setLiveModelText: React.Dispatch<React.SetStateAction<string>>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setStatus: (status: string) => void;
  },
): void {
  const kind = stringField(payload, "kind");
  const delta = stringField(payload, "delta") ?? "";
  if (kind === "reasoning_start") {
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_delta") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) =>
        appendStreamingThoughtDelta(current, assistantMessageId, delta),
      );
    }
    handlers.setStatus("Streaming model reasoning...");
    return;
  }
  if (kind === "reasoning_end") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingThoughtComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model reasoning received.");
    return;
  }
  if (kind === "tool_call") {
    rememberStreamingToolMessage(payload, handlers.assistantMessageIdsByToolCallId);
    handlers.setStatus(`Tool ${stringField(payload, "toolName") ?? "tool"} pending.`);
    return;
  }
  if (kind === "tool_input_start" || kind === "tool_input_delta" || kind === "tool_input_end") {
    // provider tool-input deltas are JSON arguments for a future tool call, not assistant text.
    handlers.setStatus(`Preparing tool ${stringField(payload, "toolName") ?? "tool"}...`);
    return;
  }
  if (kind === "text_delta" || (!kind && delta)) {
    // text_delta 可能来自中间 model step；最终正文由 turn_complete.response 或 submit result 投影。
    // 不把过程文本写入 transcript，否则会提前结束 Thought，后续 step 又产生新的 Thought 标题。
    handlers.setStatus("Streaming model response...");
    return;
  }
  if (kind === "finish") {
    const assistantMessageId = stringField(payload, "assistantMessageId");
    if (assistantMessageId) {
      handlers.setMessages((current) => markStreamingMessageComplete(current, assistantMessageId));
    }
    handlers.setStatus("Model response received.");
  }
}

function rememberStreamingToolMessage(
  payload: Record<string, unknown>,
  assistantMessageIdsByToolCallId: Map<string, string>,
): void {
  const toolCallId = stringField(payload, "toolCallId");
  const assistantMessageId = stringField(payload, "assistantMessageId");
  if (toolCallId && assistantMessageId) {
    assistantMessageIdsByToolCallId.set(toolCallId, assistantMessageId);
  }
}
