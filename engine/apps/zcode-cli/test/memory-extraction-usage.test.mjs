import assert from "node:assert/strict";
import { test } from "node:test";
import { SqliteSessionStore } from "../packages/adapters/src/storage/session-store/sqlite-session-store.ts";
import { getCurrentModelInvocationContext } from "../packages/core/src/runtime/deps.ts";
import { createProjectMemoryUsageModel } from "../packages/core/src/runtime/helpers/project-memory-usage.ts";
import { runMemoryAgentLoop } from "../packages/core/src/memory/memory-agent-loop.ts";

function fixture(generate, { noStore = false, writeFails = false } = {}) {
  const facts = [];
  const warnings = [];
  const contexts = [];
  const runtime = {
    sessionId: "sess-memory-usage",
    config: { mode: "auto", taskType: "interactive" },
    logger: { warn: (...args) => warnings.push(args) },
    createEvent: (type, payload, trace) => ({ type, payload, timestamp: new Date(), ...trace }),
    appendEvent: () => assert.fail("后台不能追加主对话事件"),
    sessionStore: noStore
      ? undefined
      : {
          recordModelUsage: async (fact) => {
            if (writeFails) throw new Error("mock storage failure");
            facts.push(fact);
          },
          upsertTurnUsage() {},
          upsertToolUsage() {},
          pruneUsage() {},
        },
  };
  function model(options = { reasoningLevel: "high" }) {
    return {
      providerId: "mock-provider",
      modelId: "mock-model",
      options,
      properties: {},
      optionSpecs: { reasoningLevel: { values: ["low", "high"] }, maxOutputTokens: { max: 9000 } },
      bind: (patch) => model({ ...options, ...patch }),
      generateText: async (request) => {
        contexts.push(getCurrentModelInvocationContext());
        return generate(request, contexts.at(-1));
      },
      streamText() {
        assert.fail("提取不使用流式请求");
      },
    };
  }
  const tracedModel = createProjectMemoryUsageModel(runtime, model(), {
    operation: "project_memory_extract",
    traceContext: { traceId: "trace-memory", turnId: "turn-memory", spanId: "span-parent" },
  });
  return { facts, warnings, contexts, model: tracedModel, runtime };
}

const usage = {
  inputTokens: 120,
  outputTokens: 12,
  reasoningTokens: 3,
  cacheReadTokens: 80,
  cacheWriteTokens: 20,
  totalTokens: 132,
};
const response = { text: "Nothing to save.", finishReason: "stop", usage };

test("后台提取逐调用记录有效档位、缓存用量、独立 span 和内部重试", async () => {
  const f = fixture(async (_request, context) => {
    await context.statusSink.publish({ type: "model_retry_scheduled", attempt: 1 });
    return response;
  });
  await f.model.generateText({ messages: [], tools: [] });
  await f.model.bind({ reasoningLevel: "high" }).generateText({
    messages: [],
    tools: [],
    options: { reasoningLevel: "low", maxOutputTokens: 2000 },
  });
  assert.equal(f.facts.length, 2);
  assert.equal(new Set(f.facts.map((fact) => fact.id)).size, 2);
  for (const fact of f.facts) {
    assert.equal(fact.sessionID, "sess-memory-usage");
    assert.equal(fact.traceID, "trace-memory");
    assert.equal(fact.turnID, "turn-memory");
    assert.equal(fact.querySource, "project_memory_extract");
    assert.equal(fact.reasoningLevel, "low");
    assert.equal(fact.providerId, "mock-provider");
    assert.equal(fact.modelId, "mock-model");
    assert.equal(fact.inputTokens, 120);
    assert.equal(fact.outputTokens, 12);
    assert.equal(fact.reasoningTokens, 3);
    assert.equal(fact.cacheReadInputTokens, 80);
    assert.equal(fact.cacheCreationInputTokens, 20);
    assert.equal(fact.providerTotalTokens, 132);
    assert.equal(fact.retryCount, 1);
    assert.equal(fact.status, "completed");
    assert.ok(fact.durationMs >= 0);
  }
  for (const context of f.contexts) {
    assert.equal(context.metadata.skipTranscript, true);
    assert.equal(context.modelCall.reasoning.requestedLevel, "low");
    assert.equal(context.traceContext.parentSpanId, "span-parent");
  }
});

test("缺失 provider usage 保持未知，不写字符估算 token", async () => {
  const f = fixture(async () => ({ text: "Nothing to save.", finishReason: "stop" }));
  await f.model.generateText({ messages: [] });
  assert.equal(f.facts.length, 1);
  assert.equal(f.facts[0].inputTokens, undefined);
  assert.equal(f.facts[0].outputTokens, undefined);
  assert.equal(f.facts[0].cacheReadInputTokens, undefined);
  assert.equal(f.facts[0].rawUsage, undefined);
});

test("失败与取消各记录一次，无响应的供应商用量不伪造", async () => {
  const failed = fixture(async () => {
    throw new Error("mock provider failure");
  });
  await assert.rejects(failed.model.generateText({ messages: [] }), /mock provider failure/u);
  assert.equal(failed.facts.length, 1);
  assert.equal(failed.facts[0].status, "error");
  assert.equal(failed.facts[0].inputTokens, undefined);

  const controller = new AbortController();
  let finish;
  const cancelled = fixture(async () => {
    controller.abort(new DOMException("cancel memory", "AbortError"));
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await assert.rejects(
    cancelled.model.generateText({ messages: [], abortSignal: controller.signal }),
    /cancel memory/u,
  );
  assert.equal(cancelled.facts.length, 1);
  assert.equal(cancelled.facts[0].status, "cancelled");
  finish(response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.facts.length, 1);
});

test("预算检查失败前保留已消耗的模型用量", async () => {
  const f = fixture(async () => ({ ...response, usage: { ...usage, outputTokens: 2001 } }));
  await assert.rejects(
    runMemoryAgentLoop({
      model: f.model,
      rootDir: ".ai",
      workingDirectory: ".",
      workspaceRoot: ".",
      messages: [],
      tools: [],
      maxTurns: 3,
      executeTool: () => assert.fail("不应执行工具"),
    }),
    /output budget exceeded/u,
  );
  assert.equal(f.facts.length, 1);
  assert.equal(f.facts[0].outputTokens, 2001);
  assert.equal(f.facts[0].status, "completed");
});

test("后台模型事实落入 SQLite，应用和会话汇总不遗漏或去重多轮输入", async (t) => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  t.after(() => store.close());
  await store.createSession({
    id: "sess-memory-usage",
    projectID: "project-memory-usage",
    slug: "memory-usage",
    directory: ".",
    title: "mock memory usage",
    version: "test",
  });
  const f = fixture(async () => response);
  f.runtime.sessionStore = store;
  await f.model.generateText({ messages: [] });
  await f.model.generateText({ messages: [] });
  const task = await store.queryTaskUsage({ sessionID: f.runtime.sessionId });
  assert.equal(task.modelRequestCount, 2);
  assert.equal(task.inputTokens, 240);
  assert.equal(task.outputTokens, 24);
  assert.equal(task.cacheReadTokens, 160);
  assert.equal(task.cacheCreationTokens, 40);
  assert.equal(task.totalTokens, 264);
  const app = await store.queryAppUsage({ since: 0, until: Date.now() + 1000, tzOffsetMs: 0 });
  assert.equal(app.totals.modelRequestCount, 2);
  assert.equal(app.totals.inputTokens, 240);
  assert.equal(f.warnings.length, 0);
});

test("用量存储失败或不可用不阻断提取，也不重发模型请求", async () => {
  for (const options of [{ noStore: true }, { writeFails: true }]) {
    let count = 0;
    const f = fixture(async () => {
      count++;
      return response;
    }, options);
    assert.equal(await f.model.generateText({ messages: [] }), response);
    assert.equal(count, 1);
    assert.equal(f.facts.length, 0);
    assert.equal(f.warnings.length, options.writeFails ? 1 : 0);
  }
});
