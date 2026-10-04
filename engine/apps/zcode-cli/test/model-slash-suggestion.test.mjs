import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { SlashSuggestionPanel } from "../packages/tui/src/app-components.tsx";
import { AppView } from "../packages/tui/src/app-view.tsx";
import { DEFAULT_TUI_COPY } from "../packages/tui/src/app-locale.ts";
import { useModelCommandController } from "../packages/tui/src/app-model-command.ts";
import { useEffortCommandController } from "../packages/tui/src/app-effort-command.ts";
import { useModeCommandController } from "../packages/tui/src/app-mode-command.ts";
import { useTuiKeyboardControls } from "../packages/tui/src/app-keyboard.ts";
import { filterSlashCommands, reconcileSlashSelection } from "../packages/tui/src/app-input.ts";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);
const commands = [
  { name: "model", summary: "Switch model", usage: "/model [model]" },
  { name: "mode", summary: "Switch mode", usage: "/mode [mode]" },
  { name: "effort", aliases: ["variant"], summary: "Switch effort", usage: "/effort [level]" },
  { name: "help", summary: "Show help", usage: "/help" },
];
const noop = () => {};
const models = [
  { ref: { providerId: "fixture", modelId: "first" }, label: "First", properties: {} },
  { ref: { providerId: "fixture", modelId: "second" }, label: "Second", properties: {} },
];

function Harness({
  model,
  submissions = [],
  initialDraft = "/model",
  messages = [],
  availableModels = models,
  availableEfforts = [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
}) {
  const [draft, setDraft] = React.useState(initialDraft);
  const [slashSelection, setSlashSelection] = React.useState(() =>
    reconcileSlashSelection(initialDraft, commands),
  );
  const editorRef = React.useRef(null);
  const abortControllerRef = React.useRef();
  const controller = useModelCommandController(draft, { modelOptions: availableModels });
  const effortController = useEffortCommandController(draft, availableEfforts);
  const modeController = useModeCommandController(draft);
  const selecting = controller.selection || effortController.selection || modeController.selection;
  const filteredCommands = filterSlashCommands(draft, commands);
  const setDraftValue = (value) => {
    setDraft(value);
    controller.reconcileDraft(value);
    effortController.reconcileDraft(value);
    modeController.reconcileDraft(value);
    setSlashSelection(reconcileSlashSelection(value, commands));
  };
  const submitValue = (value) =>
    submissions.push(
      controller.selectedOption(value) ??
        effortController.selectedOption(value) ??
        modeController.selectedOption(value) ??
        value,
    );
  useTuiKeyboardControls({
    abortControllerRef,
    approvalQueue: [],
    busy: false,
    copyCurrentSelection: () => false,
    draftValue: draft,
    filteredEffortOptions: effortController.filteredOptions,
    filteredModeOptions: modeController.filteredOptions,
    filteredModelOptions: controller.filteredOptions,
    filteredSlashCommands: filteredCommands,
    handleFileMentionKey: () => false,
    inputHistoryActive: false,
    messages,
    slashSelection,
    effortSelection: effortController.selection,
    modeSelection: modeController.selection,
    modelSelection: controller.selection,
    onExit: noop,
    openModelSelection: controller.openSelection,
    openEffortSelection: effortController.openSelection,
    openModeSelection: modeController.openSelection,
    pasteClipboardImage: async () => {},
    recallNextInput: async () => {},
    recallPreviousInput: async () => {},
    setApprovalQueue: noop,
    setDraftAttachments: noop,
    setDraftValue,
    setEffortSelection: effortController.setSelection,
    setModelSelection: controller.setSelection,
    setModeSelection: modeController.setSelection,
    setSelection: noop,
    setSlashSelection,
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
    draft,
    editorRef,
    effortOptions: effortController.filteredOptions,
    inputCursorToEndVersion: 0,
    lastEvent: "",
    loginRequired: false,
    liveModelText: "",
    mode: "default",
    modeOptions: modeController.filteredOptions,
    model,
    modelOptions: controller.filteredOptions,
    effortSelection: effortController.selection,
    modeSelection: modeController.selection,
    modelSelection: controller.selection,
    modifiedFiles: [],
    messages,
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
    sidebarSections: {},
    slashCommands: selecting ? [] : filteredCommands,
    slashSelection: selecting ? undefined : slashSelection,
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

for (const existingConversation of [false, true]) {
  test(`/mo 补全选择 model 后两次 Enter 切换模型：${existingConversation ? "已有对话" : "新会话"}`, async (t) => {
    const submissions = [];
    const f = await render(
      t,
      React.createElement(Harness, {
        model: "fixture/first",
        submissions,
        initialDraft: "/mo",
        messages: existingConversation ? [{ role: "user", content: "Hello" }] : [],
      }),
    );
    await React.act(async () => f.view.mockInput.pressArrow("down"));
    await f.flush();
    await React.act(async () => f.view.mockInput.pressArrow("up"));
    await f.flush();
    await React.act(async () => f.view.mockInput.pressEnter());
    await f.flush();
    assert.deepEqual(submissions, []);
    assert.match(f.frame(), /First/u);
    assert.match(f.frame(), /Second/u);
    await React.act(async () => f.view.mockInput.pressArrow("down"));
    await f.flush();
    await React.act(async () => f.view.mockInput.pressEnter());
    await f.flush();
    assert.deepEqual(submissions, [models[1]]);
  });
}

test("/mo 模型列表可取消，无可选模型时不提交", async (t) => {
  const submissions = [];
  const f = await render(t, React.createElement(Harness, { initialDraft: "/mo", submissions }));
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.match(f.frame(), /Second/u);
  await React.act(async () => f.view.mockInput.pressKey("escape"));
  await f.flush();
  assert.doesNotMatch(f.frame(), /Second/u);
  assert.deepEqual(submissions, []);
  await React.act(async () =>
    f.update(
      React.createElement(Harness, {
        key: "no-models",
        initialDraft: "/mo",
        availableModels: [],
        submissions,
      }),
    ),
  );
  await f.flush();
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.deepEqual(submissions, []);
  assert.match(f.frame(), /\/model/u);
});

for (const [prefix, label, expectedId] of [
  ["/mo", "Plan", "build"],
  ["/ef", "Low", "high"],
  ["/va", "Low", "high"],
]) {
  for (const existingConversation of [false, true]) {
    test(`${prefix} 选择列表两段确认：${existingConversation ? "已有对话" : "新会话"}`, async (t) => {
      const submissions = [];
      const f = await render(
        t,
        React.createElement(Harness, {
          initialDraft: prefix,
          submissions,
          messages: existingConversation ? [{ role: "user", content: "Hello" }] : [],
        }),
      );
      if (prefix === "/mo") {
        await React.act(async () => f.view.mockInput.pressArrow("down"));
        await f.flush();
      }
      await React.act(async () => f.view.mockInput.pressEnter());
      await f.flush();
      assert.deepEqual(submissions, []);
      assert.match(f.frame(), new RegExp(label, "u"));
      await React.act(async () => f.view.mockInput.pressArrow("down"));
      await f.flush();
      await React.act(async () => f.view.mockInput.pressEnter());
      await f.flush();
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0].id, expectedId);
    });
  }
}

for (const prefix of ["/mode", "/effort", "/variant"]) {
  test(`${prefix} 完整命令可打开并取消列表`, async (t) => {
    const submissions = [];
    const f = await render(t, React.createElement(Harness, { initialDraft: prefix, submissions }));
    await React.act(async () => f.view.mockInput.pressEnter());
    await f.flush();
    assert.match(f.frame(), prefix === "/mode" ? /Ask before each/u : /Low/u);
    await React.act(async () => f.view.mockInput.pressKey("escape"));
    await f.flush();
    assert.doesNotMatch(f.frame(), prefix === "/mode" ? /Ask before each/u : /Low/u);
    assert.deepEqual(submissions, []);
  });
}

test("无思考档位时补全不提交，普通 help 补全保持直接执行", async (t) => {
  const submissions = [];
  const f = await render(
    t,
    React.createElement(Harness, { initialDraft: "/ef", availableEfforts: [], submissions }),
  );
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.deepEqual(submissions, []);
  assert.match(f.frame(), /\/effort/u);
  await React.act(async () =>
    f.update(React.createElement(Harness, { key: "help", initialDraft: "/he", submissions })),
  );
  await f.flush();
  await React.act(async () => f.view.mockInput.pressEnter());
  await f.flush();
  assert.deepEqual(submissions, ["/he"]);
});
