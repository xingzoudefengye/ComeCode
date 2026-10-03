import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { useTuiKeyboardControls } from "../packages/tui/src/app-keyboard.ts";
import { DEFAULT_TUI_COPY } from "../packages/tui/src/app-locale.ts";
import { AppView } from "../packages/tui/src/app-view.tsx";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")));

const copy = DEFAULT_TUI_COPY;
const INPUT_PLACEHOLDER = copy.input.placeholder;

const question = {
  question: "你想先改哪一块？",
  header: "范围",
  options: [
    { label: "布局", description: "只调整面板位置" },
    { label: "按键", description: "同时改键位路由" },
  ],
  multiSelect: false,
};

// 审批提问走 questionState 分支，request 只作为占位，不会被读取。
function questionApproval(outcomes) {
  return {
    cleanup: () => {},
    questionState: {
      annotations: {},
      answers: {},
      currentQuestionIndex: 0,
      editingOther: false,
      input: { questions: [question] },
      multiSelections: {},
      otherBuffer: "",
      otherText: {},
      reviewing: false,
      selectedOptionIndex: 0,
    },
    reject: (error) => outcomes.push(error),
    request: { input: {}, toolName: "AskUserQuestion" },
    resolve: (result) => outcomes.push(result),
    selectedDecision: "allow",
  };
}

function Harness({ approval, drafts }) {
  const [draft, updateDraft] = React.useState("");
  const [approvalQueue, setApprovalQueue] = React.useState(approval ? [approval] : []);
  const [status, setStatus] = React.useState("");
  const editorRef = React.useRef(null);
  const abortControllerRef = React.useRef();
  const noop = () => {};
  const setDraftValue = React.useCallback(
    (value) => {
      drafts.push(value);
      updateDraft(value);
    },
    [drafts],
  );
  // 镜像 app.tsx：按键先由全局 hook 处理，被消费后就不会再落到聚焦的输入框。
  useTuiKeyboardControls({
    abortControllerRef,
    approvalQueue,
    busy: false,
    copyCurrentSelection: () => false,
    draftValue: draft,
    filteredEffortOptions: [],
    filteredModeOptions: [],
    filteredModelOptions: [],
    filteredSlashCommands: [],
    handleFileMentionKey: () => false,
    inputHistoryActive: false,
    messages: [],
    onExit: noop,
    pasteClipboardImage: async () => {},
    recallNextInput: async () => {},
    recallPreviousInput: async () => {},
    setApprovalQueue,
    setDraftAttachments: noop,
    setDraftValue,
    setEffortSelection: noop,
    setModelSelection: noop,
    setModeSelection: noop,
    setSelection: noop,
    setSlashSelection: noop,
    setStatus,
    submitValue: async () => {},
    switchMode: noop,
    toggleSidebar: () => false,
    toggleSidebarSection: () => false,
  });
  return React.createElement(AppView, {
    approvalQueue,
    busy: false,
    contextUsage: {},
    copy,
    copyCurrentSelection: () => false,
    draft,
    editorRef,
    effortOptions: [],
    inputCursorToEndVersion: 0,
    lastEvent: "",
    loginRequired: false,
    liveModelText: "",
    mode: "default",
    modeOptions: [],
    model: "local/test-model",
    modifiedFiles: [],
    modelOptions: [],
    messages: [],
    networkRequests: [],
    options: {
      locale: "en-US",
      noColor: true,
      stderr: process.stderr,
      stdin: process.stdin,
      stdout: process.stdout,
      submitPrompt: async () => ({ response: "", responseFormat: "plain" }),
    },
    setDraftValue,
    sidebarLayout: { overlay: false, reservedWidth: 0, visible: false, wide: false },
    sidebarSections: {
      apis: false,
      mcp: false,
      modifiedFiles: false,
      subagents: false,
      todos: false,
    },
    slashCommands: [],
    status,
    statusDetails: [],
    submitValue: noop,
    terminalWidth: 100,
    thoughtLevel: "high",
    todos: [],
  });
}

async function render(t, approval, outcomes) {
  const drafts = [];
  let view;
  await React.act(async () => {
    view = await testRender(React.createElement(Harness, { approval, drafts }), {
      height: 40,
      width: 100,
    });
  });
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });
  // 渲染器按帧节流：状态变更后要跨过一个真实 tick 才会重绘到帧缓冲。
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await React.act(async () => {
      await view.flush();
    });
  };
  // escape/enter 是按键码，必须走专用的 mock 方法；普通字符直接 pressKey。
  const press = async (name) => {
    await React.act(async () => {
      if (name === "escape") view.mockInput.pressEscape();
      else view.mockInput.pressKey(name);
    });
    await flush();
  };
  await flush();
  return { drafts, frame: () => view.captureCharFrame(), outcomes, press };
}

test("提问面板渲染在输入框上方，输入框保持可见", { timeout: 15000 }, async (t) => {
  const f = await render(t, questionApproval([]), []);
  const frame = f.frame();
  assert.match(frame, /Question 1\/1/u);
  assert.match(frame, /你想先改哪一块？/u);
  // 回归点：面板不再顶替输入框，输入框的占位文本必须仍然可见。
  assert.match(frame, new RegExp(INPUT_PLACEHOLDER, "u"));
});

test("提问期间按键由面板独占，不写入草稿", { timeout: 15000 }, async (t) => {
  const f = await render(t, questionApproval([]), []);
  await f.press("x");
  assert.deepEqual(f.drafts, []);
  const frame = f.frame();
  assert.match(frame, new RegExp(INPUT_PLACEHOLDER, "u"));
  assert.doesNotMatch(frame, new RegExp(`${INPUT_PLACEHOLDER}x`, "u"));
});

test("Esc 结束提问后输入框仍在，行为回到普通输入", { timeout: 15000 }, async (t) => {
  const outcomes = [];
  const f = await render(t, questionApproval(outcomes), outcomes);
  await f.press("escape");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].decision, "deny");
  const frame = f.frame();
  assert.doesNotMatch(frame, /Question 1\/1/u);
  assert.match(frame, new RegExp(INPUT_PLACEHOLDER, "u"));
  await f.press("x");
  assert.deepEqual(f.drafts, ["x"]);
});

test("没有待处理提问时行为不变，仅显示输入框", { timeout: 15000 }, async (t) => {
  const f = await render(t, undefined, []);
  const frame = f.frame();
  assert.doesNotMatch(frame, /Question 1\/1/u);
  assert.match(frame, new RegExp(INPUT_PLACEHOLDER, "u"));
});
