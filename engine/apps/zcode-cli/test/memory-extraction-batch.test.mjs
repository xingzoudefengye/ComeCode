import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSessionStore } from "../packages/adapters/src/storage/session-store/sqlite-session-store.ts";
import { createMemoryExtractionScheduler } from "../packages/core/src/memory/extraction.ts";
import { createMemoryExtractionProgressStore } from "../packages/core/src/memory/extraction-progress.ts";
import {
  scheduleProjectMemoryExtraction,
  resumeProjectMemoryExtraction,
} from "../packages/core/src/runtime/helpers/project-memory-extraction.ts";

const user = (id, text = "Please remember concise replies") => ({
  info: { id, role: "user" },
  parts: [{ type: "text", text }],
});
const snapshot = (messages) => ({
  boundaryMessageId: messages.at(-1).info.id,
  durableMessages: messages,
  memoryRoot: "/demo/.ai",
  workspaceRoot: "/demo",
  workingDirectory: "/demo",
});
function progressStore() {
  let state;
  const writes = [];
  return {
    writes,
    load: async () => state,
    save: async (value) => {
      state = structuredClone(value);
      writes.push(state);
    },
  };
}

function scheduler(store, execute) {
  return createMemoryExtractionScheduler(execute, { batch: true, progressStore: store });
}

test("累计三条短输入触发一次，中文有效输入不被空格词数门控漏掉", async () => {
  const store = progressStore();
  const runs = [];
  const s = scheduler(store, async ({ snapshot }) => {
    runs.push(snapshot.durableMessages.map((message) => message.info.id));
    return "success";
  });
  const messages = [user("a", "请以后使用简体中文"), user("b"), user("c")];
  for (let count = 1; count <= 3; count++) {
    s.schedule(snapshot(messages.slice(0, count)));
    await s.drain();
    assert.equal(runs.length, count === 3 ? 1 : 0);
  }
  assert.deepEqual(runs, [["a", "b", "c"]]);
  assert.equal((await store.load()).pending, undefined);
  s.schedule(snapshot(messages));
  await s.drain();
  assert.equal(runs.length, 1);
});

test("1500字符提前触发，显式保存绕过批量门槛", async () => {
  const store = progressStore();
  let calls = 0;
  const s = scheduler(store, async () => {
    calls++;
    return "no-op";
  });
  s.schedule(snapshot([user("a", "Please remember " + "x".repeat(1500))]));
  await s.drain();
  assert.equal(calls, 1);
  s.schedule(snapshot([user("a"), user("b")]), { force: true });
  await s.drain();
  assert.equal(calls, 2);
});

test("不足批量关闭仅保留本地pending，重启补一次且成功后不重放", async () => {
  const store = progressStore();
  let calls = 0;
  const first = scheduler(store, async () => {
    calls++;
    return "success";
  });
  const messages = [user("a")];
  first.schedule(snapshot(messages));
  first.shutdown();
  await first.drain();
  assert.equal(calls, 0);
  assert.equal((await store.load()).pending, "a");
  const second = scheduler(store, async () => {
    calls++;
    return "success";
  });
  second.schedule(snapshot(messages), { resumeOnly: true });
  await second.drain();
  assert.equal(calls, 1);
  const third = scheduler(store, async () => {
    calls++;
    return "success";
  });
  third.schedule(snapshot(messages), { resumeOnly: true });
  await third.drain();
  assert.equal(calls, 1);
});

test("提取中关闭取消请求，仍保存更新的pending，重启读取全部未确认增量", async () => {
  const store = progressStore();
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const first = scheduler(store, async ({ abortSignal }) => {
    started();
    await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
    return "aborted";
  });
  const messages = [user("a"), user("b"), user("c"), user("d")];
  first.schedule(snapshot(messages.slice(0, 3)));
  await ready;
  first.schedule(snapshot(messages));
  first.shutdown();
  await first.drain();
  assert.equal((await store.load()).pending, "d");
  assert.equal((await store.load()).cursor, undefined);
  let received;
  const second = scheduler(store, async ({ snapshot }) => {
    received = snapshot.durableMessages.map((message) => message.info.id);
    return "success";
  });
  second.schedule(snapshot(messages), { resumeOnly: true });
  await second.drain();
  assert.deepEqual(received, ["a", "b", "c", "d"]);
});

test("积压按消息顺序限批，成功游标不能跳过输入预算之外的消息", async () => {
  const store = progressStore();
  const messages = [
    user("a", "Please remember " + "a".repeat(3500)),
    user("b", "Please remember " + "b".repeat(3500)),
  ];
  const runs = [];
  const s = scheduler(store, async ({ snapshot }) => {
    runs.push(snapshot.durableMessages.map((message) => message.info.id));
    return "success";
  });
  s.schedule(snapshot(messages));
  await s.drain();
  assert.equal((await store.load()).cursor, "a");
  assert.equal((await store.load()).pending, "b");
  s.schedule(snapshot(messages));
  await s.drain();
  assert.deepEqual(runs, [["a"], ["b"]]);
});

test("失败保留pending并退避，无记录的旧会话恢复不提取整个历史", async () => {
  const store = progressStore();
  let calls = 0;
  const messages = [user("a"), user("b"), user("c")];
  const s = scheduler(store, async () => {
    calls++;
    return "error";
  });
  s.schedule(snapshot([user("old")]), { resumeOnly: true });
  await s.drain();
  assert.equal(calls, 0);
  s.schedule(snapshot([user("old"), ...messages]));
  await s.drain();
  assert.equal(calls, 1);
  s.schedule(snapshot([user("old"), ...messages]));
  await s.drain();
  assert.equal(calls, 1);
  assert.equal((await store.load()).pending, "c");
  assert.ok((await store.load()).retryAfter > Date.now());
});

test("批次中的直接写入不丢弃其它轮次的用户信息", async () => {
  const store = progressStore();
  let calls = 0;
  const s = scheduler(store, async () => {
    calls++;
    return "success";
  });
  s.schedule(
    snapshot([
      user("a"),
      user("b"),
      user("c"),
      {
        info: { id: "d", role: "assistant" },
        parts: [
          { type: "tool", tool: "Write", state: { input: { file_path: "/demo/.ai/tasks.md" } } },
        ],
      },
    ]),
  );
  await s.drain();
  assert.equal(calls, 1);
});

test("进度持久化失败不发模型，不创建第二个请求队列", async () => {
  let calls = 0;
  const s = scheduler(
    {
      load: async () => undefined,
      save: async () => {
        throw new Error("mock io");
      },
    },
    async () => {
      calls++;
      return "success";
    },
  );
  s.schedule(snapshot([user("a"), user("b"), user("c")]));
  await s.drain();
  assert.equal(calls, 0);
});

test("旧会话首次恢复建立基线，后续只提取新输入", async () => {
  const store = progressStore();
  const runs = [];
  const s = scheduler(store, async ({ snapshot }) => {
    runs.push(snapshot.durableMessages.map((message) => message.info.id));
    return "success";
  });
  const old = user("old", "Please remember old history");
  s.schedule(snapshot([old]), { resumeOnly: true });
  await s.drain();
  s.schedule(snapshot([old, user("new")]), { force: true });
  await s.drain();
  assert.deepEqual(runs, [["new"]]);
});

test("回退移除cursor或pending时建立当前分支基线，不重放旧历史", async () => {
  for (const progress of [
    { cursor: "removed", pending: "removed" },
    { cursor: "a", pending: "removed" },
  ]) {
    const store = progressStore();
    await store.save(progress);
    const runs = [];
    const s = scheduler(store, async ({ snapshot }) => {
      runs.push(snapshot.durableMessages.map((message) => message.info.id));
      return "success";
    });
    const messages = [user("a"), user("b"), user("c")];
    s.schedule(snapshot(messages), { resumeOnly: true });
    await s.drain();
    assert.deepEqual(runs, []);
    assert.deepEqual(await store.load(), { cursor: "c" });
    s.schedule(snapshot([...messages, user("new")]), { force: true });
    await s.drain();
    assert.deepEqual(runs, [["new"]]);
  }
});

test("Runtime恢复自动补跑已保存pending，不需要新消息或等待模型", async () => {
  const entries = new Map();
  const messages = [user("a")];
  let calls = 0;
  const inputs = [];
  function runtime() {
    function model(options = { reasoningLevel: "low" }) {
      return {
        providerId: "mock",
        modelId: "memory",
        options,
        properties: {},
        optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 9000 } },
        bind: (patch) => model({ ...options, ...patch }),
        generateText: async (request) => {
          calls++;
          inputs.push(request.messages.find((message) => message.role === "user").content);
          return {
            text: "Nothing to save.",
            usage: { inputTokens: 10, outputTokens: 1 },
            finishReason: "stop",
          };
        },
      };
    }
    return {
      sessionId: "s",
      latestConversationMessageId: "a",
      workspaceRoot: "/demo",
      workingDirectory: "/demo",
      config: { memory: { enabled: true, scope: "project" } },
      isRemoteWorkspace: () => false,
      fileSystemPort: {},
      getSessionModelSelection: () => ({ providerId: "mock", modelId: "memory" }),
      modelFactory: () => model(),
      getTools: () => [],
      agentTelemetry: {
        captureCausation() {},
        detached: () => ({
          run: (fn) => fn(),
          finishCompleted() {},
          finishFailed() {},
          finishCancelled() {},
        }),
      },
      sessionStore: {
        messages: async () => messages,
        getSession: async () => ({}),
        sessionEntries: async () => [...entries.values()],
        saveSessionEntry: async (entry) => entries.set(entry.id, entry),
      },
    };
  }
  const first = runtime();
  assert.equal(
    scheduleProjectMemoryExtraction(first, { model: first.modelFactory(), traceContext: {} }),
    true,
  );
  await first.memoryExtractionScheduler.drain();
  assert.equal(calls, 0);
  first.memoryExtractionScheduler.shutdown();
  const restored = runtime();
  assert.equal(resumeProjectMemoryExtraction(restored, {}), undefined);
  assert.equal(calls, 0);
  await restored.memoryExtractionScheduler.drain();
  assert.equal(calls, 1);
  const disabled = runtime();
  disabled.config.memory.extractionEnabled = false;
  resumeProjectMemoryExtraction(disabled, {});
  assert.equal(disabled.memoryExtractionScheduler, undefined);
  messages.push(user("large", "Please remember " + "x".repeat(10000)));
  restored.latestConversationMessageId = "large";
  scheduleProjectMemoryExtraction(restored, { model: restored.modelFactory(), traceContext: {} });
  await restored.memoryExtractionScheduler.drain();
  assert.equal(calls, 2);
  assert.equal(inputs.at(-1).length, 6000);
});

test("SQLite固定entry覆盖保存进度且按根范围隔离，无需数据库迁移", async (t) => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  await store.createSession({
    id: "s",
    projectID: "p",
    slug: "s",
    directory: "/demo",
    title: "fixture",
    version: "test",
  });
  const progress = createMemoryExtractionProgressStore(store, "s", "project");
  await progress.save({ pending: "b" });
  await progress.save({ cursor: "a", pending: "b" });
  assert.deepEqual(await progress.load(), { cursor: "a", pending: "b", retryAfter: undefined });
  assert.equal(
    (await store.sessionEntries({ sessionID: "s", type: "runtime/memory_extraction" })).length,
    1,
  );
  assert.equal(await createMemoryExtractionProgressStore(store, "s", "user").load(), undefined);
});
