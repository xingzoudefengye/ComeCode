import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SlashSuggestionPanel } from "../packages/tui/src/app-components.tsx";
import { AppView } from "../packages/tui/src/app-view.tsx";
import { DEFAULT_TUI_COPY } from "../packages/tui/src/app-locale.ts";
import { useModelCommandController } from "../packages/tui/src/app-model-command.ts";
import { useTuiKeyboardControls } from "../packages/tui/src/app-keyboard.ts";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);
const commands = [
  { name: "model", summary: "Switch model", usage: "/model [model]" },
  { name: "mode", summary: "Switch mode", usage: "/mode [mode]" },
];
const noop = () => {};
const models = [
  { ref: { providerId: "fixture", modelId: "first" }, label: "First", properties: {} },
  { ref: { providerId: "fixture", modelId: "second" }, label: "Second", properties: {} },
];

function Harness({ model, submissions = [] }) {
  const editorRef = React.useRef(null);
  const abortControllerRef = React.useRef();
  const controller = useModelCommandController("/model", { modelOptions: models });
  const submitValue = (value) => submissions.push(controller.selectedOption(value));
  useTuiKeyboardControls({
    abortControllerRef,
    approvalQueue: [],
    busy: false,
    copyCurrentSelection: () => false,
    draftValue: "/model",
    filteredEffortOptions: [],
    filteredModeOptions: [],
    filteredModelOptions: controller.filteredOptions,
    filteredSlashCommands: commands,
    handleFileMentionKey: () => false,
    inputHistoryActive: false,
    messages: [],
    modelSelection: controller.selection,
    onExit: noop,
    openModelSelection: controller.openSelection,
    openEffortSelection: () => false,
    openModeSelection: () => false,
    pasteClipboardImage: async () => {},
    recallNextInput: async () => {},
    recallPreviousInput: async () => {},
    setApprovalQueue: noop,
    setDraftAttachments: noop,
    setDraftValue: noop,
    setEffortSelection: noop,
    setModelSelection: controller.setSelection,
    setModeSelection: noop,
    setSelection: noop,
    setSlashSelection: noop,
    setStatus: noop,
    submitValue,
    switchMode: noop,
    toggleSidebar: () => false,
    toggleSidebarSection: () => false,
  });
  return React.createElement(AppView, {
    approvalQueue: [],
    busy: false,
    contextUsage: {},
    copy: DEFAULT_TUI_COPY,
    copyCurrentSelection: () => false,
    draft: "/model",
    editorRef,
    effortOptions: [],
    inputCursorToEndVersion: 0,
    lastEvent: "",
    loginRequired: false,
    liveModelText: "",
    mode: "default",
    modeOptions: [],
    model,
    modelOptions: controller.filteredOptions,
    modelSelection: controller.selection,
    modifiedFiles: [],
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
    setDraftValue: noop,
    sidebarLayout: { overlay: false, reservedWidth: 0, visible: false, wide: false },
    sidebarSections: {},
    slashCommands: controller.selection ? [] : commands.slice(0, 1),
    slashSelection: controller.selection ? undefined : { selectedIndex: 0 },
    status: "",
    statusDetails: [],
    submitValue,
    terminalWidth: 100,
    thoughtLevel: "high",
    todos: [],
  });
}

async function render(t, element, width = 100) {
  let view;
  let update;
  function Root() {
    const [child, setChild] = React.useState(element);
    update = setChild;
    return child;
  }
  await React.act(async () => {
    view = await testRender(React.createElement(Root), { height: 40, width });
  });
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await React.act(async () => view.renderOnce());
  };
  await flush();
  return {
    view,
    flush,
    update: (element) => update(element),
    frame: () => view.captureCharFrame(),
  };
}

function panel(currentModel, width = 100) {
  return React.createElement(SlashSuggestionPanel, {
    commands,
    contentWidth: width - 4,
    currentModel,
    selectedIndex: 0,
  });
}

test("/model 建议显示当前模型，切换后更新且不改其他命令", async (t) => {
  const f = await render(t, React.createElement(Harness, { model: "fixture/first" }));
  assert.match(f.frame(), /\/model\s+Switch model Current: fixture\/first/u);
  await React.act(async () => {
    f.update(React.createElement(Harness, { model: "fixture/second" }));
  });
  await f.flush();
  assert.match(f.frame(), /\/model\s+Switch model Current: fixture\/second/u);
  assert.doesNotMatch(f.frame(), /Current: fixture\/first/u);
});

test("没有当前模型时不显示空提示，其他命令不追加当前模型", async (t) => {
  const f = await render(t, panel("   "));
  assert.match(f.frame(), /\/model\s+Switch model/u);
  assert.doesNotMatch(f.frame(), /Current:/u);
  await React.act(async () => f.update(panel("fixture/first")));
  await f.flush();
  assert.match(f.frame(), /\/mode\s+Switch mode\s*│/u);
  assert.equal((f.frame().match(/Current:/gu) ?? []).length, 1);
});

test("窄终端当前模型换行不覆盖下一条命令", async (t) => {
  const f = await render(t, panel("fixture/a-long-current-model-name", 40), 40);
  const lines = f.frame().split("\n");
  const modelLine = lines.findIndex((line) => line.includes("/model"));
  const modeLine = lines.findIndex((line) => line.includes("/mode "));
  assert.ok(modelLine >= 0 && modeLine > modelLine, f.frame());
  const summary = lines
    .slice(modelLine, modeLine)
    .join("")
    .replace(/│|\s/gu, "");
  assert.match(summary, /Current:fixture\/a-long-current-model-name/u);
  assert.ok(modeLine > modelLine + 1);
  assert.match(lines[modeLine], /Switch mode/u);
});

test("/model 第一次 Enter 仅打开列表，移动后第二次 Enter 确认", async (t) => {
  const submissions = [];
  const f = await render(t, React.createElement(Harness, { model: "fixture/first", submissions }));
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.deepEqual(submissions, []);
  assert.match(f.frame(), /First/u);
  await React.act(async () => f.view.mockInput.pressArrow("down"));
  await f.flush();
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.deepEqual(submissions, [models[1]]);
});
