import assert from "node:assert/strict";
import { test } from "node:test";
import { createShiftEnterFallbackHandler } from "../packages/tui/src/tui-keyboard-fallback.ts";

function createRenderer() {
  const keys = [];
  return {
    keys,
    _internalKeyInput: {
      processParsedKey: (key) => keys.push(key),
    },
  };
}

test("bare Enter is converted to shifted Enter only while Shift is pressed", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => true);
  assert.equal(handler("\r"), true);
  assert.equal(renderer.keys.length, 1);
  assert.equal(renderer.keys[0].name, "return");
  assert.equal(renderer.keys[0].shift, true);
  assert.equal(handler("\n"), true);
  assert.equal(renderer.keys.length, 2);
  assert.equal(handler("x"), false);
});

test("bare Enter remains available to normal submission without Shift", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => false);
  assert.equal(handler("\r"), false);
  assert.deepEqual(renderer.keys, []);
});

test("ESC-prefixed return from conpty/VS Code is rewritten to shifted Enter", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => false);
  assert.equal(handler("\x1b\r"), true);
  assert.equal(renderer.keys[0].name, "return");
  assert.equal(renderer.keys[0].shift, true);
  assert.equal(handler("\x1b\n"), true);
  assert.equal(renderer.keys.length, 2);
});

test("CRLF (\r\n) is rewritten to shifted Enter while Shift is pressed", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => true);
  assert.equal(handler("\r\n"), true);
  assert.equal(renderer.keys[0].shift, true);
  assert.equal(handler("\x1b\r\n"), true);
  assert.equal(renderer.keys.length, 2);
});

test("other escape sequences are not mistaken for Shift+Enter", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => true);
  assert.equal(handler("\x1b[A"), false); // 方向键上
  assert.equal(handler("\x1b[13;2u"), false); // 原生 Kitty Shift+Enter，交给原生解析
  assert.deepEqual(renderer.keys, []);
});

test("Kitty shift-enter sequence is left for native parsing", () => {
  const renderer = createRenderer();
  const handler = createShiftEnterFallbackHandler(renderer, () => true);
  assert.equal(handler("\x1b[13;2u"), false);
  assert.deepEqual(renderer.keys, []);
});
