import assert from "node:assert/strict";
import { test } from "node:test";
import { titleFromInput } from "../packages/core/src/runtime/helpers/project.ts";

test("session title fallback is compact and limited to 30 characters", () => {
  assert.equal(titleFromInput("  fix   the   login   flow  "), "fix the login flow");
  assert.equal(titleFromInput(""), "Untitled session");
  const title = titleFromInput("abcdefghijklmnopqrstuvwxyz1234567890");
  assert.equal(title, "abcdefghijklmnopqrstuvwxyz1...");
  assert.ok([...title].length <= 30);
});
