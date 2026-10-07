import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRuntime } from "../packages/core/src/runtime/agent-runtime.ts";
import { createSqliteSessionStore } from "../packages/adapters/src/storage/session-store.ts";

async function fixture(t, { long = true, failSave = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "comecode-resume-runtime-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const sessionId = "sess_00000000-0000-0000-0000-000000000009";
  await store.createSession({
    id: sessionId,
    projectID: "fixture",
    slug: "fixture",
    directory: workspace,
    title: "恢复测试",
    version: "test",
    time: { created: 1, updated: 1 },
  });
  const contents = [
    "旧任务",
    "OLD_LARGE_HISTORY_SENTINEL" + (long ? "a".repeat(250_000) : ""),
    "最近要求",
    "最近进展",
  ];
  for (let i = 0; i < contents.length; i++) {
    const id = `msg_00000000-0000-0000-0000-00000000000${i}`;
    await store.saveMessage({
      id,
      sessionID: sessionId,
      role: i % 2 ? "assistant" : "user",
      time: { created: i + 1, ...(i % 2 ? { completed: i + 1 } : {}) },
      ...(i % 2
        ? {
            modelID: "mock",
            providerID: "fixture",
            mode: "build",
            path: { cwd: workspace, root: workspace },
            tokens: { input: long ? 80_000 : 100, output: 1, cache: { read: 0, write: 0 } },
          }
        : {}),
    });
    await store.savePart({
      id: `${id}-text`,
      messageID: id,
      sessionID: sessionId,
      type: "text",
      text: contents[i],
    });
  }
  const events = [];
  const requests = [];
  const model = {
    providerId: "fixture",
    modelId: "mock",
    properties: {
      contextWindow: 512_000,
      supportsMidConversationSystem: true,
      inputFormat: { supportsPdf: false, supportsImage: false },
    },
    optionSpecs: { maxOutputTokens: { max: 32_000 } },
    options: {},
    bind() {
      return this;
    },
    async generateText(request) {
      requests.push(request);
      return {
        text: "本地 mock 完成",
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
      };
    },
    streamText() {
      throw new Error("不能调用流式或摘要模型");
    },
  };
  const makeRuntime = () =>
    new AgentRuntime(
      sessionId,
      {
        workingDirectory: workspace,
        modelSelection: { providerId: "fixture", modelId: "mock" },
        modelStreaming: "off",
        memory: { enabled: false, extractionEnabled: false },
        mcp: { enabled: false },
        titleGeneration: { enabled: false },
      },
      {
        sessionStore: store,
        eventStore: {
          append: async (event) => {
            event.sequenceNumber = events.length + 1;
            events.push(event);
            return event;
          },
          getEvents: async () => events,
          appendEvents: async (batch) => {
            events.push(...batch);
          },
        },
        modelFactory: () => model,
      },
    );
  const originalSavePart = store.savePart.bind(store);
  if (failSave)
    store.savePart = async (part) => {
      if (part.type === "compaction" && part.compactBoundary)
        throw new Error("mock compact persistence failed");
      return originalSavePart(part);
    };
  return {
    store,
    requests,
    events,
    makeRuntime,
    sessionId,
    restoreSave: () => {
      store.savePart = originalSavePart;
    },
  };
}

test("真实恢复只在首请求交接，当前输入完整保存，冷恢复不重发旧历史", async (t) => {
  const f = await fixture(t);
  const runtime = f.makeRuntime();
  await runtime.resumeFromStore();
  assert.equal(f.requests.length, 0);
  assert.equal(
    (await f.store.messages({ sessionID: f.sessionId })).some((m) =>
      m.parts.some((p) => p.compactBoundary),
    ),
    false,
  );
  const current = "CURRENT_INPUT_SENTINEL" + "保留".repeat(2_000);
  await runtime.executeTurn(current);
  assert.equal(f.requests.length, 1);
  const first = JSON.stringify(f.requests[0].messages);
  assert.doesNotMatch(first, /OLD_LARGE_HISTORY_SENTINEL/u);
  assert.ok(first.includes(current));
  const persisted = await f.store.messages({ sessionID: f.sessionId });
  assert.ok(JSON.stringify(persisted).includes("OLD_LARGE_HISTORY_SENTINEL"));
  assert.ok(JSON.stringify(persisted).includes(current));
  const boundaries = () =>
    f.store
      .messages({ sessionID: f.sessionId })
      .then((messages) => messages.flatMap((m) => m.parts).filter((p) => p.compactBoundary).length);
  assert.equal(await boundaries(), 1);
  await runtime.executeTurn("正常第二轮" + "b".repeat(210_000));
  assert.equal(await boundaries(), 1);
  runtime.beginShutdown();
  const restored = f.makeRuntime();
  await restored.resumeFromStore();
  const history = JSON.stringify(restored.messageHistory.toRuntimeEntries());
  assert.doesNotMatch(history, /OLD_LARGE_HISTORY_SENTINEL/u);
  assert.ok(history.includes(current));
  restored.beginShutdown();
});

test("恢复压缩完整保留本轮SessionStart与UserPromptSubmit约束且不写入交接摘要", async (t) => {
  for (const long of [false, true]) {
    const f = await fixture(t, { long });
    const runtime = f.makeRuntime();
    await runtime.resumeFromStore();
    runtime.runSessionStartHooks = async () => ({
      additionalContexts: ["CURRENT_START_HOOK_SENTINEL"],
    });
    runtime.runUserPromptSubmitHooks = async () => ({
      additionalContexts: ["CURRENT_PROMPT_HOOK_SENTINEL" + "约束".repeat(2_000)],
    });
    await runtime.executeTurn("本次用户输入");
    const request = JSON.stringify(f.requests[0].messages);
    assert.match(request, /CURRENT_START_HOOK_SENTINEL/u);
    assert.ok(request.includes("CURRENT_PROMPT_HOOK_SENTINEL" + "约束".repeat(2_000)));
    if (long) {
      assert.doesNotMatch(request, /OLD_LARGE_HISTORY_SENTINEL/u);
      const messages = await f.store.messages({ sessionID: f.sessionId });
      const summaries = messages.filter((message) => message.info.summary);
      assert.equal(summaries.length, 1);
      assert.doesNotMatch(JSON.stringify(summaries), /CURRENT_(?:START|PROMPT)_HOOK_SENTINEL/u);
    }
    runtime.beginShutdown();
  }
});

test("短恢复保持原历史，保存失败阻止主请求并允许重试", async (t) => {
  const short = await fixture(t, { long: false });
  const shortRuntime = short.makeRuntime();
  await shortRuntime.resumeFromStore();
  await shortRuntime.executeTurn("继续");
  assert.match(JSON.stringify(short.requests[0].messages), /OLD_LARGE_HISTORY_SENTINEL/u);
  shortRuntime.beginShutdown();
  const failed = await fixture(t, { failSave: true });
  const runtime = failed.makeRuntime();
  await runtime.resumeFromStore();
  await assert.rejects(runtime.executeTurn("失败后继续"), (error) => {
    assert.match(error.cause?.message ?? "", /mock compact persistence failed/u);
    return true;
  });
  assert.equal(failed.requests.length, 0);
  assert.equal(runtime.resumeInputBudgetPending, true);
  assert.match(
    JSON.stringify(runtime.messageHistory.toRuntimeEntries()),
    /OLD_LARGE_HISTORY_SENTINEL/u,
  );
  failed.restoreSave();
  await runtime.executeTurn("重试继续");
  assert.equal(failed.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(failed.requests[0].messages), /OLD_LARGE_HISTORY_SENTINEL/u);
  runtime.beginShutdown();
});
