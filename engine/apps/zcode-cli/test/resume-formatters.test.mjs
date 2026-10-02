import assert from "node:assert/strict";
import { test } from "node:test";
import { formatResumeResult } from "../packages/cli/src/command-center/formatters.ts";

const result = {
  appliedMessageCount: 2,
  directory: "E:/Projects/ComeCode",
  interruptedToolCount: 1,
  messageCount: 3,
  partCount: 8,
};

test("恢复信息显示当前模型", () => {
  const text = formatResumeResult("sess_test", result, "my-api/qwen3.8-max");
  assert.match(text, /Model: my-api\/qwen3\.8-max/u);
  assert.match(text, /Messages: 2\/3; parts: 8; interrupted tools: 1/u);
});

test("恢复信息没有模型时不显示空 Model 行", () => {
  const text = formatResumeResult("sess_test", result, "  ");
  assert.doesNotMatch(text, /Model:/u);
});
