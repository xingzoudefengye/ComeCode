import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_HEADLESS_WORKFLOW_DEADLINE_MS,
  waitForHeadlessWorkflowSettle,
} from "../packages/cli/src/headless-workflow.ts";

const runningRuntime = {
  hasActiveOrQueuedTurnWork: () => true,
  hasRunningBackgroundTasks: () => true,
};

test("headless workflow waits until both background and turn work settle", async () => {
  let running = true;
  const result = await waitForHeadlessWorkflowSettle({
    intervalMs: 1,
    runtime: {
      hasActiveOrQueuedTurnWork: () => running,
      hasRunningBackgroundTasks: () => running,
    },
    signal: new AbortController().signal,
    sleep: async () => {
      running = false;
    },
  });

  assert.equal(result, "settled");
});

test("headless workflow has a finite deadline and reports it", { timeout: 3000 }, async () => {
  let deadlineExceeded = false;
  const startedAt = Date.now();
  const result = await waitForHeadlessWorkflowSettle({
    deadlineMs: 10,
    intervalMs: 2,
    runtime: runningRuntime,
    signal: new AbortController().signal,
    onDeadlineExceeded: () => {
      deadlineExceeded = true;
    },
  });

  assert.equal(result, "deadline_exceeded");
  assert.equal(deadlineExceeded, true);
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(DEFAULT_HEADLESS_WORKFLOW_DEADLINE_MS, 30 * 60 * 1000);
});

test("headless workflow preserves user abort as a separate outcome", async () => {
  const controller = new AbortController();
  let sleepCount = 0;
  const result = await waitForHeadlessWorkflowSettle({
    intervalMs: 1,
    runtime: runningRuntime,
    signal: controller.signal,
    sleep: async () => {
      sleepCount += 1;
      controller.abort(new Error("user stopped"));
    },
  });

  assert.equal(result, "aborted");
  assert.equal(sleepCount, 1);
});
