import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useClipboardImagePaste } from "../packages/tui/src/app-clipboard-image.ts";
import { useTuiKeyboardControls } from "../packages/tui/src/app-keyboard.ts";
import { useSubmitValue } from "../packages/tui/src/app-submit-controller.ts";
import { createNodeClipboardImageReader } from "../packages/cli/src/clipboard-image.ts";
const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { usePaste } = require("@mbears/opentui-react");
const { testRender } = await import(pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")));
const image = { mediaType: "image/png", sizeBytes: 4, dataUrl: "data:image/png;base64,dGVzdA==" };
async function render(t, reader) {
  const submitted = [];
  let controls;
  const options = {
    noColor: true, locale: "zh-CN", initialModel: "local/test-model", initialResult: { response: "图片粘贴测试", responseFormat: "plain" },
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    readClipboardImage: reader,
    submitPrompt: async input => { submitted.push(input); return { response: "收到测试附件", responseFormat: "plain" }; },
  };
  // 原生 key parser + 真实粘贴/提交 hook；不用调用模型服务或读取测试机私密图片。
  function Harness() {
    const [draft, updateDraft] = React.useState("");
    const [status, setStatus] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const draftRef = React.useRef("");
    const draftAttachmentsRef = React.useRef([]);
    const editorRef = React.useRef(null), abortControllerRef = React.useRef(), nextAttachmentIdRef = React.useRef(1);
    const noop = () => {};
    const setDraftValue = value => { draftRef.current = value; updateDraft(value); };
    const setDraftAttachments = value => { draftAttachmentsRef.current = typeof value === "function" ? value(draftAttachmentsRef.current) : value; };
    const pasteClipboardImage = useClipboardImagePaste({ abortControllerRef, busy, getDraftValue: () => draftRef.current, inputEditorRef: editorRef, nextAttachmentIdRef, options, setDraftAttachments, setDraftValue, setStatus, setStatusDetails: noop });
    // 镜像 app.tsx：终端截获 Ctrl+V 后，纯图片剪贴板的空 paste 触发读图。
    usePaste(event => { if (event.bytes.length === 0) void pasteClipboardImage(); });
    const submitValue = useSubmitValue({
      busy, draftAttachmentsRef, emptyPromptStatus: "请输入内容", pasteClipboardImage, messageInsertIndex: 0, options,
      requestPermission: async () => {}, resolveSubmittedText: value => value,
      applyResult: noop, applySessionEvent: noop, setBusy, setDraftAttachments, setDraftValue,
      setLastError: noop, setLiveModelText: noop, setMessages: noop, setQueuedInputs: noop, setSelection: noop,
      setSlashSelection: noop, setStatus, setStatusDetails: noop, turnRef: abortControllerRef,
    });
    useTuiKeyboardControls({
      abortControllerRef, approvalQueue: [], busy, copyCurrentSelection: () => false, draftValue: draft,
      filteredEffortOptions: [], filteredModeOptions: [], filteredModelOptions: [], filteredSlashCommands: [],
      handleFileMentionKey: () => false, inputHistoryActive: false, messages: [], onExit: noop, pasteClipboardImage,
      recallNextInput: async () => {}, recallPreviousInput: async () => {}, setApprovalQueue: noop,
      setDraftAttachments, setDraftValue, setEffortSelection: noop, setModelSelection: noop, setModeSelection: noop,
      setSelection: noop, setSlashSelection: noop, setStatus, submitValue, switchMode: noop,
      toggleSidebar: () => false, toggleSidebarSection: () => false,
    });
    controls = { setDraftValue, submit: () => submitValue(draftRef.current) };
    return React.createElement("box", { style: { flexDirection: "column" } },
      React.createElement("text", {}, status), React.createElement("text", {}, draft));
  }
  let view;
  await React.act(async () => {
    view = await testRender(React.createElement(Harness), { width: 100, height: 12 });
  });
  t.after(async () => { await React.act(async () => view.renderer.destroy()); });
  const flush = async () => { await React.act(async () => { await view.flush(); }); };
  const act = async callback => { await React.act(callback); await flush(); };
  await flush();
  return { view, submitted, act, flush, control: () => controls };
}

test("原生 Ctrl+V 按键触发真实图片粘贴 hook，生成占位符并提交附件", { timeout: 15000 }, async t => {
  let count = 0;
  const f = await render(t, async () => { count++; return image; });
  await f.act(async () => { f.view.mockInput.pressKey("v", { ctrl: true }); });
  assert.equal(count, 1);
  assert.match(f.view.captureCharFrame(), /\[image #1\]/u);
  assert.match(f.view.captureCharFrame(), /图片：已添加/u);
  await f.act(async () => { f.view.mockInput.pressKey("v", { ctrl: true }); });
  assert.equal(count, 2);
  assert.match(f.view.captureCharFrame(), /\[image #2\]/u);
  await f.act(async () => { await f.control().submit(); });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].attachments.length, 2);
  assert.equal(f.submitted[0].attachments[0].content, image.dataUrl);
  assert.equal(f.submitted[0].attachments[1].type, "image");
});

test("本地 /paste 替换为图片而不调用模型，正文提交保留附件", { timeout: 15000 }, async t => {
  let count = 0;
  const f = await render(t, async () => { count++; return image; });
  await f.act(async () => { f.control().setDraftValue("/paste"); });
  await f.act(async () => { await f.control().submit(); });
  assert.equal(count, 1);
  assert.equal(f.submitted.length, 0);
  assert.match(f.view.captureCharFrame(), /\[image #1\]/u);
  assert.doesNotMatch(f.view.captureCharFrame(), /\/paste\s*\[image/u);
  await f.act(async () => { f.control().setDraftValue("[image #1] 请看这张图"); });
  assert.equal(count, 1);
  await f.act(async () => { await f.control().submit(); });
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].attachments[0].type, "image");
  assert.match(f.submitted[0].text, /请看这张图/u);
});

test("空剪贴板直接在主界面提示，不生成附件或发送模型", { timeout: 15000 }, async t => {
  const f = await render(t, async () => null);
  await f.act(async () => { f.view.mockInput.pressKey("v", { ctrl: true }); });
  assert.match(f.view.captureCharFrame(), /剪贴板中没有图片/u);
  assert.doesNotMatch(f.view.captureCharFrame(), /\[image #/u);
  assert.equal(f.submitted.length, 0);
});

test("终端截获 Ctrl+V 后的空 paste（纯图片剪贴板）也触发读取图片并插入占位符", { timeout: 15000 }, async t => {
  let count = 0;
  const f = await render(t, async () => { count++; return image; });
  await f.act(async () => { await f.view.mockInput.pasteBracketedText(""); });
  assert.equal(count, 1);
  assert.match(f.view.captureCharFrame(), /\[image #1\]/u);
  assert.match(f.view.captureCharFrame(), /图片：已添加/u);
  const f2 = await render(t, async () => null);
  await f2.act(async () => { await f2.view.mockInput.pasteBracketedText(""); });
  assert.match(f2.view.captureCharFrame(), /剪贴板中没有图片/u);
  assert.equal(f2.submitted.length, 0);
});

test("Windows 图片 reader 显式使用 STA，并区分无图片与执行失败", async t => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "comecode-clipboard-test-"));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));
  const reader = createNodeClipboardImageReader({ platform: "win32", tempDirectory, runCommand: async (file, args) => {
    assert.equal(file, "powershell.exe"); assert.ok(args.includes("-STA"));
    assert.match(args.at(-1), /ErrorActionPreference/u);
    return { exitCode: 2, stdout: Buffer.alloc(0) };
  } });
  assert.equal(await reader(), null);
  const failed = createNodeClipboardImageReader({ platform: "win32", tempDirectory, runCommand: async () => ({ exitCode: 1, stdout: Buffer.alloc(0) }) });
  await assert.rejects(failed(), /Windows 剪贴板读取失败/u);
});



test("图片读取失败可见且允许重试，重复 Ctrl+V 不会并发读取或重复添加", async t => {
  let count = 0, release;
  const f = await render(t, () => {
    count++;
    if (count === 1) throw new Error("测试读取失败");
    return new Promise(resolve => { release = resolve; });
  });
  await f.act(async () => { f.view.mockInput.pressKey("v", { ctrl: true }); });
  assert.match(f.view.captureCharFrame(), /读取剪贴板失败/u);
  await f.act(async () => { f.view.mockInput.pressKey("v", { ctrl: true }); f.view.mockInput.pressKey("v", { ctrl: true }); });
  assert.equal(count, 2);
  assert.match(f.view.captureCharFrame(), /正在读取剪贴板/u);
  await f.act(async () => { release(image); });
  assert.match(f.view.captureCharFrame(), /\[image #1\]/u);
  assert.doesNotMatch(f.view.captureCharFrame(), /\[image #2\]/u);
});
