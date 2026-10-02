import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeSessionProcessTitle,
  setSessionProcessTitle,
} from "../packages/cli/src/process-title.ts";

test("normalizeSessionProcessTitle trims whitespace", () => {
  assert.equal(normalizeSessionProcessTitle("  fix cache  "), "fix cache");
});

test("normalizeSessionProcessTitle keeps title within 30 characters", () => {
  assert.equal(normalizeSessionProcessTitle("a".repeat(30)), "a".repeat(30));
  assert.equal(normalizeSessionProcessTitle("a".repeat(31)), "a".repeat(30));
});

test("normalizeSessionProcessTitle truncates by code point, not byte", () => {
  const emoji = "😀".repeat(40); // 40 个码点，UTF-16 长度 80
  assert.equal(normalizeSessionProcessTitle(emoji), "😀".repeat(30));
});

test("normalizeSessionProcessTitle returns undefined for empty or blank title", () => {
  assert.equal(normalizeSessionProcessTitle(undefined), undefined);
  assert.equal(normalizeSessionProcessTitle(""), undefined);
  assert.equal(normalizeSessionProcessTitle("   "), undefined);
});

test("setSessionProcessTitle updates process.title for a valid title", () => {
  const previous = process.title;
  try {
    setSessionProcessTitle("  implement cache  ");
    assert.equal(process.title, "implement cache");
  } finally {
    process.title = previous;
  }
});

test("setSessionProcessTitle does not override default for blank title", () => {
  const previous = process.title;
  try {
    setSessionProcessTitle("   ");
    assert.equal(process.title, previous);
  } finally {
    process.title = previous;
  }
});
