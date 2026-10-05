import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLocalCompactHandoff } from "../packages/core/src/compact/local-handoff.ts";
import { buildCompactSummaryMessage } from "../packages/core/src/compact/prompt.ts";

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
  assert.match(result.summary, /原始记录仍在本地/u);
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

test("无新用户消息的反复压缩沿用目标，保留状态来源且不嵌套包装", () => {
  let handoff = buildLocalCompactHandoff({
    entries: [{ message: { role: "user", content: "持续目标：把压缩功能做完并验收" } }],
  });
  for (let index = 0; index < 20; index++) {
    handoff = buildLocalCompactHandoff({
      entries: [
        {
          message: {
            role: "user",
            content: buildCompactSummaryMessage(handoff.summary, {
              workGuide: handoff.guide,
              suppressFollowup: true,
            }),
          },
          metadata: { source: "legacy_synthetic" },
        },
        { message: { role: "assistant", content: `本轮检查 ${index}，尚未验收` } },
        {
          message: { role: "user", content: "目标已暂停" },
          metadata: { source: "goal_state_change" },
        },
        {
          message: { role: "user", content: "新增约束：保留已有修改" },
          metadata: { source: "incoming_message" },
        },
      ],
      maxChars: 1_600,
    });
    assert.match(handoff.guide, /持续目标：把压缩功能做完并验收/u);
    assert.match(handoff.summary, /goal_state_change: 目标已暂停/u);
    assert.match(handoff.summary, /incoming_message: 新增约束/u);
    assert.doesNotMatch(handoff.guide + handoff.summary, /This session is being continued/u);
    assert.ok(handoff.guide.length + handoff.summary.length <= 1_600);
  }
});
