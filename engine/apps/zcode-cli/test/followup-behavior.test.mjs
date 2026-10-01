import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeActionFor } from "../packages/tui/src/app-keyboard-helpers.ts";
import { submitDuringActiveTurn } from "../packages/tui/src/app-submit.ts";
import { queuedInputsForDisplay } from "../packages/tui/src/app-queued-inputs.tsx";
import { resolveAppFollowupMode } from "../../../packages/ui/src/v4/composer/followupModeSettings.ts";

// 纯函数测试覆盖 Esc 的三种状态，不依赖 OpenTUI 的终端事件注入。
test("运行中 Esc 有草稿引导、空草稿中止，空闲不处理", () => {
  assert.equal(escapeActionFor({ busy: true, draftValue: "继续处理" }), "guide");
  assert.equal(escapeActionFor({ busy: true, draftValue: "   " }), "abort");
  assert.equal(escapeActionFor({ busy: false, draftValue: "继续处理" }), "noop");
});

test("缺少交互设置时默认使用引导，显式 queue 仍保留", () => {
  assert.equal(resolveAppFollowupMode({}), "guide");
  assert.equal(resolveAppFollowupMode({ zcodeInteractionBehavior: "queue" }), "queue");
  assert.equal(resolveAppFollowupMode({ zcodeInteractionBehavior: "guide" }), "guide");
});

test("运行中提交显式请求 guide 投递", async () => {
  let capturedOptions;
  const noop = () => {};
  const result = {
    delivery: "guide",
    kind: "queued",
    pendingInputId: "guide-1",
    queueLength: 1,
    turnId: "turn-1",
  };

  await submitDuringActiveTurn({
    activeTurnId: "turn-1",
    applyResult: noop,
    applySessionEvent: noop,
    draftAttachments: [],
    messageInsertIndex: 0,
    options: {
      noColor: true,
      locale: "zh-CN",
      sendInput: async (_input, options) => {
        capturedOptions = options;
        return result;
      },
      stderr: process.stderr,
      stdin: process.stdin,
      stdout: process.stdout,
      submitPrompt: async () => ({ response: "", responseFormat: "plain" }),
    },
    requestPermission: async () => ({ decision: "allow_once" }),
    setDraftValue: noop,
    setLastError: noop,
    setMessages: noop,
    setQueuedInputs: noop,
    setStatus: noop,
    text: "请停止当前方向",
  });

  assert.equal(capturedOptions.queueDelivery, "guide");
  assert.equal(capturedOptions.delivery, "auto");
  assert.equal(capturedOptions.expectedTurnId, "turn-1");
  assert.equal(result.delivery, "guide");
});

test("Queue 面板只显示 queue，guide 和旧输入兼容规则正确", () => {
  assert.deepEqual(
    queuedInputsForDisplay([
      { id: "guide", text: "guide", delivery: "guide" },
      { id: "queue", text: "queue", delivery: "queue" },
      { id: "legacy", text: "legacy" },
    ]).map((input) => input.id),
    ["queue", "legacy"],
  );
  assert.deepEqual(
    queuedInputsForDisplay([{ id: "guide", text: "guide", delivery: "guide" }]),
    [],
  );
});
