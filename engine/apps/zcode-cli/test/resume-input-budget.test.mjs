import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageHistoryImpl } from "../packages/core/src/agent/message-history.ts";
import {
  compactResumedHistoryIfNeeded,
  DEFAULT_RESUME_INPUT_TOKEN_THRESHOLD,
  estimateResumedRequestInputTokens,
  resolveResumeInputTokenThreshold,
} from "../packages/core/src/runtime/methods/resume-input-budget.ts";

const model = {
  providerId: "mock",
  modelId: "resume",
  properties: { contextWindow: 512_000, supportsMidConversationSystem: true },
  optionSpecs: { maxOutputTokens: { max: 32_000 } },
};
const traceContext = { traceId: "trace-resume", turnId: "turn-resume" };
const user = (content) => ({
  message: { role: "user", content },
  metadata: { source: "real_user" },
});
const assistant = (content) => ({ message: { role: "assistant", content } });

function fixture({ length = 100, config = {}, pending = true, tools = [] } = {}) {
  const history = new MessageHistoryImpl();
  history.init([{ message: { role: "system", content: "项目规则" } }]);
  history.addEntries([
    user("旧目标"),
    assistant("OLD_HISTORY_SENTINEL" + "a".repeat(length)),
    user("恢复前最新要求"),
    assistant("最近进展"),
  ]);
  let calls = 0;
  let inputEntries;
  const runtime = {
    config,
    resumeInputBudgetPending: pending,
    messageHistory: history,
    initializeMcp: async () => {},
    getTools: () => tools,
    getMode: () => "build",
    getPlanEnabled: () => false,
    compactActiveConversation: async (_instructions, _trace, _events, options) => {
      calls++;
      inputEntries = options.activeEntries ?? history.toRuntimeEntries();
      assert.equal(
        options.autoCompactThreshold,
        resolveResumeInputTokenThreshold(config.compact, model),
      );
      history.replaceMessages([
        history.toRuntimeEntries()[0],
        { message: { role: "user", content: "交接" }, metadata: { source: "legacy_synthetic" } },
      ]);
      return { outcome: "compacted" };
    },
  };
  const invoke = (overrides = {}) =>
    compactResumedHistoryIfNeeded(runtime, {
      pendingEntries: [user("本次输入")],
      model,
      traceContext,
      events: [],
      ...overrides,
    });
  return {
    runtime,
    invoke,
    get calls() {
      return calls;
    },
    get inputEntries() {
      return inputEntries;
    },
  };
}

test("恢复预算默认51200，支持覆盖/关闭并受小窗口安全阈值约束", () => {
  assert.equal(DEFAULT_RESUME_INPUT_TOKEN_THRESHOLD, 51_200);
  assert.equal(resolveResumeInputTokenThreshold(undefined, model), 51_200);
  assert.equal(
    resolveResumeInputTokenThreshold({ resumeInputTokenThreshold: 12_000 }, model),
    12_000,
  );
  assert.equal(resolveResumeInputTokenThreshold({ resumeInputTokenThreshold: 0 }, model), 0);
  assert.equal(resolveResumeInputTokenThreshold({ enabled: false }, model), 0);
  for (const value of [-1, NaN, Infinity, 0.5]) {
    assert.equal(
      resolveResumeInputTokenThreshold({ resumeInputTokenThreshold: value }, model),
      51_200,
    );
  }
  assert.equal(
    resolveResumeInputTokenThreshold(undefined, {
      ...model,
      properties: { contextWindow: 64_000 },
    }),
    30_000,
  );
});

test("仅恢复首请求检查，短历史/新会话/关闭配置不压缩", async () => {
  for (const options of [
    {},
    { pending: false, length: 250_000 },
    { length: 250_000, config: { compact: { resumeInputTokenThreshold: 0 } } },
    { length: 250_000, config: { compact: { enabled: false } } },
  ]) {
    const f = fixture(options);
    await f.invoke();
    assert.equal(f.calls, 0);
    assert.equal(f.runtime.resumeInputBudgetPending, false);
  }
  const f = fixture({ length: 250_000 });
  await f.invoke();
  assert.equal(f.calls, 1);
  f.runtime.messageHistory.addEntries([assistant("a".repeat(300_000))]);
  await f.invoke();
  assert.equal(f.calls, 1);
});

test("预计请求达到阈值即触发，本次长输入只计预算不交给摘要截断", async () => {
  const f = fixture();
  const current = user("CURRENT_INPUT_SENTINEL" + "b".repeat(250_000));
  const entries = [...f.runtime.messageHistory.toRuntimeEntries(), current];
  const tokens = estimateResumedRequestInputTokens(f.runtime, entries, model, []);
  f.runtime.config.compact = { resumeInputTokenThreshold: tokens + 1 };
  await f.invoke({ pendingEntries: [current] });
  assert.equal(f.calls, 0);
  f.runtime.resumeInputBudgetPending = true;
  f.runtime.config.compact.resumeInputTokenThreshold = tokens;
  await f.invoke({ pendingEntries: [current] });
  assert.equal(f.calls, 1);
  assert.doesNotMatch(JSON.stringify(f.inputEntries), /CURRENT_INPUT_SENTINEL/u);
  assert.equal(current.message.content.length, 250_022);
});

test("工具定义计入请求估算，未知旧schema基线时保守加算当前工具", async () => {
  const tool = {
    name: "LargeSchema",
    description: "a".repeat(210_000),
    inputSchema: { type: "object" },
  };
  const f = fixture({ tools: [tool] });
  await f.invoke();
  assert.equal(f.calls, 1);
  const entries = [
    user("旧目标"),
    {
      ...assistant("回答"),
      tokens: { input: 80_000, output: 1, cache: { read: 0, write: 0 } },
    },
  ];
  const withTools = estimateResumedRequestInputTokens(f.runtime, entries, model, [tool]);
  const withoutTools = estimateResumedRequestInputTokens(f.runtime, entries, model, []);
  assert.ok(withoutTools >= 80_000 && withoutTools < 100_000);
  assert.ok(withTools > withoutTools + 50_000);
});

test("旧usage接近51200时新增4K工具定义会触发恢复压缩", async () => {
  const tool = {
    name: "NewTool",
    description: "a".repeat(16_000),
    inputSchema: { type: "object" },
  };
  const f = fixture({ tools: [tool] });
  f.runtime.messageHistory.addEntries([
    { ...assistant("回答"), tokens: { input: 50_000, output: 1, cache: { read: 0, write: 0 } } },
  ]);
  const entries = f.runtime.messageHistory.toRuntimeEntries();
  assert.ok(estimateResumedRequestInputTokens(f.runtime, entries, model, []) < 51_200);
  assert.ok(estimateResumedRequestInputTokens(f.runtime, entries, model, [tool]) > 54_000);
  await f.invoke();
  assert.equal(f.calls, 1);
});

test("冻结旧历史后完整回接本轮附件，压缩跳过或失败不重复追加", async () => {
  for (const outcome of ["compacted", "skipped", "failed"]) {
    const f = fixture({ length: 250_000 });
    const historicalEntries = [...f.runtime.messageHistory.borrowReadOnlyRuntimeEntries()];
    const current = {
      kind: "attachment",
      source: "hook_context",
      content: "CURRENT_HOOK_SENTINEL",
      metadata: { source: "hook_context" },
    };
    f.runtime.messageHistory.addEntries([current]);
    const originalCompact = f.runtime.compactActiveConversation;
    f.runtime.compactActiveConversation = async (...args) => {
      if (outcome === "failed") throw new Error("save failure");
      if (outcome === "skipped") return { outcome };
      return originalCompact(...args);
    };
    if (outcome === "failed")
      await assert.rejects(f.invoke({ historicalEntries }), /save failure/u);
    else await f.invoke({ historicalEntries });
    const entries = f.runtime.messageHistory.toRuntimeEntries();
    assert.equal(entries.filter((entry) => entry.content === "CURRENT_HOOK_SENTINEL").length, 1);
    if (outcome === "compacted")
      assert.doesNotMatch(JSON.stringify(f.inputEntries), /CURRENT_HOOK_SENTINEL/u);
  }
});

test("保存失败/取消保留待检查状态与原历史，重试重新检查", async () => {
  const f = fixture({ length: 250_000 });
  const original = f.runtime.messageHistory.toRuntimeEntries();
  const compact = f.runtime.compactActiveConversation;
  f.runtime.compactActiveConversation = async () => {
    throw new Error("persist failed");
  };
  await assert.rejects(f.invoke(), /persist failed/u);
  assert.equal(f.runtime.resumeInputBudgetPending, true);
  assert.deepEqual(f.runtime.messageHistory.toRuntimeEntries(), original);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.invoke({ abortSignal: controller.signal }));
  assert.equal(f.runtime.resumeInputBudgetPending, true);
  f.runtime.compactActiveConversation = compact;
  await f.invoke();
  assert.equal(f.calls, 1);
  assert.equal(f.runtime.resumeInputBudgetPending, false);
});

test("已有短交接或不足两轮的历史不重复压缩", async () => {
  const f = fixture();
  f.runtime.messageHistory.replaceMessages([
    { message: { role: "system", content: "项目规则" } },
    { message: { role: "user", content: "交接" }, metadata: { source: "legacy_synthetic" } },
  ]);
  await f.invoke({ pendingEntries: [user("a".repeat(250_000))] });
  assert.equal(f.calls, 0);
});
