import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTerminalTabTitle } from "../../../packages/ui/src/terminal/terminalPanelState.ts";

test("terminal tab title uses shell label only and stays within 30 characters", () => {
  assert.equal(formatTerminalTabTitle("PowerShell"), "PowerShell");
  assert.equal(formatTerminalTabTitle("bash"), "bash");
  assert.equal(formatTerminalTabTitle(null), "Terminal");
  assert.equal(formatTerminalTabTitle("a".repeat(40)), `${"a".repeat(27)}...`);
});
