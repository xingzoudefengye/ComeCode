import assert from "node:assert/strict";
import { test } from "node:test";
import { ConcurrencyController } from "../packages/dynamic-workflow/src/engine/concurrency.ts";
import { cancelRunningRuntimeBackgroundTasks } from "../packages/core/src/runtime/methods/background.ts";
import { registerRuntimeBackgroundTask } from "../packages/core/src/tool/executor/background-task-registry.ts";
import { resolveWorkflowConcurrencyCeiling } from "../packages/bootstrap/src/app/workflow-concurrency-ceiling.ts";
import { getWorkflowConcurrencyGovernor, workflowConcurrencyKey } from "../packages/bootstrap/src/app/workflow-concurrency-governor.ts";

test("近期慢响应降档，同批结果不重复降档，快速成功后逐档恢复", () => {
  const c = new ConcurrencyController("fixture", 3);
  const epochs = [c.admitted(0), c.admitted(0), c.admitted(0)];
  assert.deepEqual(c.succeeded(31000, epochs[0], 31000), []);
  assert.equal(c.succeeded(32000, epochs[1], 32000)[0].reason, "slow_response");
  assert.equal(c.snapshot().cap, 2);
  c.succeeded(33000, epochs[2], 33000);
  assert.equal(c.snapshot().cap, 2);
  for (let i = 0; i < 2; i++) c.succeeded(34000 + i, c.admitted(34000 + i), 40000);
  assert.equal(c.snapshot().cap, 1);
  c.waiters(35000, 1);
  for (let i = 0; i < 4; i++) c.succeeded(35000 + i, c.admitted(35000 + i), 1000);
  assert.equal(c.snapshot().cap, 2);
  c.throttled(36000, c.admitted(36000), "rate_limited", 10000);
  assert.equal(c.snapshot().cap, 1);
  assert.equal(c.canAdmit(37000), false);
});

test("普通子代理共享供应商闸门，主代理优先，取消排队不漏槽", async () => {
  assert.equal(resolveWorkflowConcurrencyCeiling(() => 64), 3);
  assert.equal(workflowConcurrencyKey({ providerId: "fixture", modelId: "a" }), workflowConcurrencyKey({ providerId: "fixture", modelId: "b" }));
  const governor = getWorkflowConcurrencyGovernor();
  const main = governor.observer();
  const child = main.forSubagent("child-fixture");
  const model = { providerId: "fixture-admission", modelId: "a" };
  const tickets = [];
  for (let i = 0; i < 3; i++) {
    const ticket = child.tryAcquire({ model });
    if (ticket) tickets.push(ticket);
  }
  assert.ok(tickets.length >= 1 && tickets.length <= 3);
  assert.equal(child.tryAcquire({ model }), undefined);
  const controller = new AbortController();
  const waiting = child.acquire({ model, signal: controller.signal });
  controller.abort(new Error("cancel queued"));
  await assert.rejects(waiting, /cancel queued/);
  const priority = main.tryAcquire({ model });
  assert.ok(priority);
  priority.release();
  for (const ticket of tickets) ticket.release();
  assert.equal(governor.snapshot(workflowConcurrencyKey(model)).inFlight, 0);
});

test("后台默认归属当前回合，session 显式保留，清理不跨回合", async () => {
  const tasks = new Map();
  const deps = { runtimeTaskRegistry: { get: id => tasks.get(id), register: task => tasks.set(task.taskId, task) } };
  registerRuntimeBackgroundTask(deps, { id: "call-a", name: "Bash", input: { command: "fixture" } }, "temp", {}, "turn-a");
  registerRuntimeBackgroundTask(deps, { id: "call-b", name: "Bash", input: { command: "fixture", background_scope: "session" } }, "keep", {}, "turn-a");
  registerRuntimeBackgroundTask(deps, { id: "call-c", name: "Bash", input: {} }, "other", {}, "turn-b");
  assert.equal(tasks.get("temp").backgroundScope, "turn");
  const stopped = [];
  const runtime = { config: {}, rootTraceContext: {}, runtimeTaskRegistry: { all: () => Object.fromEntries(tasks) }, stopBackgroundTask: async id => stopped.push(id) };
  await cancelRunningRuntimeBackgroundTasks.call(runtime, { reason: "turn_terminal", traceContext: { turnId: "turn-a" } });
  assert.deepEqual(stopped, ["temp"]);
  assert.equal(tasks.get("keep").backgroundScope, "session");
});
