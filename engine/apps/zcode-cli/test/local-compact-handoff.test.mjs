import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalCompactHandoff } from "../packages/core/src/compact/local-handoff.ts";

test("本地交接优先保留最近目标和进展，并截断旧工具输出", () => {
  const result = buildLocalCompactHandoff({
    entries: [
      { message: { role: "user", content: "很早以前的任务" } },
      { message: { role: "assistant", content: "旧阶段已经完成" } },
      {
        message: {
          role: "tool",
          toolName: "Read",
          toolCallId: "call-old",
          content: "旧工具输出 ".repeat(2_000),
        },
      },
      { message: { role: "user", content: "继续修复压缩，让它更快更省 token" } },
      { message: { role: "assistant", content: "已完成本地交接逻辑，准备补测试" } },
    ],
    preservedEntries: [{ message: { role: "user", content: "最近仍需继续的工作" } }],
  });

  assert.match(result.guide, /继续修复压缩/u);
  assert.match(result.summary, /准备补测试/u);
  assert.match(result.summary, /最近一组原始消息已保留/u);
  assert.ok(result.summary.length <= 2_400);
  assert.ok(!result.summary.includes("旧工具输出 ".repeat(100)));
});

test("本地交接固定容量，不会随旧历史线性增长", () => {
  const result = buildLocalCompactHandoff({
    entries: Array.from({ length: 100 }, (_, index) => ({
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `历史记录 ${index} `.repeat(500),
      },
    })),
  });

  assert.ok(result.guide.length <= 2_400);
  assert.ok(result.summary.length <= 2_400);
});
