import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWindowsShiftState } from "../packages/cli/src/windows-keyboard-state.ts";

test("Windows shift state is unavailable on non-Windows platforms", async () => {
  assert.equal(await loadWindowsShiftState({ platform: "linux" }), undefined);
});

test("Windows shift state reads the high bit from GetAsyncKeyState", async () => {
  let value = 0;
  const isShiftPressed = await loadWindowsShiftState({
    api: { getAsyncKeyState: () => value },
    platform: "win32",
  });
  assert.ok(isShiftPressed);
  assert.equal(isShiftPressed(), false);
  value = 0x8000;
  assert.equal(isShiftPressed(), true);
});

test("Windows shift state falls back when native API throws", async () => {
  const isShiftPressed = await loadWindowsShiftState({
    api: { getAsyncKeyState: () => { throw new Error("native failure"); } },
    platform: "win32",
  });
  assert.ok(isShiftPressed);
  assert.equal(isShiftPressed(), false);
});
