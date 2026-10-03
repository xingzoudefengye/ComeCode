import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText } from "ai";
import { AiSdkModelExecution } from "../packages/adapters/src/model/model-execution.ts";
import { createGenerateTextOptions } from "../packages/adapters/src/model/runner-options.ts";
import {
  createModelRequestAttributionHeaders,
  normalizeModelSessionIdForAttribution,
} from "../packages/adapters/src/model/runner-attribution.ts";

function attributionHeaders(overrides = {}) {
  return createModelRequestAttributionHeaders({
    traceId: "trace-test",
    requestId: "req-test",
    sessionId: "sess_session-abc",
    modelRequestSessionType: "main",
    ...overrides,
  });
}

test("模型请求头：随 x-session-id 一并发送 Codex CLI 约定的 session-id/thread-id", () => {
  const headers = attributionHeaders();
  assert.equal(headers["x-session-id"], "session-abc");
  assert.equal(headers["session-id"], "session-abc");
  assert.equal(headers["thread-id"], "session-abc");
});

test("模型请求头：会话头使用归一化值，不带内部前缀", () => {
  const headers = attributionHeaders({ sessionId: "subagent_agent_child-1" });
  assert.equal(headers["session-id"], normalizeModelSessionIdForAttribution("subagent_agent_child-1"));
  assert.equal(headers["session-id"], "child-1");
  assert.equal(headers["thread-id"], "child-1");
});

test("模型请求头：无会话时不发送任何会话头", () => {
  const headers = attributionHeaders({ sessionId: undefined });
  assert.equal(headers["x-session-id"], undefined);
  assert.equal(headers["session-id"], undefined);
  assert.equal(headers["thread-id"], undefined);
});

// 在最终传输边界捕获真实发出的头，验证归因头确实进入 HTTP 请求，而非仅存在于辅助函数返回值。
test("openai-responses 真实请求带 Codex 约定的 session-id/thread-id 头", async () => {
  let capturedHeaders;
  const execution = new AiSdkModelExecution({ env: {} }, {
    transport: async (_url, init) => {
      capturedHeaders = new Headers(init.headers ?? {});
      // 请求已到最终传输边界；拒绝响应，不模拟成功用量。
      return new Response(JSON.stringify({ error: { message: "local request capture", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { resolved: base } = execution.bindModel({
    providerId: "fixture",
    modelId: "fixture-model",
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
    providerConfig: {
      api: { type: "openai-responses", baseUrl: "https://cache.example/v1" },
      access: { type: "api-key", apiKey: "fixture-not-a-real-key" },
    },
  });
  const resolved = { ...base, properties: {} };
  await assert.rejects(generateText(createGenerateTextOptions({
    includeModelIO: false,
    request: { messages: [{ role: "user", content: "hello" }], tools: [] },
    resolved,
    statusContext: {
      traceId: "trace-test",
      requestId: "req-test",
      sessionId: "sess_session-abc",
      modelRequestSessionType: "main",
    },
  })));
  assert.ok(capturedHeaders, "请求应到达传输边界");
  assert.equal(capturedHeaders.get("x-session-id"), "session-abc");
  assert.equal(capturedHeaders.get("session-id"), "session-abc");
  assert.equal(capturedHeaders.get("thread-id"), "session-abc");
});
