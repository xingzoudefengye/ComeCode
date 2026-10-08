import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  INPUT_FLOOD_IDLE_MS,
  INPUT_FLOOD_LIMIT,
  assessInputFlood,
  detectInsertion,
  inputFloodNotice,
  singleRepeatedChar,
} from "../packages/tui/src/app-input-flood.ts";
import { InputPane } from "../packages/tui/src/app-input-pane.tsx";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);

test("连发未越界时放行，并累计同一字符的次数", () => {
  const first = assessInputFlood(undefined, "abc", "abcu", 1_000);
  assert.equal(first.blocked, false);
  assert.equal(first.acceptedText, "abcu");
  assert.deepEqual(first.state, { char: "u", count: 1, lastAt: 1_000 });

  const second = assessInputFlood(first.state, "abcu", "abcuu", 1_030);
  assert.equal(second.blocked, false);
  assert.equal(second.state?.count, 2);
});

test("同一字符连发超过阈值时整段丢弃，并只提示一次", () => {
  let state;
  let text = "abc";
  let verdict;
  // 逐字追加：前 LIMIT 次放行，第 LIMIT+1 次越界。
  for (let index = 0; index <= INPUT_FLOOD_LIMIT; index += 1) {
    const next = `${text}u`;
    verdict = assessInputFlood(state, text, next, 1_000 + index * 30);
    state = verdict.state;
    text = verdict.blocked ? verdict.acceptedText : next;
  }

  assert.equal(verdict.blocked, true);
  assert.equal(text, "abc", "整段连发都应被剥掉，而不是只丢最后一个字符");
  assert.deepEqual(verdict.notice, { char: "u", count: INPUT_FLOOD_LIMIT + 1 });

  // 连发继续时不再重复提示，但仍然继续丢弃。
  const again = assessInputFlood(state, "abc", "abcu", 1_000 + (INPUT_FLOOD_LIMIT + 1) * 30);
  assert.equal(again.blocked, true);
  assert.equal(again.acceptedText, "abc");
  assert.equal(again.notice, undefined);
});

test("光标在中间时的连发同样被识别并整段丢弃", () => {
  let state;
  let text = "abcdef";
  let verdict;
  for (let index = 0; index <= INPUT_FLOOD_LIMIT; index += 1) {
    // 在 abc 与 def 之间反复插入同一个字符。
    const next = `${text.slice(0, 3)}u${text.slice(3)}`;
    verdict = assessInputFlood(state, text, next, 1_000 + index * 30);
    state = verdict.state;
    text = verdict.blocked ? verdict.acceptedText : next;
  }

  assert.equal(verdict.blocked, true);
  assert.equal(text, "abcdef");
  assert.deepEqual(verdict.notice, { char: "u", count: INPUT_FLOOD_LIMIT + 1 });
});

test("间隔超过空闲窗口后重新计数，长时间的正常输入不会被拦", () => {
  const burst = assessInputFlood(undefined, "x", "xu", 1_000);
  const afterPause = assessInputFlood(burst.state, "xu", "xuu", 1_000 + INPUT_FLOOD_IDLE_MS + 1);
  assert.equal(afterPause.blocked, false);
  assert.equal(afterPause.state?.count, 1);
});

test("一次性写入的长重复串按粘贴放行", () => {
  const pasted = "u".repeat(200);
  const verdict = assessInputFlood(undefined, "abc", `abc${pasted}`, 1_000);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.acceptedText, `abc${pasted}`);
  assert.equal(verdict.state, undefined);
});

test("删除、替换与混入其它字符都会重置连发计数", () => {
  const opened = assessInputFlood(undefined, "abc", "abcu", 1_000);
  assert.equal(assessInputFlood(opened.state, "abcu", "abc", 1_010).state, undefined, "删除要重置");
  assert.equal(
    assessInputFlood(opened.state, "abcu", "abcX", 1_010).state,
    undefined,
    "等长替换要重置",
  );
  assert.equal(
    assessInputFlood(opened.state, "abcu", "abcuXY", 1_010).state,
    undefined,
    "混入其它字符要重置",
  );

  const other = assessInputFlood(opened.state, "abcu", "abcuX", 1_010);
  assert.equal(other.blocked, false);
  assert.equal(other.state?.char, "X", "换成别的字符是另一段连发");
});

test("纯插入检测与提示文案", () => {
  assert.deepEqual(detectInsertion("abc", "abcuu"), { offset: 3, text: "uu" });
  assert.deepEqual(detectInsertion("abcdef", "abcuuudef"), { offset: 3, text: "uuu" });
  assert.equal(detectInsertion("abc", "abc"), undefined);
  assert.equal(detectInsertion("abcu", "abc"), undefined);
  assert.equal(detectInsertion("abcu", "abcX"), undefined, "等长替换不是插入");
  assert.equal(singleRepeatedChar("uuu"), "u");
  assert.equal(singleRepeatedChar(""), undefined);
  assert.equal(singleRepeatedChar("uux"), undefined);
  assert.equal(inputFloodNotice("u", 260).includes("260"), true);
  assert.equal(inputFloodNotice(" ", 120).includes("空格"), true);
});

/** 与真实 TUI 一致：受控值由上层 useState 持有，输入回调写回该状态。 */
function Harness({ editorRef, onFlood, onInput }) {
  const [draft, setDraft] = React.useState("abc");
  return React.createElement(InputPane, {
    busy: false,
    editorRef,
    focused: true,
    onInput: (value) => {
      onInput(value);
      setDraft(value);
    },
    onInputFlood: onFlood,
    onSubmit: () => {},
    resetCursorToEndVersion: 0,
    value: draft,
  });
}

test("输入框丢弃整段畸形连发，只保留连发前的内容", async (t) => {
  const floods = [];
  const editorRef = React.createRef();
  const view = await testRender(
    React.createElement(Harness, {
      editorRef,
      onFlood: (char, count) => floods.push([char, count]),
      onInput: () => {},
    }),
    { height: 12, width: 80, kittyKeyboard: true },
  );
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });
  await React.act(async () => {
    await view.renderOnce();
  });
  editorRef.current.gotoBufferEnd();

  // 每次按键都单独提交一次渲染，模拟真实键盘连发的节奏。
  const pressOnce = async () => {
    await React.act(async () => {
      await view.mockInput.pressKeys(["u"]);
      await view.renderOnce();
    });
  };

  await pressOnce();
  await pressOnce();
  await pressOnce();
  assert.equal(editorRef.current.plainText, "abcuuu", "少量重复仍是正常输入");
  assert.deepEqual(floods, []);

  let presses = 0;
  while (floods.length === 0 && presses < INPUT_FLOOD_LIMIT * 2) {
    await pressOnce();
    presses += 1;
  }

  assert.equal(floods.length, 1, "整段连发只提示一次");
  assert.deepEqual(floods[0], ["u", INPUT_FLOOD_LIMIT + 1]);
  assert.equal(editorRef.current.plainText, "abc", "越界后整段连发被丢弃");

  await pressOnce();
  await pressOnce();
  assert.equal(floods.length, 1, "连发未停止时不重复提示");
  assert.equal(editorRef.current.plainText, "abc");
});
