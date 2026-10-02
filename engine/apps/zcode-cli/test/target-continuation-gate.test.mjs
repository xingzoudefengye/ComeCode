import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGoalContinuationPrompt } from "../packages/contracts/src/tools/target.ts";
import { canContinueAfterTargetVerification } from "../packages/core/src/runtime/methods/target.ts";

test("目标暂停是完成验证之后的硬闸门", () => {
  const active = { targetID: "goal-1", status: "active" };
  const paused = { targetID: "goal-1", status: "paused" };
  assert.equal(
    canContinueAfterTargetVerification({
      initialTarget: active,
      latestTarget: paused,
      hasPendingUserCommand: false,
    }),
    false,
  );
  assert.equal(
    canContinueAfterTargetVerification({
      initialTarget: active,
      latestTarget: active,
      hasPendingUserCommand: true,
    }),
    false,
  );
  assert.equal(
    canContinueAfterTargetVerification({
      initialTarget: active,
      latestTarget: active,
      hasPendingUserCommand: false,
    }),
    true,
  );
});

test("目标替换也会使旧完成验证结果失效", () => {
  assert.equal(
    canContinueAfterTargetVerification({
      initialTarget: { targetID: "goal-1", status: "active" },
      latestTarget: { targetID: "goal-2", status: "active" },
      hasPendingUserCommand: false,
    }),
    false,
  );
});

test("目标续跑提示保留目标状态，不把验证器当作用户授权", () => {
  const prompt = formatGoalContinuationPrompt({
    targetID: "goal-1",
    status: "active",
    objective: "完成缓存验收",
    summaryTitle: null,
    sessionID: "session-1",
    tokenBudget: 1000,
    tokensUsed: 10,
    timeUsedSeconds: 1,
    time: { created: 0, updated: 0 },
  }, { nextAction: "运行最小测试", reason: "仍有一个测试缺口" });
  assert.match(prompt, /active session goal/);
  assert.match(prompt, /运行最小测试/);
});
