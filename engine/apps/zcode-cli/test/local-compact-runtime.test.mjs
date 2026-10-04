import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { MessageHistoryImpl } from "../packages/core/src/agent/message-history.ts";
import { hydrateMessageHistoryFromSession } from "../packages/core/src/agent/session-history-hydrator.ts";
import { compactActiveConversation } from "../packages/core/src/runtime/methods/compact-active.ts";
import { CompactTrigger, SessionEventType } from "../packages/contracts/src/index.ts";

const trace = { traceId: "trace-fixture", turnId: "turn-fixture" };
const entry = (role, content, extra = {}) => ({
  message: { role, content, ...extra },
  ...(role === "user" ? { metadata: { source: "real_user" } } : {}),
});

function fixture() {
  const history = new MessageHistoryImpl();
  history.init([{ message: { role: "system", content: "固定项目规则" } }]);
  const persisted = [];
  const runtime = {
    config: {},
    sessionId: "sess-local-fixture",
    messageHistory: history,
    readFileState: new Map([["big", { content: "源码".repeat(100_000) }]]),
    agentTelemetry: {
      compaction: () => ({
        run: (fn) => fn(),
        setInputTokens() {},
        setOutputTokens() {},
        finishCompleted() {},
        finishCancelled() {},
        finishFailed() {},
      }),
    },
    createEvent: (type, payload) => ({ type, payload, timestamp: new Date(), ...trace }),
    appendEvent: async () => {},
    persistCompactTimeline: async () => {},
    buildCompactTimelinePayload: (timeline, patch) => ({ ...timeline, ...patch }),
    persistCompactSummary: async (id, content, summary, boundary) => {
      persisted.push({
        info: {
          id,
          sessionID: runtime.sessionId,
          role: "user",
          summary: { body: summary },
          time: { created: Date.now() },
        },
        parts: [
          { id: `${id}-text`, type: "text", text: content, synthetic: true },
          { id: `${id}-boundary`, type: "compaction", compactBoundary: boundary },
        ],
      });
    },
    finishCompactTimelineFailure: async () => {},
    initializeMcp: () => {
      throw new Error("不应初始化 MCP");
    },
    getTools: () => {
      throw new Error("不应构造工具 schema");
    },
  };
  const model = {
    providerId: "fixture",
    modelId: "local",
    properties: { contextWindow: 128_000 },
    generateText: () => {
      throw new Error("不能调用摘要模型");
    },
    streamText: () => {
      throw new Error("不能调用摘要模型");
    },
  };
  return { runtime, history, persisted, model };
}

test("自动/手动/超窗压缩无辅助模型调用，无原始大尾部，冷恢复一致", async () => {
  for (const trigger of [CompactTrigger.Auto, CompactTrigger.Manual, CompactTrigger.Reactive]) {
    const f = fixture();
    f.history.addEntries([
      entry("user", "旧目标"),
      entry("assistant", "旧工作"),
      entry("user", "最新要求：继续实现史书，未完成不要说完成"),
      entry("assistant", "已经改代码，还没跑测试", {
        toolCalls: [{ id: "call", name: "Bash", input: { command: "node --test" } }],
      }),
      entry("tool", "测试失败\n" + "大工具日志".repeat(100_000), {
        toolCallId: "call",
        toolName: "Bash",
        isError: true,
      }),
    ]);
    const events = [];
    const result = await compactActiveConversation.call(f.runtime, undefined, trace, events, {
      trigger,
      model: f.model,
    });
    assert.equal(result.outcome, "compacted");
    const text = result.entries.map((e) => e.message?.content ?? e.content).join("\n");
    assert.match(text, /最新要求：继续实现史书/u);
    assert.match(text, /测试失败/u);
    assert.ok(text.length < 7_000);
    assert.equal(result.entries.length, 2);
    assert.equal(
      events.some(
        (event) =>
          event.type === SessionEventType.ModelRequest ||
          event.type === SessionEventType.ModelComplete,
      ),
      false,
    );
    assert.equal(f.persisted[0].parts[1].compactBoundary.preservedSegment, undefined);
    const restored = new MessageHistoryImpl();
    restored.init([{ message: { role: "system", content: "固定项目规则" } }]);
    await hydrateMessageHistoryFromSession({ messages: f.persisted, history: restored });
    assert.deepEqual(
      restored.borrowReadOnlyRuntimeEntries().map((e) => e.message?.content),
      f.history.borrowReadOnlyRuntimeEntries().map((e) => e.message?.content),
    );
  }
});

test("连续50次压缩容量固定，最新要求始终保留，不嵌套旧交接", async () => {
  const f = fixture();
  const started = performance.now();
  for (let i = 0; i < 50; i++) {
    f.history.addEntries([
      entry("user", `当前目标-${i}`),
      entry("assistant", `当前进展-${i}`),
      entry("user", `补充要求-${i}`),
      entry("assistant", "检查尚未完成"),
    ]);
    const result = await compactActiveConversation.call(f.runtime, undefined, trace, [], {
      trigger: CompactTrigger.Auto,
      model: f.model,
    });
    const text = result.entries.map((e) => e.message?.content ?? "").join("\n");
    assert.match(text, new RegExp(`补充要求-${i}`));
    assert.ok(text.length < 7_000);
    assert.equal((text.match(/This session is being continued/gu) ?? []).length, 1);
  }
  assert.ok(performance.now() - started < 5_000);
});

test("手动压缩预算尊重显式小窗口配置", async () => {
  const f = fixture();
  f.runtime.config.compact = { contextWindow: 3_000 };
  f.history.addEntries([
    entry("user", "保留当前任务" + "目标".repeat(3_000)),
    entry("assistant", "进展".repeat(3_000)),
    entry("assistant", "补充进展"),
  ]);
  const result = await compactActiveConversation.call(f.runtime, undefined, trace, [], {
    model: f.model,
  });
  const text = result.entries.map((e) => e.message?.content ?? "").join("\n");
  assert.match(text, /保留当前任务/u);
  assert.ok(text.length < 1_200);
});

test("取消和保存失败不替换活动历史，不删除已有工具结果", async () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    f.history.addEntries([
      entry("user", "当前任务"),
      entry("assistant", "操作一"),
      entry("assistant", "操作二"),
    ]);
    const original = f.history.toRuntimeEntries();
    const controller = new AbortController();
    if (cancel) controller.abort();
    else
      f.runtime.persistCompactSummary = async () => {
        throw new Error("模拟保存失败");
      };
    await assert.rejects(
      compactActiveConversation.call(f.runtime, undefined, trace, [], {
        model: f.model,
        abortSignal: controller.signal,
      }),
    );
    assert.deepEqual(f.history.toRuntimeEntries(), original);
  }
});
