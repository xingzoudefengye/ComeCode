import assert from "node:assert/strict";
import { test } from "node:test";
import { applyModelStreamingEvent } from "../packages/tui/src/app-model-streaming.ts";

function createHarness() {
  let messages = [];
  let liveModelText = "";
  const statuses = [];
  const handlers = {
    assistantMessageIdsByToolCallId: new Map(),
    setLiveModelText: (action) => {
      liveModelText = typeof action === "function" ? action(liveModelText) : action;
    },
    setMessages: (action) => {
      messages = typeof action === "function" ? action(messages) : action;
    },
    setStatus: (status) => statuses.push(status),
  };
  return {
    handlers,
    get liveModelText() {
      return liveModelText;
    },
    get messages() {
      return messages;
    },
    statuses,
  };
}

test("流式中间文本不进入 transcript，reasoning 仍保持可见", () => {
  const harness = createHarness();
  applyModelStreamingEvent(
    {
      assistantMessageId: "step-1",
      delta: "先检查代码",
      kind: "reasoning_delta",
    },
    harness.handlers,
  );
  applyModelStreamingEvent(
    {
      assistantMessageId: "step-1",
      delta: "中间模型文本，不应提前显示",
      kind: "text_delta",
    },
    harness.handlers,
  );
  applyModelStreamingEvent(
    {
      delta: "没有 assistant id 的中间文本",
      kind: "text_delta",
    },
    harness.handlers,
  );

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].parts?.length, 1);
  assert.equal(harness.messages[0].parts?.[0]?.type, "thought");
  assert.equal(harness.liveModelText, "");
  assert.match(harness.statuses.at(-1), /Streaming model response/u);
});
