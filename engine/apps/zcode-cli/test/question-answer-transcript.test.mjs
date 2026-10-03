import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SessionEventType } from "../packages/contracts/src/index.ts";
import { applyToolTranscriptEvent } from "../packages/tui/src/app-tool-transcript.ts";
import { appendAgentResult } from "../packages/tui/src/app-submit.ts";
import { ContentPane } from "../packages/tui/src/app-transcript-components.tsx";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);

function liveMessages(content, toolName = "AskUserQuestion", error = false) {
  let messages = [];
  const handlers = {
    toolNamesById: new Map(),
    setMessages: (update) => {
      messages = update(messages);
    },
  };
  const timestamp = new Date("2026-10-03T12:00:00Z");
  applyToolTranscriptEvent(
    {
      type: SessionEventType.ToolCallScheduled,
      timestamp,
      payload: { toolCallId: "question-1", toolName, input: { questions: [] } },
    },
    handlers,
  );
  applyToolTranscriptEvent(
    {
      type: error ? SessionEventType.ToolCallError : SessionEventType.ToolCallResult,
      timestamp,
      payload: error
        ? { toolCallId: "question-1", error: { message: "Question cancelled" } }
        : { toolCallId: "question-1", result: { success: true, content } },
    },
    handlers,
  );
  return messages;
}

async function render(t, messages, width = 100) {
  let view;
  await React.act(async () => {
    view = await testRender(
      React.createElement(ContentPane, { focused: false, messages, terminalWidth: width }),
      { height: 50, width },
    );
    await view.renderOnce();
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await React.act(async () => view.renderOnce());
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });
  return view.captureCharFrame();
}

test("实时问答结果按 toolCallId 识别工具，选择和多题实际答案默认可见", async (t) => {
  const content = 'User has answered your questions: "先改什么?"="布局", "支持哪些?"="CLI, 桌面".';
  const messages = liveMessages(content);
  assert.equal(messages[0].parts[0].output, content);
  const frame = await render(t, messages);
  assert.match(frame, /先改什么\?/u);
  assert.match(frame, /布局/u);
  assert.match(frame, /CLI, 桌面/u);
});

test("恢复会话同样显示答案，长 Other 自定义回答在窄终端完整换行", async (t) => {
  const answer = "保留现有的所有会话和配置。".repeat(12) + "自定义回答结尾标记";
  const output = `User has answered your questions: "你想怎么处理?"="${answer}".`;
  const messages = appendAgentResult([], {
    response: "",
    restoredMessages: [
      {
        role: "agent",
        content: "",
        parts: [
          {
            type: "tool",
            toolName: "AskUserQuestion",
            toolCallId: "restored-question",
            status: "completed",
            input: { questions: [] },
            output,
          },
        ],
      },
    ],
  });
  const frame = await render(t, messages, 42);
  assert.match(frame.replace(/\s/gu, ""), /自定义回答结尾标记/u);
  assert.doesNotMatch(frame, /truncated/u);
});

test("取消不编造答案，普通工具结果仍不自动展示原始正文", async (t) => {
  const cancelled = liveMessages(undefined, "AskUserQuestion", true);
  assert.equal(cancelled[0].parts[0].output, undefined);
  assert.match(await render(t, cancelled), /Question cancelled/u);
  const ordinary = liveMessages("not-visible-raw-body", "Bash");
  assert.equal(ordinary[0].parts[0].output, undefined);
  assert.doesNotMatch(await render(t, ordinary), /not-visible-raw-body/u);
});

test("旧结果没有 content 或用户跳过回答时不产生虚构选择", () => {
  assert.equal(liveMessages(undefined)[0].parts[0].output, undefined);
  const skipped = "The user did not provide answers to these questions.";
  assert.equal(liveMessages(skipped)[0].parts[0].output, skipped);
});
