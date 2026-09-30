import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SessionEventType } from "../packages/contracts/src/index.ts";
import { createExploreSubagentPort } from "../packages/core/src/subagent/runner.ts";
import { InMemoryRuntimeTaskRegistry } from "../packages/core/src/runtime-task/registry.ts";
import { taskOutputToolEntry } from "../packages/core/src/tool/handlers/task-output.ts";
import { runSubagentLifecycleEffect } from "../packages/core/src/subagent/lifecycle-effect.ts";

const never = () => new Promise(() => {});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const request = {
  sessionId: "parent",
  parentToolCallId: "tool-parent",
  agentType: "general-purpose",
  description: "test task",
  prompt: "test",
  workingDirectory: ".",
  workspaceRoot: ".",
  trace: { traceId: "trace-test", spanId: "span-test" },
};

async function fixture(t, run, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "comecode-supervision-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const finalizationWaiters = new Set();
  const updateTask = registry.update.bind(registry);
  registry.update = (...args) => {
    const task = updateTask(...args);
    for (const wake of finalizationWaiters) wake();
    return task;
  };
  const events = [];
  const notifications = [];
  let sequence = 0;
  const port = createExploreSubagentPort({
    outputRootDir: root,
    runtimeTaskRegistry: registry,
    inactivityTimeoutMs: 100,
    createAgentId: () => `agent-${++sequence}`,
    emitParentEvent: async (event) => {
      events.push(event);
    },
    enqueueParentTaskNotification: (message) => {
      notifications.push(message);
    },
    runExploreAgent: run,
    ...extra,
  });
  t.after(async () => {
    // 终态可早于产物写完；清理目录必须等待 registry 确认收尾实际退出。
    await new Promise((resolve) => {
      const wake = () => {
        if (
          Object.values(registry.all()).some(
            (task) => task.finalizationSettled === false || (task.pendingLifecycleEffects ?? 0) > 0,
          )
        )
          return;
        finalizationWaiters.delete(wake);
        resolve();
      };
      finalizationWaiters.add(wake);
      wake();
    });
    await rm(root, { recursive: true, force: true });
  });
  return { root, registry, events, notifications, port };
}

function completed(child, response = "done") {
  return { response, traceId: child.traceContext.traceId, events: [] };
}

test("显式后台卡住时收口失败并通知父会话，即使 child 忽略取消", { timeout: 3000 }, async (t) => {
  let childSignal;
  const f = await fixture(t, async (child, options) => {
    childSignal = options.signal;
    await child.onSessionReady();
    return never();
  });
  const launched = await f.port.start(request);
  const task = await f.port.waitForTask(launched.agentId);
  assert.equal(task.status, "failed");
  assert.match(task.error, /inactive/u);
  assert.equal(childSignal.aborted, true);
  assert.equal(task.executionSettled, false);
  // 终态先收口，通知在随后结算中送达。
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /failed/u);
});

test("后台启动永不 ready 也受期限保护", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, never);
  await assert.rejects(f.port.start(request), /inactive/u);
  assert.ok(Object.values(f.registry.all()).every((task) => task.status !== "running"));
});

test("前台转后台继续受监督，父调用先返回后台句柄", { timeout: 3000 }, async (t) => {
  const ready = deferred();
  const f = await fixture(t, async (child) => {
    await child.onSessionReady();
    ready.resolve();
    return never();
  });
  const result = f.port.run(request);
  await ready.promise;
  await f.port.backgroundTask("agent-1");
  assert.equal((await result).status, "async_launched");
  assert.equal((await f.port.waitForTask("agent-1")).status, "failed");
});

test("等待确认暂停无活动计时，确认后重新计时", { timeout: 3000 }, async (t) => {
  let report;
  const f = await fixture(t, async (child) => {
    report = child.reportActivity;
    await child.onSessionReady();
    report({ type: SessionEventType.PermissionRequested, payload: { toolCallId: "permission" } });
    return never();
  });
  const launched = await f.port.start(request);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(f.registry.get(launched.agentId).status, "running");
  report({ type: SessionEventType.PermissionResolved, payload: { toolCallId: "permission" } });
  assert.equal((await f.port.waitForTask(launched.agentId)).status, "failed");
});

test("超时迟到成功不能改写失败终态，旧执行未退出时拒绝恢复", { timeout: 3000 }, async (t) => {
  const completion = deferred();
  let childRequest;
  const f = await fixture(t, async (child) => {
    childRequest = child;
    await child.onSessionReady();
    return completion.promise;
  });
  const launched = await f.port.start(request);
  await f.port.waitForTask(launched.agentId);
  const resumed = await f.port.sendMessage({
    ...request,
    to: launched.agentId,
    summary: "retry",
    message: "continue",
  });
  assert.equal(resumed.status, "failed");
  completion.resolve(completed(childRequest, "late output"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.registry.get(launched.agentId).status, "failed");
  assert.equal(f.registry.get(launched.agentId).executionSettled, true);
  assert.equal(
    f.events.filter((event) => event.type === SessionEventType.SubagentStopped).length,
    1,
  );
});

test("失败产物写入失败仍收口并通知，其他子代理正常完成", { timeout: 3000 }, async (t) => {
  const failure = deferred();
  const f = await fixture(
    t,
    async (child) => {
      await child.onSessionReady();
      return child.agentId === "agent-1" ? failure.promise : completed(child);
    },
    { inactivityTimeoutMs: 0 },
  );
  const launched = await f.port.start(request);
  const outputDirectory = dirname(launched.outputFile);
  await rm(outputDirectory, { recursive: true });
  await writeFile(outputDirectory, "not a directory");
  failure.reject(new Error("original child failure"));
  assert.equal((await f.port.waitForTask(launched.agentId)).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(f.notifications[0].text, /original child failure/u);
  const other = await f.port.run(request);
  assert.equal(other.status, "completed");
});

test("父事件发送失败不会留下未处理 rejection 或 running 任务", { timeout: 3000 }, async (t) => {
  const f = await fixture(
    t,
    async (child) => {
      await child.onSessionReady();
      throw new Error("child failed");
    },
    {
      emitParentEvent: async (event) => {
        if (event.type !== SessionEventType.SubagentSpawned) throw new Error("sink failed");
      },
    },
  );
  const launched = await f.port.start(request);
  assert.equal((await f.port.waitForTask(launched.agentId)).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.notifications.length, 1);
});

test("通知入队首次失败会有限重试，成功后不重复入队", { timeout: 3000 }, async (t) => {
  let attempts = 0;
  const accepted = [];
  const f = await fixture(
    t,
    async (child) => {
      await child.onSessionReady();
      return completed(child);
    },
    {
      enqueueParentTaskNotification: (message) => {
        if (++attempts === 1) throw new Error("queue unavailable");
        accepted.push(message);
      },
    },
  );
  const launched = await f.port.start(request);
  await f.port.waitForTask(launched.agentId);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(attempts, 2);
  assert.equal(accepted.length, 1);
  assert.equal(f.registry.get(launched.agentId).notified, true);
});

test("TaskOutput 等待超时仅返回当前状态，不终止后台执行", { timeout: 3000 }, async (t) => {
  const f = await fixture(
    t,
    async (child) => {
      await child.onSessionReady();
      return never();
    },
    { inactivityTimeoutMs: 0 },
  );
  const launched = await f.port.start(request);
  const result = await taskOutputToolEntry.handler(
    { task_id: launched.agentId, block: true, timeout: 20 },
    { runtimeTaskRegistry: f.registry, abortSignal: new AbortController().signal },
  );
  assert.equal(result.retrieval_status, "timeout");
  assert.equal(f.registry.get(launched.agentId).status, "running");
  await f.port.stopTask(launched.agentId);
});

test("恢复后的后台执行仍受监督，新的 run 不继承旧 notified", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, async (child) => {
    await child.onSessionReady();
    return child.resumeFromStore ? never() : completed(child);
  });
  const launched = await f.port.start(request);
  await f.port.waitForTask(launched.agentId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const result = await f.port.sendMessage({
    ...request,
    to: launched.agentId,
    summary: "continue",
    message: "continue",
  });
  assert.equal(result.status, "success");
  assert.equal((await f.port.waitForTask(launched.agentId)).status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.notifications.length, 2);
});

test("前台永不返回也解除等待并保留失败状态", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, async (child) => {
    await child.onSessionReady();
    return never();
  });
  await assert.rejects(f.port.run(request), /inactive/u);
  assert.equal(f.registry.get("agent-1").status, "failed");
});

test("hook 确认嵌套 ID 暂停后能够恢复监督", { timeout: 3000 }, async (t) => {
  let report;
  const f = await fixture(t, async (child) => {
    report = child.reportActivity;
    await child.onSessionReady();
    report({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request: { interactionId: "hook-1" } },
    });
    return never();
  });
  const launched = await f.port.start(request);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(f.registry.get(launched.agentId).status, "running");
  report({
    type: SessionEventType.WorkspaceHookReviewSettled,
    payload: { interactionId: "hook-1" },
  });
  assert.equal((await f.port.waitForTask(launched.agentId)).status, "failed");
});

test("TaskStop 写盘与通知失败仍立即取消，有限重试后保留 killed", { timeout: 3000 }, async (t) => {
  let childSignal;
  let attempts = 0;
  const f = await fixture(
    t,
    async (child, options) => {
      childSignal = options.signal;
      await child.onSessionReady();
      return never();
    },
    {
      inactivityTimeoutMs: 0,
      enqueueParentTaskNotification: () => {
        attempts++;
        throw new Error("queue unavailable");
      },
    },
  );
  const launched = await f.port.start(request);
  const directory = dirname(launched.outputFile);
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  const stopping = f.port.stopTask(launched.agentId);
  assert.equal(childSignal.aborted, true);
  await stopping;
  assert.equal(attempts, 3);
  assert.equal(f.registry.get(launched.agentId).status, "killed");
  assert.notEqual(f.registry.get(launched.agentId).notified, true);
});

test("旧收尾写入未退出时拒绝恢复，写入退出后解除阻止", { timeout: 3000 }, async (t) => {
  const f = await fixture(t, async (child) => {
    await child.onSessionReady();
    return completed(child);
  });
  const launched = await f.port.start(request);
  await f.port.waitForTask(launched.agentId);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const task = f.registry.get(launched.agentId);
  const write = deferred();
  const effect = runSubagentLifecycleEffect(() => write.promise, {
    agentId: launched.agentId,
    effect: "test write",
    traceContext: task.traceContext,
    registry: f.registry,
  });
  const result = await f.port.sendMessage({
    ...request,
    to: launched.agentId,
    summary: "retry",
    message: "continue",
  });
  assert.equal(result.status, "failed");
  write.resolve();
  await effect;
  assert.equal(f.registry.get(launched.agentId).pendingLifecycleEffects, 0);
});

test(
  "恢复准备超时保留旧终态，迟到 metadata 写入退出前拒绝再次恢复",
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t, async (child) => {
      await child.onSessionReady();
      return completed(child);
    });
    const launched = await f.port.start(request);
    await f.port.waitForTask(launched.agentId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const previous = f.registry.get(launched.agentId);
    const write = deferred();
    const originalWrite = fsPromises.writeFile;
    const mockWrite = t.mock.method(fsPromises, "writeFile", (path, content, ...args) =>
      String(content).includes('"resumedAt"')
        ? write.promise
        : originalWrite(path, content, ...args),
    );
    syncBuiltinESMExports();
    try {
      const message = { ...request, to: launched.agentId, summary: "retry", message: "continue" };
      await assert.rejects(f.port.sendMessage(message), /inactive/u);
      assert.equal(f.registry.get(launched.agentId).status, previous.status);
      assert.equal(f.registry.get(launched.agentId).pendingLifecycleEffects, 1);
      assert.equal((await f.port.sendMessage(message)).status, "failed");
      write.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(f.registry.get(launched.agentId).pendingLifecycleEffects, 0);
    } finally {
      write.resolve();
      mockWrite.mock.restore();
      syncBuiltinESMExports();
    }
  },
);
