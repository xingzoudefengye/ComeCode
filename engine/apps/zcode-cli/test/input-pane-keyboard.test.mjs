import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { InputPane } from "../packages/tui/src/app-input-pane.tsx";
import { createShiftEnterFallbackHandler } from "../packages/tui/src/tui-keyboard-fallback.ts";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")));

async function renderInput() {
  const editorRef = React.createRef();
  const submissions = [];
  const view = await testRender(
    React.createElement(InputPane, {
      busy: false,
      editorRef,
      focused: true,
      onInput: () => {},
      onSubmit: (value) => submissions.push(value),
      resetCursorToEndVersion: 0,
      value: "第一行",
    }),
    { height: 12, width: 80, kittyKeyboard: true },
  );
  await React.act(async () => {
    await view.renderOnce();
  });
  return { editorRef, submissions, view };
}

test("Shift+Enter inserts a newline without submitting", async (t) => {
  const { editorRef, submissions, view } = await renderInput();
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });

  editorRef.current.gotoBufferEnd();
  await React.act(async () => {
    view.mockInput.pressEnter({ shift: true });
    await view.renderOnce();
  });

  assert.equal(editorRef.current.plainText, "第一行\n");
  assert.deepEqual(submissions, []);
});

test("Enter submits the current draft", async (t) => {
  const { editorRef, submissions, view } = await renderInput();
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });

  await React.act(async () => {
    view.mockInput.pressEnter();
    await view.renderOnce();
  });

  assert.equal(editorRef.current.plainText, "第一行");
  assert.deepEqual(submissions, ["第一行"]);
});

test("bare Enter uses the Windows fallback when Shift is pressed", async (t) => {
  const { editorRef, submissions, view } = await renderInput();
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });

  const handler = createShiftEnterFallbackHandler(view.renderer, () => true);
  view.renderer.prependInputHandler(handler);
  editorRef.current.gotoBufferEnd();
  await React.act(async () => {
    view.renderer.stdin.emit("data", Buffer.from("\r"));
    await view.renderOnce();
  });

  assert.equal(editorRef.current.plainText, "第一行\n");
  assert.deepEqual(submissions, []);
});
